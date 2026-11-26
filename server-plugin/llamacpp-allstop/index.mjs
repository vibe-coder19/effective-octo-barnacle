/**
 * llama.cpp All Stop — SillyTavern server plugin (companion to the "llama.cpp All Stop" UI extension).
 *
 * Why this exists
 * ---------------
 * llama.cpp's server has no "cancel this generation" endpoint. A running task is cancelled only
 * when the HTTP connection that requested it is closed. SillyTavern closes that connection when
 * the browser's request socket closes (that is what the Stop button does). If that close never
 * reaches the SillyTavern server (reverse proxy / tunnel in front of SillyTavern, flaky or
 * high-latency network, races), SillyTavern keeps its connection to llama.cpp open and llama.cpp
 * keeps generating until it hits the token limit.
 *
 * What it does
 * ------------
 * It watches SillyTavern's outgoing generation requests through Node's built-in
 * `diagnostics_channel` (nothing in SillyTavern is patched) and can destroy them on demand.
 * Destroying the socket is exactly what SillyTavern's own Stop would have done, and llama.cpp
 * cancels the task within milliseconds of seeing it.
 *
 * Routes (mounted by SillyTavern under /api/plugins/llamacpp-allstop, behind its auth + CSRF):
 *   GET|POST /status  -> open generation requests SillyTavern is holding right now
 *   POST     /stop    -> { server_url | all:true, grace_ms } force-close matching requests that are
 *                        still open after the grace period (0 = immediately)
 *   POST     /slots   -> { server_url, auth, model } GET <llama.cpp>/slots with the stored API key
 *   POST     /unload  -> { server_url, auth, model } router mode only: POST <llama.cpp>/models/unload
 */

import dc from 'node:diagnostics_channel';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = '1.0.0';
const LOG_PREFIX = '[llamacpp-allstop]';
const MAX_GRACE_MS = 30_000;
const MAX_TRACKED = 1_000;
const SWEEP_INTERVAL_MS = 60_000;

// Outgoing request start channels. `http.client.request.created` (Node 22.14+/23.2+) fires first;
// `http.client.request.start` exists on every Node version SillyTavern supports. Both are
// subscribed and de-duplicated, so whichever fires is enough.
const CLIENT_CHANNELS = ['http.client.request.created', 'http.client.request.start'];

// Endpoints that start a generation: llama.cpp native (/completion, /completions, /infill),
// OpenAI-compatible (/v1/completions, /v1/chat/completions, /v1/responses), Anthropic-compatible
// (/v1/messages), plus the generate endpoints of other local backends for the "all" scope.
const GENERATION_PATH = /\/(?:completions?|chat\/completions|infill|messages|responses|generate|generate_stream|api\/chat)$/i;

export const info = {
    id: 'llamacpp-allstop',
    name: 'llama.cpp All Stop',
    description: 'Tracks SillyTavern\'s outgoing generation requests and force-closes them on demand, so llama.cpp cancels the task.',
};

/**
 * @typedef {object} TrackedRequest
 * @property {number} id
 * @property {import('node:http').ClientRequest} request
 * @property {string} method
 * @property {string} protocol
 * @property {string} hostname
 * @property {string} port
 * @property {string} path
 * @property {number} startedAt
 * @property {number} respondedAt
 * @property {number} status
 */

/** @type {Map<number, TrackedRequest>} */
const tracked = new Map();
/** @type {WeakSet<object>} */
const seen = new WeakSet();
let sequence = 0;
let sweepTimer = null;
let subscribed = false;

function isGenerationPath(requestPath) {
    if (typeof requestPath !== 'string') {
        return false;
    }
    const clean = requestPath.split('?')[0].replace(/\/+$/, '');
    return GENERATION_PATH.test(clean);
}

function defaultPort(protocol) {
    return protocol === 'https:' ? '443' : '80';
}

/** Collapse the many spellings of "this machine" so localhost and 127.0.0.1 match each other. */
function hostKey(hostname) {
    let host = String(hostname ?? '').trim().toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) {
        host = host.slice(1, -1);
    }
    if (host === 'localhost' || host === '::1' || host === '::' || host === '0.0.0.0' || host === '::ffff:127.0.0.1' || /^127\./.test(host)) {
        return 'loopback';
    }
    return host;
}

/**
 * @param {unknown} serverUrl
 * @returns {{ host: string, port: string, pathPrefix: string, base: string } | null}
 */
function parseServerUrl(serverUrl) {
    if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
        return null;
    }
    let raw = serverUrl.trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
        raw = `http://${raw}`;
    }
    let url;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
    }
    const pathPrefix = url.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '');
    // Same trick SillyTavern uses for generation: "localhost" may resolve to ::1 while llama.cpp
    // only listens on 127.0.0.1.
    const fetchHost = url.hostname.toLowerCase() === 'localhost' ? `127.0.0.1${url.port ? `:${url.port}` : ''}` : url.host;
    return {
        host: hostKey(url.hostname),
        port: url.port || defaultPort(url.protocol),
        pathPrefix,
        base: `${url.protocol}//${fetchHost}${pathPrefix}`,
    };
}

/** @param {import('node:http').ClientRequest} request */
function describeRequest(request) {
    const protocol = request.protocol || 'http:';
    const hostHeader = String(request.getHeader?.('host') ?? '');
    const match = hostHeader.match(/^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/);
    return {
        method: request.method || 'GET',
        protocol,
        hostname: request.host || (match ? match[1] : ''),
        port: (match && match[2]) || defaultPort(protocol),
        path: request.path || '/',
    };
}

/** @param {TrackedRequest} entry */
function isLive(entry) {
    return tracked.has(entry.id) && !entry.request.destroyed;
}

/**
 * @param {TrackedRequest} entry
 * @param {ReturnType<typeof parseServerUrl>} target null = match everything
 */
function matchesServer(entry, target) {
    if (!target) {
        return true;
    }
    if (hostKey(entry.hostname) !== target.host || entry.port !== target.port) {
        return false;
    }
    if (target.pathPrefix && !entry.path.startsWith(`${target.pathPrefix}/`)) {
        return false;
    }
    return true;
}

/** @param {TrackedRequest} entry */
function publicView(entry, now = Date.now()) {
    return {
        id: entry.id,
        method: entry.method,
        url: `${entry.protocol}//${entry.hostname}:${entry.port}${entry.path}`,
        age_ms: now - entry.startedAt,
        phase: entry.respondedAt ? 'streaming' : 'waiting',
        status: entry.status || null,
    };
}

function onClientRequest(message) {
    // Never let an exception escape a diagnostics channel subscriber: it would surface inside
    // whatever code made the request.
    try {
        const request = message?.request;
        if (!request || typeof request.destroy !== 'function' || seen.has(request)) {
            return;
        }
        if (!isGenerationPath(request.path)) {
            return;
        }
        seen.add(request);

        /** @type {TrackedRequest} */
        const entry = {
            id: ++sequence,
            request,
            ...describeRequest(request),
            startedAt: Date.now(),
            respondedAt: 0,
            status: 0,
        };
        tracked.set(entry.id, entry);

        request.once('response', (response) => {
            entry.respondedAt = Date.now();
            entry.status = response?.statusCode ?? 0;
        });
        request.once('close', () => tracked.delete(entry.id));

        if (tracked.size > MAX_TRACKED) {
            sweep();
        }
    } catch (error) {
        console.warn(LOG_PREFIX, 'Failed to track an outgoing request:', error);
    }
}

function sweep() {
    for (const [id, entry] of tracked) {
        if (entry.request.destroyed) {
            tracked.delete(id);
        }
    }
    // Hard cap in case 'close' never fired for some exotic request implementation.
    while (tracked.size > MAX_TRACKED) {
        const oldest = tracked.keys().next().value;
        tracked.delete(oldest);
    }
}

/** @param {TrackedRequest} entry */
function killEntry(entry, reason) {
    const error = new Error(reason);
    // @ts-ignore - custom code so the failure is recognizable in SillyTavern's logs
    error.code = 'LLAMACPP_ALLSTOP';
    try {
        // Destroys the socket: llama.cpp sees the disconnect and cancels the task.
        entry.request.destroy(error);
    } catch (err) {
        console.warn(LOG_PREFIX, 'Error while destroying request', entry.id, err);
    }
    tracked.delete(entry.id);
}

function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, number));
}

async function waitUntil(predicate, timeoutMs, stepMs = 50) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, stepMs));
    }
}

// ---------------------------------------------------------------------------------------------
// API keys: reuse the key saved in SillyTavern's API connection panel, so /slots works when
// llama.cpp runs with --api-key. The user's secrets.json is read directly (read-only) instead of
// importing SillyTavern's modules, which have start-up side effects when loaded a second time.
// ---------------------------------------------------------------------------------------------

const SECRET_KEY_BY_AUTH = {
    llamacpp: 'api_key_llamacpp', // Text Completion > llama.cpp
    custom: 'api_key_custom', // Chat Completion > Custom (OpenAI-compatible)
};

/**
 * @param {import('express').Request} request
 * @param {unknown} auth 'llamacpp', 'custom' or 'none'
 */
function authHeaders(request, auth) {
    const secretKey = SECRET_KEY_BY_AUTH[typeof auth === 'string' ? auth : 'llamacpp'];
    // @ts-ignore - set by SillyTavern's user middleware
    const root = request.user?.directories?.root;
    if (!secretKey || !root) {
        return {};
    }
    try {
        const file = path.join(root, 'secrets.json');
        if (!fs.existsSync(file)) {
            return {};
        }
        const secrets = JSON.parse(fs.readFileSync(file, 'utf8'));
        const stored = secrets?.[secretKey];
        // Current format: [{ id, value, label, active }]; pre-1.13 format: plain string.
        const value = Array.isArray(stored) ? stored.find(item => item?.active)?.value : stored;
        return typeof value === 'string' && value.trim() ? { Authorization: `Bearer ${value.trim()}` } : {};
    } catch (error) {
        console.warn(LOG_PREFIX, 'Could not read the stored API key:', error?.message ?? error);
        return {};
    }
}

async function readLimitedText(response, limit = 400) {
    try {
        return (await response.text()).slice(0, limit);
    } catch {
        return '';
    }
}

// ---------------------------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------------------------

function handleStatus(request, response) {
    const target = parseServerUrl(request.body?.server_url ?? request.query?.server_url);
    const now = Date.now();
    const requests = [...tracked.values()]
        .filter(isLive)
        .map(entry => ({ ...publicView(entry, now), matches_server: target ? matchesServer(entry, target) : null }));
    return response.json({
        ok: true,
        plugin: info.id,
        version: VERSION,
        node: process.version,
        tracking: subscribed,
        requests,
    });
}

async function handleStop(request, response) {
    try {
        const body = request.body ?? {};
        const all = body.all === true;
        const target = all ? null : parseServerUrl(body.server_url);
        if (!all && !target) {
            return response.status(400).json({ ok: false, error: 'server_url is required (or pass all: true)' });
        }
        const graceMs = clampNumber(body.grace_ms, 0, MAX_GRACE_MS, 0);

        // Only requests that are open *now* are candidates. A generation started during the grace
        // period (e.g. the user immediately regenerates) is never touched.
        const snapshot = [...tracked.values()].filter(entry => isLive(entry) && matchesServer(entry, target));
        if (graceMs > 0 && snapshot.length > 0) {
            await waitUntil(() => snapshot.every(entry => !isLive(entry)), graceMs);
        }

        const killed = [];
        let closedOnTheirOwn = 0;
        const now = Date.now();
        for (const entry of snapshot) {
            if (!isLive(entry)) {
                closedOnTheirOwn++;
                continue;
            }
            killed.push(publicView(entry, now));
            killEntry(entry, 'Force-closed by llama.cpp All Stop');
        }

        if (killed.length > 0) {
            console.warn(LOG_PREFIX, `Force-closed ${killed.length} generation request(s):`, killed.map(k => `${k.method} ${k.url} (${Math.round(k.age_ms / 1000)}s old)`).join(', '));
        }

        return response.json({
            ok: true,
            matched: snapshot.length,
            killed,
            closed_on_their_own: closedOnTheirOwn,
            grace_ms: graceMs,
        });
    } catch (error) {
        console.error(LOG_PREFIX, 'stop failed:', error);
        return response.status(500).json({ ok: false, error: String(error?.message ?? error) });
    }
}

async function handleSlots(request, response) {
    const body = request.body ?? {};
    const target = parseServerUrl(body.server_url);
    if (!target) {
        return response.status(400).json({ ok: false, error: 'server_url is required' });
    }
    const url = new URL(`${target.base}/slots`);
    if (typeof body.model === 'string' && body.model) {
        // Router mode needs the model name; autoload=false so a status check never loads a model.
        url.searchParams.set('model', body.model);
        url.searchParams.set('autoload', 'false');
    }
    const timeoutMs = clampNumber(body.timeout_ms, 500, 15_000, 4_000);
    try {
        const upstream = await fetch(url, {
            headers: { Accept: 'application/json', ...authHeaders(request, body.auth) },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!upstream.ok) {
            return response.json({ ok: false, status: upstream.status, error: await readLimitedText(upstream) });
        }
        const text = await upstream.text();
        try {
            return response.json({ ok: true, slots: JSON.parse(text) });
        } catch {
            return response.json({ ok: false, status: upstream.status, error: 'llama.cpp returned a non-JSON /slots response' });
        }
    } catch (error) {
        const reason = error?.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : String(error?.cause?.code ?? error?.message ?? error);
        return response.json({ ok: false, status: 0, error: reason });
    }
}

async function handleUnload(request, response) {
    const body = request.body ?? {};
    const target = parseServerUrl(body.server_url);
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!target || !model) {
        return response.status(400).json({ ok: false, error: 'server_url and model are required' });
    }
    try {
        const upstream = await fetch(`${target.base}/models/unload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders(request, body.auth) },
            body: JSON.stringify({ model }),
            signal: AbortSignal.timeout(10_000),
        });
        const text = await readLimitedText(upstream);
        if (!upstream.ok) {
            return response.json({ ok: false, status: upstream.status, error: text });
        }
        console.warn(LOG_PREFIX, `Asked llama.cpp router to unload model "${model}"`);
        return response.json({ ok: true, status: upstream.status, result: text });
    } catch (error) {
        return response.json({ ok: false, status: 0, error: String(error?.cause?.code ?? error?.message ?? error) });
    }
}

// ---------------------------------------------------------------------------------------------
// Plugin lifecycle
// ---------------------------------------------------------------------------------------------

function subscribe() {
    if (subscribed) {
        return;
    }
    for (const name of CLIENT_CHANNELS) {
        dc.subscribe(name, onClientRequest);
    }
    subscribed = true;
}

function unsubscribe() {
    if (!subscribed) {
        return;
    }
    for (const name of CLIENT_CHANNELS) {
        dc.unsubscribe(name, onClientRequest);
    }
    subscribed = false;
}

/**
 * @param {import('express').Router} router
 */
export async function init(router) {
    subscribe();
    sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();

    router.get('/status', handleStatus);
    router.post('/status', handleStatus);
    router.post('/stop', handleStop);
    router.post('/slots', handleSlots);
    router.post('/unload', handleUnload);

    console.log(LOG_PREFIX, `v${VERSION} loaded: tracking outgoing generation requests (Node ${process.version}).`);
}

export async function exit() {
    unsubscribe();
    if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
    }
    tracked.clear();
}

// Exposed for tests only.
export const __test = { parseServerUrl, matchesServer, isGenerationPath, hostKey, tracked };

export default { info, init, exit };
