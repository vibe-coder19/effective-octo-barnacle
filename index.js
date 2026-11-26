/*
 * llama.cpp All Stop — SillyTavern UI extension
 *
 * llama.cpp has no "cancel this generation" endpoint: a task is cancelled only when the HTTP
 * connection that started it closes. SillyTavern's Stop button closes the browser's request and
 * relies on that close travelling browser -> SillyTavern server -> llama.cpp. When it gets lost on
 * the way (reverse proxy / tunnel, latency, a request SillyTavern lost track of), llama.cpp keeps
 * generating until the token limit while SillyTavern looks idle.
 *
 * This extension makes sure a stop actually lands:
 *   1. calls SillyTavern's own stop,
 *   2. aborts every generation request this browser tab still has open,
 *   3. asks the companion server plugin to force-close the SillyTavern server's connections to
 *      llama.cpp (the only reliable way to make llama.cpp cancel),
 *   4. watches llama.cpp's /slots until the slot is idle, and reports what happened.
 * It runs automatically after you press Stop, on demand (button, wand menu, /allstop), and a
 * watchdog warns you when llama.cpp is generating while SillyTavern isn't.
 */

const MODULE = 'llamacpp_allstop';
const DISPLAY_NAME = 'llama.cpp All Stop';
const LOG = '[llama.cpp All Stop]';
const PLUGIN_ID = 'llamacpp-allstop';
const PLUGIN_BASE = `/api/plugins/${PLUGIN_ID}`;
const ST_SLOTS_PROXY = '/api/backends/text-completions/llamacpp/slots';
const GENERATION_URL = /\/api\/backends\/(?:text-completions|chat-completions|kobold)\/generate(?:[?#]|$)/;
const DIRECT_RETRY_MS = 5 * 60 * 1000;

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    showButton: true,
    autoOnStop: true,
    graceMs: 1000,
    abortOtherRequests: true,
    verifySeconds: 15,
    watchdog: true,
    watchdogIntervalSec: 5,
    watchdogBusySec: 8,
    watchdogAction: 'warn', // 'warn' | 'stop'
    killScope: 'server', // 'server' | 'all'
    serverUrlOverride: '',
    routerUnload: false,
    notify: true,
});

const state = {
    /** @type {boolean|null} null = not probed yet */
    plugin: null,
    /** @type {any} */
    pluginInfo: null,
    /** @type {Map<string, {ok: boolean, at: number, error?: string}>} base URL -> last direct /slots attempt */
    direct: new Map(),
    /** @type {SlotsResult|null} */
    lastSlots: null,
    indicator: 'unknown',
    indicatorDetail: '',
    /** @type {Promise<any>|null} */
    running: null,
    autoRunning: false,
    suppressAuto: 0,
    /** @type {ReturnType<typeof setInterval>|null} */
    watchdogTimer: null,
    ticking: false,
    /** @type {Map<string, {since: number, handled: boolean}>} slot:task -> first seen busy while idle */
    busySince: new Map(),
};

/**
 * @typedef {{slot: number, task: number|null, decoded: number|null}} BusySlot
 * @typedef {{ok: boolean, via: string, at: number, total?: number, busy?: BusySlot[], error?: string}} SlotsResult
 * @typedef {{url: string, auth: 'llamacpp'|'custom', model: string, label: string, active: boolean}} Target
 */

// ---------------------------------------------------------------------------------------------
// Browser-side request tracking
// ---------------------------------------------------------------------------------------------
// SillyTavern only keeps an abort handle for the generation it is currently showing. Requests it
// lost track of (double clicks under latency, background generations from other extensions)
// cannot be stopped from its UI. Generation POSTs are wrapped with an extra AbortSignal so All
// Stop can cancel all of them. Every other request goes straight through untouched.

const nativeFetch = window.fetch.bind(window);
/** @type {Map<number, {id: number, url: string, startedAt: number, controller: AbortController, callerSignal: AbortSignal|null}>} */
const inflight = new Map();
let inflightSequence = 0;

function combineSignals(signals) {
    const list = signals.filter(Boolean);
    if (list.length === 1) {
        return list[0];
    }
    if (typeof AbortSignal.any === 'function') {
        return AbortSignal.any(list);
    }
    const controller = new AbortController();
    for (const signal of list) {
        if (signal.aborted) {
            controller.abort(signal.reason);
            break;
        }
        signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    return controller.signal;
}

/** Marks the request finished once its body has been fully read (or failed), without touching the response SillyTavern gets. */
function watchResponseBody(response, finish) {
    try {
        if (!response?.body || response.bodyUsed) {
            finish();
            return;
        }
        const reader = response.clone().body.getReader();
        const pump = () => reader.read().then(({ done }) => (done ? finish() : pump()), finish);
        pump();
    } catch {
        finish();
    }
}

function installFetchTracker() {
    if (window.fetch?.__llamacppAllStop) {
        return;
    }
    const previousFetch = window.fetch;
    const tracked = function (input, init) {
        const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : null);
        if (!url || !GENERATION_URL.test(url) || (init?.signal && typeof init.signal.addEventListener !== 'function')) {
            return previousFetch.apply(window, arguments);
        }
        const entry = { id: ++inflightSequence, url, startedAt: Date.now(), controller: new AbortController(), callerSignal: init?.signal ?? null };
        inflight.set(entry.id, entry);
        const finish = () => inflight.delete(entry.id);
        let promise;
        try {
            promise = previousFetch.call(window, input, { ...(init || {}), signal: combineSignals([init?.signal, entry.controller.signal]) });
        } catch (error) {
            finish();
            throw error;
        }
        return promise.then(
            (response) => {
                watchResponseBody(response, finish);
                return response;
            },
            (error) => {
                finish();
                throw error;
            },
        );
    };
    tracked.__llamacppAllStop = true;
    window.fetch = tracked;
}

/**
 * Aborts tracked generation requests from this tab.
 * @param {number} [startedBefore] only abort requests started before this timestamp
 * @returns {number} how many requests were aborted
 */
function abortBrowserRequests(startedBefore = Infinity) {
    let count = 0;
    for (const entry of [...inflight.values()]) {
        if (entry.startedAt > startedBefore) {
            continue;
        }
        // Requests the caller already aborted (e.g. SillyTavern's own Stop) are not counted.
        if (!entry.controller.signal.aborted && !entry.callerSignal?.aborted) {
            entry.controller.abort(new DOMException('Stopped by llama.cpp All Stop', 'AbortError'));
            count++;
        }
        inflight.delete(entry.id);
    }
    return count;
}

installFetchTracker();

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function ctx() {
    return SillyTavern.getContext();
}

function settings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE] || typeof extensionSettings[MODULE] !== 'object') {
        extensionSettings[MODULE] = {};
    }
    const current = extensionSettings[MODULE];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (current[key] === undefined) {
            current[key] = value;
        }
    }
    return current;
}

function saveSettings() {
    ctx().saveSettingsDebounced();
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function timeoutSignal(ms) {
    if (typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(ms);
    }
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
    return controller.signal;
}

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]));
}

function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** llama.cpp base URL as the browser would call it (strips trailing slash and /v1). */
function baseUrl(url) {
    let value = String(url ?? '').trim().replace(/\/+$/, '');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
        value = `http://${value}`;
    }
    return value.replace(/\/v1$/i, '');
}

async function postJson(url, body, timeoutMs = 8000) {
    const response = await fetch(url, {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify(body ?? {}),
        signal: timeoutSignal(timeoutMs),
    });
    let data = null;
    try {
        data = await response.json();
    } catch {
        // not JSON
    }
    return { status: response.status, ok: response.ok, data };
}

/**
 * Which llama.cpp server SillyTavern is talking to.
 * @returns {Target|null}
 */
function getTarget() {
    const context = ctx();
    const tc = context.textCompletionSettings ?? {};
    const cc = context.chatCompletionSettings ?? {};
    const model = typeof tc.llamacpp_model === 'string' ? tc.llamacpp_model : '';
    const override = String(settings().serverUrlOverride ?? '').trim();
    if (override) {
        return { url: override, auth: 'llamacpp', model, label: 'manual URL from settings', active: true };
    }
    const savedLlama = String(tc.server_urls?.llamacpp ?? '').trim();
    if (context.mainApi === 'textgenerationwebui' && tc.type === 'llamacpp' && savedLlama) {
        return { url: savedLlama, auth: 'llamacpp', model, label: 'Text Completion › llama.cpp', active: true };
    }
    const customUrl = String(cc.custom_url ?? '').trim();
    if (context.mainApi === 'openai' && cc.chat_completion_source === 'custom' && customUrl) {
        return { url: customUrl, auth: 'custom', model: '', label: 'Chat Completion › Custom', active: true };
    }
    if (savedLlama) {
        return { url: savedLlama, auth: 'llamacpp', model, label: 'saved llama.cpp URL (another API is active)', active: false };
    }
    return null;
}

// ---------------------------------------------------------------------------------------------
// Talking to the server plugin and to llama.cpp
// ---------------------------------------------------------------------------------------------

async function probePlugin() {
    try {
        const result = await postJson(`${PLUGIN_BASE}/status`, {}, 5000);
        state.plugin = result.ok && result.data?.plugin === PLUGIN_ID;
        state.pluginInfo = state.plugin ? result.data : null;
    } catch {
        state.plugin = false;
        state.pluginInfo = null;
    }
    renderStatus();
    return state.plugin;
}

/** Open generation connections the SillyTavern server holds (plugin only). */
async function pluginConnections(target) {
    if (!state.plugin) {
        return null;
    }
    try {
        const result = await postJson(`${PLUGIN_BASE}/status`, target ? { server_url: target.url } : {}, 5000);
        if (!result.ok || !Array.isArray(result.data?.requests)) {
            return null;
        }
        return result.data.requests.filter(r => r.matches_server !== false);
    } catch {
        return null;
    }
}

async function pluginStop(target, graceMs, all) {
    if (!all && !target) {
        return { ok: false, error: 'no llama.cpp URL configured' };
    }
    try {
        const body = all ? { all: true, grace_ms: graceMs } : { server_url: target.url, grace_ms: graceMs };
        const result = await postJson(`${PLUGIN_BASE}/stop`, body, graceMs + 10000);
        if (result.status === 404) {
            state.plugin = false;
            renderStatus();
            return { ok: false, error: 'server plugin not installed' };
        }
        return result.data ?? { ok: false, error: `HTTP ${result.status}` };
    } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
    }
}

function summarizeSlots(raw) {
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.slots) ? raw.slots : []);
    /** @type {BusySlot[]} */
    const busy = [];
    for (const slot of list) {
        if (!slot || typeof slot !== 'object' || !slot.is_processing) {
            continue;
        }
        const next = Array.isArray(slot.next_token) ? slot.next_token[0] : slot.next_token;
        busy.push({
            slot: slot.id,
            task: slot.id_task ?? null,
            decoded: Number.isFinite(next?.n_decoded) ? next.n_decoded : null,
        });
    }
    return { total: list.length, busy };
}

/** @param {SlotsResult} result */
function recordSlots(result) {
    state.lastSlots = result;
    renderStatus();
    return result;
}

/**
 * Reads llama.cpp's /slots: through the server plugin (sends the stored API key, no log spam),
 * else directly from the browser, else through SillyTavern's own proxy.
 * @param {Target|null} target
 * @returns {Promise<SlotsResult>}
 */
async function fetchSlots(target, { allowStProxy = true, timeoutMs = 4000 } = {}) {
    const at = Date.now();
    if (!target) {
        return recordSlots({ ok: false, via: 'none', at, error: 'no llama.cpp URL configured' });
    }
    if (state.plugin) {
        try {
            const result = await postJson(`${PLUGIN_BASE}/slots`, {
                server_url: target.url,
                auth: target.auth,
                model: target.model || undefined,
                timeout_ms: timeoutMs,
            }, timeoutMs + 3000);
            if (result.data?.ok) {
                return recordSlots({ ok: true, via: 'plugin', at, ...summarizeSlots(result.data.slots) });
            }
            if (result.status !== 404) {
                const status = result.data?.status ? `HTTP ${result.data.status}: ` : '';
                return recordSlots({ ok: false, via: 'plugin', at, error: `${status}${result.data?.error ?? 'request failed'}` });
            }
            state.plugin = false;
        } catch (error) {
            return recordSlots({ ok: false, via: 'plugin', at, error: String(error?.message ?? error) });
        }
    }

    const base = baseUrl(target.url);
    const lastDirect = state.direct.get(base);
    if (!lastDirect || lastDirect.ok || Date.now() - lastDirect.at > DIRECT_RETRY_MS) {
        try {
            const url = new URL(`${base}/slots`);
            if (target.model) {
                url.searchParams.set('model', target.model);
                url.searchParams.set('autoload', 'false');
            }
            const response = await nativeFetch(url.href, { credentials: 'omit', signal: timeoutSignal(timeoutMs) });
            if (response.ok) {
                const data = await response.json();
                state.direct.set(base, { ok: true, at: Date.now() });
                return recordSlots({ ok: true, via: 'direct', at, ...summarizeSlots(data) });
            }
            state.direct.set(base, { ok: false, at: Date.now(), error: `HTTP ${response.status}` });
        } catch (error) {
            state.direct.set(base, { ok: false, at: Date.now(), error: String(error?.message ?? error) });
        }
    }

    if (allowStProxy) {
        try {
            const result = await postJson(ST_SLOTS_PROXY, { server_url: target.url, action: 'info' }, timeoutMs + 2000);
            if (result.ok && Array.isArray(result.data)) {
                return recordSlots({ ok: true, via: 'sillytavern', at, ...summarizeSlots(result.data) });
            }
            return recordSlots({ ok: false, via: 'sillytavern', at, error: `HTTP ${result.status} (is /slots enabled, or is an API key set?)` });
        } catch (error) {
            return recordSlots({ ok: false, via: 'sillytavern', at, error: String(error?.message ?? error) });
        }
    }
    return recordSlots({ ok: false, via: 'none', at, error: state.direct.get(base)?.error ?? 'not reachable' });
}

async function routerUnload(target) {
    if (!target?.model) {
        return { ok: false, error: 'no router-mode model selected in SillyTavern' };
    }
    try {
        if (state.plugin) {
            const result = await postJson(`${PLUGIN_BASE}/unload`, { server_url: target.url, auth: target.auth, model: target.model }, 15000);
            return result.data ?? { ok: false, error: `HTTP ${result.status}` };
        }
        const response = await nativeFetch(`${baseUrl(target.url)}/models/unload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: target.model }),
            credentials: 'omit',
            signal: timeoutSignal(10000),
        });
        return response.ok ? { ok: true } : { ok: false, error: `HTTP ${response.status}` };
    } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
    }
}

const slotKey = busy => `${busy.slot}:${busy.task}`;

function describeBusy(list) {
    return list.map(b => `slot ${b.slot}${b.task !== null ? ` (task ${b.task}` : ' ('}${b.decoded !== null ? `, ${b.decoded} tokens` : ''})`).join(', ');
}

/**
 * Polls /slots until none of the tasks that were busy in `snapshot` are still busy.
 * @param {Target} target
 * @param {SlotsResult|null} snapshot
 */
async function verifyIdle(target, snapshot, windowMs) {
    if (!snapshot?.ok) {
        return { ok: null, error: snapshot?.error ?? 'could not read /slots', stillBusy: [] };
    }
    const watched = new Set(snapshot.busy.map(slotKey));
    if (watched.size === 0) {
        return { ok: true, waitedMs: 0, stillBusy: [], wasBusy: false };
    }
    const started = Date.now();
    const stepMs = snapshot.via === 'sillytavern' ? 1500 : 400;
    let last = snapshot;
    while (Date.now() - started < windowMs) {
        await sleep(stepMs);
        const current = await fetchSlots(target, { allowStProxy: snapshot.via === 'sillytavern' });
        if (!current.ok) {
            continue;
        }
        last = current;
        if (!current.busy.some(b => watched.has(slotKey(b)))) {
            return { ok: true, waitedMs: Date.now() - started, stillBusy: [], wasBusy: true };
        }
    }
    return { ok: false, waitedMs: Date.now() - started, stillBusy: last.busy.filter(b => watched.has(slotKey(b))), wasBusy: true };
}

/**
 * After a router-mode unload the model's /slots stops answering (autoload=false), which means the
 * instance is gone. The router force-terminates it after its stop-timeout (10 s by default).
 * @param {Target} target
 * @param {BusySlot[]} watchedBusy
 */
async function verifyUnloaded(target, watchedBusy) {
    const watched = new Set(watchedBusy.map(slotKey));
    const started = Date.now();
    let stillBusy = watchedBusy;
    while (Date.now() - started < 30000) {
        await sleep(1000);
        const current = await fetchSlots(target, { allowStProxy: false });
        if (current.ok) {
            stillBusy = current.busy.filter(b => watched.has(slotKey(b)));
            if (!stillBusy.length) {
                return { ok: true, waitedMs: Date.now() - started, stillBusy: [], wasBusy: true };
            }
        } else if (/not loaded|unloaded/i.test(current.error ?? '')) {
            // The router answers "model is not loaded" only once the instance has exited.
            return { ok: true, waitedMs: Date.now() - started, stillBusy: [], wasBusy: true, unloaded: true };
        }
        // Any other error: the instance is still shutting down (the router force-kills it after its stop-timeout).
    }
    return { ok: false, waitedMs: Date.now() - started, stillBusy, wasBusy: true, shuttingDown: true };
}

// ---------------------------------------------------------------------------------------------
// The stop flows
// ---------------------------------------------------------------------------------------------

function stuckExplanation(report) {
    if (!state.plugin) {
        return 'SillyTavern\'s server is probably still holding the connection. Install the companion server plugin so All Stop can force-close it (see the extension\'s README).';
    }
    if ((report.killed ?? 0) > 0) {
        return 'SillyTavern\'s connection was closed, but llama.cpp did not cancel. Something between SillyTavern and llama.cpp (a proxy, tunnel or llama-swap) is keeping the request alive, or another app started this generation.';
    }
    return 'SillyTavern has no open connection to llama.cpp, so the request is held by something else (a proxy, tunnel or another app), or llama.cpp is finishing a long prompt-processing batch (it can only cancel between batches).';
}

/**
 * Would pressing All Stop now do more than what already happened?
 * @param {Target|null} target
 * @returns {Promise<{actionable: boolean, hint: string}>}
 */
async function canForceStop(target) {
    if (settings().routerUnload && target?.model) {
        return { actionable: true, hint: 'Click to All Stop (router mode: the model will be unloaded if needed).' };
    }
    if (!state.plugin) {
        return { actionable: false, hint: 'Install the companion server plugin so All Stop can force-close it.' };
    }
    const open = await pluginConnections(target);
    if (open === null || open.length > 0) {
        return { actionable: true, hint: 'Click to All Stop.' };
    }
    return { actionable: false, hint: 'SillyTavern is not holding this request, so All Stop cannot close it: something between SillyTavern and llama.cpp (proxy, tunnel, llama-swap) or another app keeps it alive.' };
}

/** Marks slots we already reported so the watchdog doesn't warn about them twice. */
function markHandled(list) {
    const now = Date.now();
    for (const busy of list ?? []) {
        state.busySince.set(slotKey(busy), { since: now - 1e9, handled: true });
    }
}

/**
 * Manual All Stop: everything, immediately.
 * @param {{trigger?: string, quiet?: boolean}} [options]
 */
function runAllStop({ trigger = 'manual', quiet = false } = {}) {
    if (state.running) {
        return state.running;
    }
    const s = settings();
    const target = getTarget();
    state.suppressAuto++;
    setIndicator('working');
    state.running = (async () => {
        const report = { trigger, target: target?.url ?? null, model: target?.model ?? '', stoppedSillyTavern: false, abortedBrowser: 0, killed: 0, pluginError: null, verify: null, unload: null };
        // stopGeneration() reports true whenever an abort controller exists, so check first.
        const wasGenerating = isStopButtonVisible();
        try {
            ctx().stopGeneration();
            report.stoppedSillyTavern = wasGenerating;
        } catch (error) {
            console.warn(LOG, 'stopGeneration failed', error);
        }
        report.abortedBrowser = abortBrowserRequests();

        if (state.plugin === null) {
            await probePlugin();
        }
        const [kill, snapshot] = await Promise.all([
            state.plugin ? pluginStop(target, 0, s.killScope === 'all') : Promise.resolve(null),
            target ? fetchSlots(target) : Promise.resolve(null),
        ]);
        report.killed = kill?.killed?.length ?? 0;
        report.pluginError = kill && !kill.ok ? kill.error : null;

        if (target) {
            report.verify = await verifyIdle(target, snapshot, clamp(s.verifySeconds, 3, 120, 15) * 1000);
            if (report.verify.ok === false && s.routerUnload && target.model) {
                report.unload = await routerUnload(target);
                if (report.unload.ok) {
                    report.verify = await verifyUnloaded(target, report.verify.stillBusy);
                }
            }
            markHandled(report.verify?.stillBusy);
        }
        report.summary = summarizeReport(report);
        console.info(LOG, report);
        if (!quiet) {
            notifyReport(report);
        }
        return report;
    })().finally(() => {
        state.running = null;
        state.suppressAuto = Math.max(0, state.suppressAuto - 1);
        refreshIndicatorSoon();
    });
    return state.running;
}

function summarizeReport(report) {
    const parts = [];
    if (report.killed) {
        parts.push(`force-closed ${plural(report.killed, 'connection')} to llama.cpp`);
    }
    if (report.abortedBrowser) {
        parts.push(`aborted ${plural(report.abortedBrowser, 'browser request')}`);
    }
    if (report.stoppedSillyTavern) {
        parts.push('stopped SillyTavern\'s generation');
    }
    const actions = parts.length ? parts.join(', ') : 'nothing needed stopping on SillyTavern\'s side';
    const verify = report.verify;
    if (!report.target) {
        return `${actions}; no llama.cpp URL configured.`;
    }
    if (!verify || verify.ok === null) {
        return `${actions}; could not check llama.cpp (${verify?.error ?? 'unknown'}).`;
    }
    if (verify.ok) {
        if (verify.unloaded) {
            return `${actions}; llama.cpp did not cancel, so the router unloaded model "${report.model}" to stop it.`;
        }
        return verify.wasBusy ? `${actions}; llama.cpp stopped after ${(verify.waitedMs / 1000).toFixed(1)}s.` : `${actions}; llama.cpp was already idle.`;
    }
    const unload = report.unload ? ` Router unload: ${report.unload.ok ? 'requested' : `failed (${report.unload.error})`}.` : '';
    return `${actions}; llama.cpp is STILL generating: ${describeBusy(verify.stillBusy)}.${unload}`;
}

function notifyReport(report) {
    const verify = report.verify;
    const title = DISPLAY_NAME;
    if (verify?.ok === false) {
        toastr.error(`${escapeHtml(report.summary)}<br><br>${escapeHtml(stuckExplanation(report))}`, title, { timeOut: 20000, extendedTimeOut: 10000, closeButton: true, escapeHtml: false });
        return;
    }
    const pluginHint = state.plugin ? '' : '<br><small>Server plugin not detected: connections held by the SillyTavern server cannot be force-closed.</small>';
    if (verify?.ok === null || !report.target) {
        toastr.warning(`${escapeHtml(report.summary)}${pluginHint}`, title, { escapeHtml: false });
        return;
    }
    toastr.success(`${escapeHtml(report.summary)}${pluginHint}`, title, { escapeHtml: false });
}

/** Runs after SillyTavern's own Stop: give it a moment, then close whatever it left open. */
async function onGenerationStopped() {
    const s = settings();
    if (!s.enabled || !s.autoOnStop || state.suppressAuto > 0 || state.running || state.autoRunning) {
        return;
    }
    const target = getTarget();
    if (!target?.active) {
        return;
    }
    state.autoRunning = true;
    const stoppedAt = Date.now();
    try {
        const abortedBrowser = s.abortOtherRequests ? abortBrowserRequests(stoppedAt) : 0;
        const [kill, snapshot] = await Promise.all([
            state.plugin ? pluginStop(target, clamp(s.graceMs, 0, 10000, 1000), false) : Promise.resolve(null),
            fetchSlots(target),
        ]);
        const killed = kill?.killed?.length ?? 0;
        const verify = await verifyIdle(target, snapshot, clamp(s.verifySeconds, 3, 120, 15) * 1000);
        markHandled(verify.stillBusy);
        const report = { trigger: 'auto', target: target.url, stoppedSillyTavern: true, abortedBrowser, killed, verify };
        report.summary = summarizeReport(report);
        if (killed > 0 || verify.ok === false) {
            console.info(LOG, report);
        }
        if (!s.notify) {
            return;
        }
        if (verify.ok === false) {
            // Offer the click only when All Stop can do more than what just happened.
            const { actionable } = await canForceStop(target);
            toastr.error(`llama.cpp is still generating after Stop: ${escapeHtml(describeBusy(verify.stillBusy))}.<br><br>${escapeHtml(stuckExplanation(report))}${actionable ? '<br><br><b>Click to All Stop.</b>' : ''}`, DISPLAY_NAME, {
                timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false, onclick: actionable ? () => runAllStop({ trigger: 'toast' }) : undefined,
            });
        } else if (killed > 0) {
            toastr.info(`SillyTavern's Stop didn't reach llama.cpp, so ${plural(killed, 'stuck connection')} ${killed === 1 ? 'was' : 'were'} force-closed.${verify.ok ? ' llama.cpp is idle.' : ''}`, DISPLAY_NAME);
        }
    } catch (error) {
        console.warn(LOG, 'post-stop check failed', error);
    } finally {
        state.autoRunning = false;
        refreshIndicatorSoon();
    }
}

// ---------------------------------------------------------------------------------------------
// Watchdog: llama.cpp busy while this tab is idle
// ---------------------------------------------------------------------------------------------

/** SillyTavern shows its Stop button only while its own (chat) generation runs. */
function isStopButtonVisible() {
    const stopButton = document.getElementById('mes_stop');
    return !!stopButton && getComputedStyle(stopButton).display !== 'none';
}

function isTabGenerating() {
    return inflight.size > 0 || isStopButtonVisible();
}

function evaluateSlots(result) {
    if (!result.ok) {
        setIndicator('unknown', result.error);
        return;
    }
    if (!result.busy.length) {
        state.busySince.clear();
        setIndicator('idle', `llama.cpp idle (${plural(result.total, 'slot')})`);
        return;
    }
    if (isTabGenerating()) {
        state.busySince.clear();
        setIndicator('busy', `Generating: ${describeBusy(result.busy)}`);
        return;
    }
    const s = settings();
    const now = Date.now();
    const thresholdMs = clamp(s.watchdogBusySec, 2, 600, 8) * 1000;
    const present = new Set();
    const fresh = [];
    for (const busy of result.busy) {
        const key = slotKey(busy);
        present.add(key);
        let record = state.busySince.get(key);
        if (!record) {
            record = { since: now, handled: false };
            state.busySince.set(key, record);
        }
        if (!record.handled && now - record.since >= thresholdMs) {
            record.handled = true;
            fresh.push(busy);
        }
    }
    for (const key of [...state.busySince.keys()]) {
        if (!present.has(key)) {
            state.busySince.delete(key);
        }
    }
    const runaway = [...state.busySince.values()].some(record => now - record.since >= thresholdMs);
    setIndicator(runaway ? 'runaway' : 'busy', `${runaway ? 'Runaway generation' : 'llama.cpp busy'} while SillyTavern is idle: ${describeBusy(result.busy)}`);
    if (!fresh.length) {
        return;
    }
    if (s.watchdogAction === 'stop') {
        runAllStop({ trigger: 'watchdog' });
    } else if (s.notify) {
        canForceStop(getTarget()).then(({ actionable, hint }) => {
            toastr.warning(`llama.cpp is still generating (${escapeHtml(describeBusy(fresh))}) but SillyTavern isn't.<br>${actionable ? `<b>${escapeHtml(hint)}</b>` : escapeHtml(hint)}`, DISPLAY_NAME, {
                timeOut: 0, extendedTimeOut: 0, closeButton: true, preventDuplicates: true, escapeHtml: false, onclick: actionable ? () => runAllStop({ trigger: 'toast' }) : undefined,
            });
        });
    }
}

async function watchdogTick() {
    const s = settings();
    if (state.ticking || state.running || state.autoRunning || !s.enabled || !s.watchdog) {
        return;
    }
    const target = getTarget();
    if (!target?.active) {
        setIndicator('unknown', 'llama.cpp is not the active API');
        return;
    }
    state.ticking = true;
    try {
        // Never poll through SillyTavern's own proxy here: it logs every call at debug level.
        evaluateSlots(await fetchSlots(target, { allowStProxy: false, timeoutMs: 3000 }));
    } catch (error) {
        setIndicator('unknown', String(error?.message ?? error));
    } finally {
        state.ticking = false;
    }
}

function restartWatchdog() {
    if (state.watchdogTimer) {
        clearInterval(state.watchdogTimer);
        state.watchdogTimer = null;
    }
    const s = settings();
    if (s.enabled && s.watchdog) {
        state.watchdogTimer = setInterval(watchdogTick, clamp(s.watchdogIntervalSec, 2, 120, 5) * 1000);
    }
}

let refreshTimer = null;
function refreshIndicatorSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
        const target = getTarget();
        if (!target?.active || state.running) {
            return;
        }
        evaluateSlots(await fetchSlots(target, { allowStProxy: false, timeoutMs: 3000 }));
    }, 300);
}

// ---------------------------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------------------------

const INDICATOR_TITLES = {
    idle: 'llama.cpp All Stop: llama.cpp is idle',
    busy: 'llama.cpp All Stop: llama.cpp is generating',
    runaway: 'llama.cpp All Stop: llama.cpp is generating while SillyTavern is idle. Click to stop it.',
    working: 'llama.cpp All Stop: stopping…',
    unknown: 'llama.cpp All Stop: stop every llama.cpp generation',
};

function setIndicator(kind, detail = '') {
    state.indicator = kind;
    state.indicatorDetail = detail;
    const button = document.getElementById('llamacpp_allstop_button');
    if (button) {
        for (const name of Object.keys(INDICATOR_TITLES)) {
            button.classList.toggle(`allstop-${name}`, name === kind);
        }
        button.title = `${INDICATOR_TITLES[kind] ?? INDICATOR_TITLES.unknown}${detail && kind !== 'working' ? `\n${detail}` : ''}`;
    }
    renderStatus();
}

function updateButton() {
    const s = settings();
    const target = getTarget();
    let button = document.getElementById('llamacpp_allstop_button');
    const wanted = s.enabled && s.showButton && !!target?.active;
    if (!wanted) {
        button?.remove();
        return;
    }
    if (button) {
        return;
    }
    const host = document.getElementById('rightSendForm');
    if (!host) {
        return;
    }
    button = document.createElement('div');
    button.id = 'llamacpp_allstop_button';
    button.className = 'fa-solid fa-power-off interactable';
    button.tabIndex = 0;
    button.setAttribute('role', 'button');
    button.setAttribute('aria-label', 'llama.cpp All Stop');
    button.addEventListener('click', () => runAllStop({ trigger: 'button' }));
    button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            runAllStop({ trigger: 'button' });
        }
    });
    host.insertBefore(button, document.getElementById('mes_stop') ?? host.firstChild);
    setIndicator(state.indicator, state.indicatorDetail);
}

function addMenuItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('llamacpp_allstop_menu')) {
        return;
    }
    const item = document.createElement('div');
    item.id = 'llamacpp_allstop_menu';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.title = 'Stop every llama.cpp generation, including ones SillyTavern lost track of';
    item.innerHTML = '<div class="fa-solid fa-power-off extensionsMenuExtensionButton"></div><span>llama.cpp All Stop</span>';
    item.addEventListener('click', () => runAllStop({ trigger: 'menu' }));
    menu.append(item);
}

const SETTINGS_HTML = `
<div id="llamacpp_allstop_settings" class="llamacpp-allstop-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>llama.cpp All Stop</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="llamacpp-allstop-status" id="llamacpp_allstop_status"></div>
            <div class="flex-container flexGap5">
                <div id="llamacpp_allstop_now" class="menu_button menu_button_icon"><i class="fa-solid fa-power-off"></i><span>All Stop now</span></div>
                <div id="llamacpp_allstop_refresh" class="menu_button menu_button_icon"><i class="fa-solid fa-rotate"></i><span>Check</span></div>
            </div>
            <hr class="sysHR">
            <label class="checkbox_label"><input type="checkbox" id="llamacpp_allstop_enabled"><span>Enabled</span></label>
            <label class="checkbox_label"><input type="checkbox" id="llamacpp_allstop_show_button"><span>Show the <i class="fa-solid fa-power-off"></i> All Stop button next to Send</span></label>
            <label class="checkbox_label"><input type="checkbox" id="llamacpp_allstop_auto"><span>After I press Stop, make sure llama.cpp actually stopped</span></label>
            <div class="llamacpp-allstop-indent">
                <label for="llamacpp_allstop_grace">Give SillyTavern's own Stop this long before force-closing (ms)</label>
                <input type="number" id="llamacpp_allstop_grace" class="text_pole" min="0" max="10000" step="100">
                <label class="checkbox_label"><input type="checkbox" id="llamacpp_allstop_abort_others"><span>Also cancel other generation requests from this tab (extensions, background generations)</span></label>
            </div>
            <label class="checkbox_label"><input type="checkbox" id="llamacpp_allstop_watchdog"><span>Watchdog: catch llama.cpp generating while SillyTavern is idle</span></label>
            <div class="llamacpp-allstop-indent">
                <div class="flex-container flexGap5">
                    <div class="flex1">
                        <label for="llamacpp_allstop_watch_interval">Check every (s)</label>
                        <input type="number" id="llamacpp_allstop_watch_interval" class="text_pole" min="2" max="120" step="1">
                    </div>
                    <div class="flex1">
                        <label for="llamacpp_allstop_watch_busy">Flag after (s)</label>
                        <input type="number" id="llamacpp_allstop_watch_busy" class="text_pole" min="2" max="600" step="1">
                    </div>
                </div>
                <label class="checkbox_label"><input type="radio" name="llamacpp_allstop_watch_action" value="warn"><span>Warn me</span></label>
                <label class="checkbox_label"><input type="radio" name="llamacpp_allstop_watch_action" value="stop"><span>All Stop automatically</span></label>
            </div>
            <label class="checkbox_label"><input type="checkbox" id="llamacpp_allstop_notify"><span>Show notifications</span></label>
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <span>Advanced</span>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label for="llamacpp_allstop_url">llama.cpp URL override (empty = the URL from the API connection panel)</label>
                    <input type="text" id="llamacpp_allstop_url" class="text_pole" placeholder="http://127.0.0.1:8080">
                    <div>Force-close connections to:</div>
                    <label class="checkbox_label"><input type="radio" name="llamacpp_allstop_scope" value="server"><span>only the llama.cpp server</span></label>
                    <label class="checkbox_label"><input type="radio" name="llamacpp_allstop_scope" value="all"><span>every backend (all generations SillyTavern's server is running)</span></label>
                    <label for="llamacpp_allstop_verify">Watch llama.cpp after a stop for up to (s)</label>
                    <input type="number" id="llamacpp_allstop_verify" class="text_pole" min="3" max="120" step="1">
                    <label class="checkbox_label"><input type="checkbox" id="llamacpp_allstop_router_unload"><span>Last resort (router mode only): unload the model if it is still generating after All Stop</span></label>
                </div>
            </div>
        </div>
    </div>
</div>`;

function bindCheckbox(id, key, after) {
    const element = /** @type {HTMLInputElement} */ (document.getElementById(id));
    element.checked = !!settings()[key];
    element.addEventListener('change', () => {
        settings()[key] = element.checked;
        saveSettings();
        after?.();
    });
}

function bindNumber(id, key, min, max, after) {
    const element = /** @type {HTMLInputElement} */ (document.getElementById(id));
    element.value = String(settings()[key]);
    element.addEventListener('change', () => {
        const value = clamp(element.value, min, max, DEFAULT_SETTINGS[key]);
        element.value = String(value);
        settings()[key] = value;
        saveSettings();
        after?.();
    });
}

function bindRadio(name, key, after) {
    const radios = /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll(`input[name="${name}"]`));
    for (const radio of radios) {
        radio.checked = radio.value === settings()[key];
        radio.addEventListener('change', () => {
            if (radio.checked) {
                settings()[key] = radio.value;
                saveSettings();
                after?.();
            }
        });
    }
}

function renderSettings() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host || document.getElementById('llamacpp_allstop_settings')) {
        return;
    }
    host.insertAdjacentHTML('beforeend', SETTINGS_HTML);
    const refreshAll = () => {
        updateButton();
        restartWatchdog();
        renderStatus();
    };
    bindCheckbox('llamacpp_allstop_enabled', 'enabled', refreshAll);
    bindCheckbox('llamacpp_allstop_show_button', 'showButton', refreshAll);
    bindCheckbox('llamacpp_allstop_auto', 'autoOnStop');
    bindNumber('llamacpp_allstop_grace', 'graceMs', 0, 10000);
    bindCheckbox('llamacpp_allstop_abort_others', 'abortOtherRequests');
    bindCheckbox('llamacpp_allstop_watchdog', 'watchdog', refreshAll);
    bindNumber('llamacpp_allstop_watch_interval', 'watchdogIntervalSec', 2, 120, refreshAll);
    bindNumber('llamacpp_allstop_watch_busy', 'watchdogBusySec', 2, 600);
    bindRadio('llamacpp_allstop_watch_action', 'watchdogAction');
    bindCheckbox('llamacpp_allstop_notify', 'notify');
    bindRadio('llamacpp_allstop_scope', 'killScope');
    bindNumber('llamacpp_allstop_verify', 'verifySeconds', 3, 120);
    bindCheckbox('llamacpp_allstop_router_unload', 'routerUnload');

    const urlInput = /** @type {HTMLInputElement} */ (document.getElementById('llamacpp_allstop_url'));
    urlInput.value = settings().serverUrlOverride;
    urlInput.addEventListener('change', () => {
        settings().serverUrlOverride = urlInput.value.trim();
        saveSettings();
        state.direct.clear();
        refreshAll();
        refreshIndicatorSoon();
    });

    document.getElementById('llamacpp_allstop_now')?.addEventListener('click', () => runAllStop({ trigger: 'settings' }));
    document.getElementById('llamacpp_allstop_refresh')?.addEventListener('click', async () => {
        state.direct.clear();
        await probePlugin();
        const target = getTarget();
        evaluateSlots(await fetchSlots(target, { allowStProxy: true }));
        await renderConnections(target);
    });
    renderStatus();
}

let lastConnections = null;
async function renderConnections(target) {
    lastConnections = await pluginConnections(target);
    renderStatus();
}

function renderStatus() {
    const element = document.getElementById('llamacpp_allstop_status');
    if (!element) {
        return;
    }
    const target = getTarget();
    const rows = [];
    const row = (label, value, cls = '') => rows.push(`<div><span class="llamacpp-allstop-label">${label}</span><span class="${cls}">${value}</span></div>`);

    row('llama.cpp', target ? `${escapeHtml(target.url)} <small>(${escapeHtml(target.label)})</small>` : 'not configured: select llama.cpp in the API connection panel or set a URL override', target?.active ? '' : 'llamacpp-allstop-warn');
    if (state.plugin === null) {
        row('Server plugin', 'checking…');
    } else if (state.plugin) {
        row('Server plugin', `installed v${escapeHtml(state.pluginInfo?.version ?? '?')}, can force-close stuck connections`, 'llamacpp-allstop-ok');
    } else {
        row('Server plugin', 'not installed: All Stop cannot force-close connections held by the SillyTavern server (see README)', 'llamacpp-allstop-warn');
    }
    const slots = state.lastSlots;
    if (!slots) {
        row('State', 'not checked yet');
    } else if (!slots.ok) {
        row('State', `unknown: ${escapeHtml(slots.error)}`, 'llamacpp-allstop-warn');
    } else if (!slots.busy.length) {
        row('State', `idle (${plural(slots.total, 'slot')}, via ${escapeHtml(slots.via)})`, 'llamacpp-allstop-ok');
    } else {
        row('State', `${state.indicator === 'runaway' ? 'RUNAWAY: ' : 'generating: '}${escapeHtml(describeBusy(slots.busy))} (via ${escapeHtml(slots.via)})`, state.indicator === 'runaway' ? 'llamacpp-allstop-bad' : '');
    }
    if (Array.isArray(lastConnections)) {
        row('SillyTavern → llama.cpp', lastConnections.length ? lastConnections.map(c => `${escapeHtml(c.phase)} ${Math.round(c.age_ms / 1000)}s`).join(', ') : 'no open generation connections');
    }
    element.innerHTML = rows.join('');
}

// ---------------------------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------------------------

function registerSlashCommands() {
    const { SlashCommandParser, SlashCommand, SlashCommandNamedArgument, ARGUMENT_TYPE } = ctx();
    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) {
        return;
    }
    const isTrue = value => ['true', '1', 'on', 'yes'].includes(String(value ?? '').toLowerCase());
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'allstop',
        aliases: ['llamastop'],
        callback: async (args) => (await runAllStop({ trigger: 'slash', quiet: isTrue(args?.quiet) })).summary,
        returns: 'a one-line summary of what was stopped',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: 'do not show notifications',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: ['true', 'false'],
            }),
        ],
        helpString: `
            <div>Stops every llama.cpp generation: SillyTavern's own, any generation request this tab still has open,
            and (with the companion server plugin) any connection the SillyTavern server is still holding to llama.cpp.
            Then waits for llama.cpp's <code>/slots</code> to show the slot idle.</div>
            <div><strong>Example:</strong> <pre><code class="language-stscript">/allstop quiet=true | /echo</code></pre></div>`,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'allstop-status',
        callback: async () => {
            const target = getTarget();
            if (state.plugin === null) {
                await probePlugin();
            }
            const slots = await fetchSlots(target);
            return JSON.stringify({
                target: target?.url ?? null,
                source: target?.label ?? null,
                plugin: !!state.plugin,
                llamacpp: slots.ok ? { busy: slots.busy, slots: slots.total, via: slots.via } : { error: slots.error },
                sillytavernConnections: await pluginConnections(target),
                browserRequests: inflight.size,
            });
        },
        returns: 'JSON with llama.cpp slot state and open connections',
        helpString: 'Reports whether llama.cpp is generating, and which generation connections SillyTavern still has open.',
    }));
}

// ---------------------------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------------------------

let lastTargetKey = '';
function onConnectionChanged() {
    const target = getTarget();
    const key = target ? `${baseUrl(target.url)}|${target.model}|${target.active}` : '';
    if (key === lastTargetKey) {
        return;
    }
    lastTargetKey = key;
    // Different server: slot/task ids from the old one mean nothing now.
    state.busySince.clear();
    state.lastSlots = null;
    lastConnections = null;
    updateButton();
    refreshIndicatorSoon();
}

jQuery(async () => {
    settings();
    renderSettings();
    updateButton();
    addMenuItem();
    registerSlashCommands();

    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.GENERATION_STOPPED, onGenerationStopped);
    for (const name of ['MAIN_API_CHANGED', 'ONLINE_STATUS_CHANGED', 'CHATCOMPLETION_SOURCE_CHANGED', 'SETTINGS_UPDATED']) {
        if (eventTypes[name]) {
            eventSource.on(eventTypes[name], onConnectionChanged);
        }
    }
    if (eventTypes.APP_READY) {
        eventSource.on(eventTypes.APP_READY, () => {
            addMenuItem();
            updateButton();
        });
    }

    await probePlugin();
    restartWatchdog();
    refreshIndicatorSoon();
    console.info(LOG, `loaded (server plugin ${state.plugin ? 'detected' : 'not detected'})`);
});
