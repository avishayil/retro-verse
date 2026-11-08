# Security model

* **Webview**
  * The CSP uses `default-src 'none'`. Scripts must carry a per-load nonce or come from the extension's
    `cspSource`, plus `'wasm-unsafe-eval'` to compile the cores.
  * `connect-src` is `cspSource`, plus `ws://127.0.0.1:*` for Switch panels only.
  * The HTML shell never contains file names. Titles arrive via `init` and are rendered with `textContent`.
  * `localResourceRoots` covers `dist/`, `media/`, and the ROM's own canonical directory. Switch ROMs are never
    exposed to the webview.
* **Message validation**
  * Every webview message is validated: version, type allow-list, payload shape, byte caps, slot range and the
    action allow-list.
  * The webview can never name a file path. Saves are keyed by host-computed SHA-256 identities, and
    `SaveStore` rejects path-like identifiers.
* **Paths**
  * ROM paths are absolute local files only (`file:` scheme). Symlinks are resolved.
  * Each platform has a size cap. A ROM must be a regular file and non-empty. An allowed-root check is available
    and unit-tested against traversal and symlink escapes.
* **Native processes**
  * Launching is only allowed in a trusted workspace. `retroverse.switch.edenPath`, `bridgePath` and `extraArgs`
    are declared `restrictedConfigurations`.
  * Processes are spawned with `shell: false` and an argument array. The ROM is always a single argument, and
    extra args are filtered for NUL and length.
  * A configured executable must be absolute, exist and be executable.
* **Lifecycle**
  * Eden and the bridge are stopped when their tab closes and in `deactivate()`.
  * The bridge exits when its stdin closes (the extension host died) or the target process exits.
  * `stop` resumes a SIGSTOPped process before SIGTERM, then sends SIGKILL after a grace period.
* **Bridge endpoint**
  * It binds `127.0.0.1` only, on an ephemeral port, with `acceptLocalOnly`.
  * The handshake requires an `Origin` starting with `vscode-webview://`. Missing or other origins are rejected.
  * The first frame must carry the 32-byte random token, compared in constant time, within 2 s. Otherwise the
    connection is closed.
  * The token is passed via an environment variable, never argv.
  * There is one viewer at a time. Input frames are length-checked, and axes are clamped and NaN-filtered.
* **Input safety**
  * Held buttons are released on blur, tab hide, gamepad disconnect, viewer disconnect, pause and shutdown.
  * The webview re-sends its full snapshot every 250 ms, so a lost key-up cannot stick.
* **Privacy:** there is no telemetry. Diagnostics redact file names to short hashes. Nothing about ROMs leaves
  the machine.
* **Test-only hook:** `RETROVERSE_BRIDGE_TEST_ORIGIN` lets the browser harness connect from `http://127.0.0.1`.
  The extension never sets it.
