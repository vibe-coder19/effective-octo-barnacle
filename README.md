# llama.cpp All Stop

A SillyTavern extension that makes sure **Stop actually stops llama.cpp**, plus an **All Stop**
button and `/allstop` command you can hit any time, including after SillyTavern already
thinks it stopped.

## Why llama.cpp keeps generating after you press Stop

llama.cpp's server has **no "cancel" endpoint**. It cancels a generation only when the HTTP
connection that started it closes. SillyTavern's Stop button closes the browser's request and
relies on that close travelling all the way:

```
browser ──✕──> SillyTavern server ──✕──> (proxy / tunnel?) ──✕──> llama.cpp
```

If the close gets lost anywhere on the way (a reverse proxy or tunnel in front of SillyTavern,
a laggy or flaky connection, a request SillyTavern lost track of), SillyTavern looks idle while
llama.cpp keeps generating until it hits the token limit. Your next message then waits behind
that runaway or shares the GPU with it.

## What it does

| | |
|---|---|
| **After you press Stop** | Gives SillyTavern's own Stop 1 s to work, then force-closes any connection to llama.cpp that is still open. A toast tells you when this happens. |
| **All Stop** button (⏻ next to Send), wand-menu item, `/allstop` | Stops everything immediately: SillyTavern's generation, every generation request the browser tab still has open (including background ones from other extensions), and every connection the SillyTavern server still holds to llama.cpp. |
| **Verification** | Watches llama.cpp's `/slots` until the slot is idle, and tells you if it is still generating and why. |
| **Watchdog** | Notices llama.cpp generating while SillyTavern is idle. The ⏻ button turns red and you get a clickable warning (or, if you choose, it stops it automatically). |
| **Router mode last resort** (opt-in) | If llama.cpp runs in router mode and still won't stop, unloads the model. |

The ⏻ button's colour shows llama.cpp's state: grey = idle, orange = generating, pulsing red =
generating while SillyTavern is idle (a runaway).

## Install

You need **both parts**. The extension alone can only stop requests the browser still has open;
the force-close that fixes the "Stop didn't reach llama.cpp" case is done by the server plugin,
because only the SillyTavern server holds the connection to llama.cpp.

### 1. The extension

SillyTavern → **Extensions** (stacked blocks icon) → **Install extension** →
`https://github.com/vibe-coder19/effective-octo-barnacle`

Until this is merged into the default branch, enter `claude/nifty-archimedes-rg0jbe` as the
branch in the install dialog.

### 2. The server plugin

1. Copy the `server-plugin/llamacpp-allstop` folder into SillyTavern's `plugins` folder.
   From the SillyTavern folder, if you installed the extension for the current user:

   Windows (PowerShell):
   ```powershell
   Copy-Item -Recurse "data\default-user\extensions\effective-octo-barnacle\server-plugin\llamacpp-allstop" "plugins\"
   ```

   Linux / macOS:
   ```bash
   cp -r data/default-user/extensions/effective-octo-barnacle/server-plugin/llamacpp-allstop plugins/
   ```

   If you installed it "for all users", the source folder is
   `public/scripts/extensions/third-party/effective-octo-barnacle/server-plugin/llamacpp-allstop`
   instead. You should end up with `SillyTavern/plugins/llamacpp-allstop/index.mjs`.

2. In SillyTavern's `config.yaml`, set:
   ```yaml
   enableServerPlugins: true
   ```
3. Restart SillyTavern. The console should print
   `[llamacpp-allstop] v1.0.0 loaded: tracking outgoing generation requests`, and the extension's
   settings panel should say **Server plugin: installed**.

The plugin does not update with the extension: copy it again after an update that changes it.

## Use

* Just press SillyTavern's Stop as usual. If the stop doesn't reach llama.cpp, you'll see
  *"SillyTavern's Stop didn't reach llama.cpp, so 1 stuck connection was force-closed."*
* Press **⏻** (or the wand-menu item) whenever llama.cpp is busy and shouldn't be.
* `/allstop` stops everything and returns a one-line summary (`/allstop quiet=true` without
  toasts), so you can put it on a Quick Reply button. `/allstop-status` returns JSON with
  llama.cpp's slot state and any connections SillyTavern still has open.

## Settings

Extensions panel → **llama.cpp All Stop**. The status box at the top shows which llama.cpp URL
is used, whether the plugin is installed and what llama.cpp is doing.

| Setting | Default | |
|---|---|---|
| Show the ⏻ button next to Send | on | Shown while the active API is llama.cpp. |
| After I press Stop, make sure llama.cpp actually stopped | on | |
| Grace before force-closing | 1000 ms | How long SillyTavern's own Stop gets first. A generation you start after pressing Stop is never touched. |
| Also cancel other generation requests from this tab | on | Background generations from extensions, requests orphaned by double clicks. |
| Watchdog | on, every 5 s, flag after 8 s | Warns by default. "All Stop automatically" stops it without asking. |
| llama.cpp URL override | empty | Empty = the URL from the API connection panel (Text Completion › llama.cpp, or Chat Completion › Custom). |
| Force-close connections to | only the llama.cpp server | "every backend" stops all generations SillyTavern's server is running. |
| Router mode: unload the model as a last resort | off | Only for llama.cpp router mode with a model selected in SillyTavern. |

## What it can't stop

* **A request held by something between SillyTavern and llama.cpp** (a proxy, tunnel, or
  llama-swap that doesn't pass disconnects on), **or started by another app** (e.g. llama.cpp's
  own web UI). SillyTavern has no connection to close, so only llama.cpp can end it: restart it,
  fix the proxy so it forwards client disconnects, or use router mode with the unload option.
  The extension tells you when you're in this case.
* **Prompt processing** is cancelled between batches, so stopping during a huge prompt can take a
  few seconds on slow hardware (a smaller `-b`/`-ub` makes it react sooner).
* Verification and the watchdog need llama.cpp's `/slots` endpoint (on by default; `--no-slots`
  turns it off). Force-closing works without it.

Good to know:

* The plugin closes the generations **SillyTavern's server** is running to that llama.cpp server,
  for every user and tab. With several people or tabs sharing one llama.cpp, keep the watchdog on
  "Warn me".
* The plugin only watches SillyTavern's own outgoing requests (Node's built-in
  `diagnostics_channel`, nothing in SillyTavern is patched). It talks only to the llama.cpp URL
  you configured, and reads your saved llama.cpp API key from SillyTavern's `secrets.json` (read
  only) so `/slots` works when llama.cpp runs with `--api-key`.

## Tested with

SillyTavern 1.19.1 and llama.cpp `llama-server` built from master (November 2026), driving the
real UI with Playwright, with a reverse proxy in front of SillyTavern that swallows client
disconnects:

* Without the extension: after Stop, llama.cpp kept generating for another ~58 s until the token
  limit.
* With it: llama.cpp idle 1.1 s after Stop (automatic), 0.15 s after pressing ⏻, 0.4 s with
  `/allstop`.
* Also checked: Text Completion and Chat Completion › Custom, `--api-key`, a normal Stop
  (nothing extra happens), background generations, no plugin installed (clear explanation instead
  of a false "stopped"), a proxy between SillyTavern and llama.cpp (correctly reported as out of
  reach), router mode unload, phone-width layout.

---

`Maomao.json` in this repository is a SillyTavern character card, unrelated to the extension.
