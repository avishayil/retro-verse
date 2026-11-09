# Security model

This document describes what RetroVerse protects, where the trust boundaries are, and which controls enforce them.
Report problems privately as described in [SECURITY.md](../SECURITY.md).

## Trust boundaries

| Boundary | Why it is untrusted |
|---|---|
| Game files | ROMs come from anywhere. The extension parses their headers, the WebAssembly cores run them, and Eden opens Switch images. |
| The player webview | It runs third-party emulator JavaScript and WebAssembly on untrusted game data, so the extension host treats every message from it as untrusted. |
| Workspace settings | A cloned repository's `.vscode/settings.json` is written by whoever made the repository. |
| Other local processes and the LAN | They can reach the capture agent's loopback WebSocket, and Eden's GDB stub (Eden binds it to every interface). |
| The supply chain | npm packages (including the vendored emulator cores), GitHub Actions and the published VSIX. |

RetroVerse makes no outbound network requests of its own. It does not send telemetry, game data or file names
anywhere.

## Webview

- The webview can load only the extension's `dist/player/` and `media/cores/` folders. Game files are never
  exposed as URLs: the player asks for the game and the extension host streams the bytes in 8 MB messages. The
  player checks every chunk against the announced size (order, overlap, overrun, short file, timeout).
- The Content Security Policy starts from `default-src 'none'`. Scripts must carry a per-load nonce or come from
  the two folders above, and `'wasm-unsafe-eval'` allows compiling the WebAssembly cores. There is no
  `'unsafe-inline'` or `'unsafe-eval'`. Styles come only from the player folder. Connections are allowed to the
  cores folder and, for a Switch session, to the capture agent's exact `ws://127.0.0.1:<port>`; the extension
  re-renders the player once the port is known. Images, media, fonts, frames, workers, objects and forms are
  blocked. The policy builder rejects any source that could split a directive.
- The HTML shell never contains game names or paths. Text is set with `textContent`, and the DOM helper refuses
  event-handler, style and URL attributes. CI fails on new `innerHTML`, `insertAdjacentHTML`, `eval` or `new
  Function` in `src/`.
- Every message from the webview is validated before the extension acts on it: protocol version, a type
  allow-list, payload shapes, byte limits (64 MB), save slot range and an action allow-list. The webview can never
  name a file path.

## Settings

Settings that choose programs, arguments, environment variables, file locations or capture behaviour are declared
`machine` or `application` scoped, so VS Code ignores them in workspace and folder settings. RetroVerse also reads
them only from user settings. They are additionally listed as restricted configurations for untrusted workspaces.
An integration test checks that a workspace pointing `retroverse.switch.edenPath` at its own program cannot make
RetroVerse run it.

A custom saves folder must be absolute, outside every open workspace, and not a symlink to another location.
Otherwise RetroVerse warns and uses the default folder.

## Native processes

- Eden and the capture agent start only in a trusted, local workspace. RetroVerse spawns them with an argument
  array and no shell, and the game path is a single argument.
- An executable must be absolute, exist, be executable, be owned by the current user or root, not be writable by
  group or others, and not sit in a world-writable folder without the sticky bit. Discovery checks standard
  install locations before `PATH`. Helper tools run by absolute path (`/usr/sbin/lsof`, `/bin/ps`).
- Eden's environment drops VS Code's and RetroVerse's own variables (`ELECTRON_*`, `VSCODE_*`, `RETROVERSE_*`).
  The `retroverse.switch.environment` setting cannot set loader or runtime hooks (`DYLD_*`, `LD_*`, `NODE_*`, and
  others) or override `PATH`, `HOME`, `TMPDIR`, `SHELL` or `XDG_*`. The capture agent gets only a short
  allow-listed environment.
- Stopping a session ends Eden and the capture agent. The agent also exits when its stdin closes or the target
  process exits.

## Capture agent (eden-bridge)

- The agent is signed with the hardened runtime, so macOS ignores `DYLD_*` injection and enforces library
  validation.
- The session token is 32 random bytes. The extension writes it to the agent's stdin; it never appears in the
  command line or the environment. The agent exits if no valid token arrives within 2 seconds.
- The WebSocket binds `127.0.0.1` on a random port and accepts only local connections. The handshake must carry
  an `Origin` starting with `vscode-webview://`. The first frame must contain the token (compared in constant
  time) within 2 seconds.
- At most four unauthenticated connections exist at once. Input and ping frames are limited to 1000 per second
  per connection, and three malformed frames close the connection. Input values are length checked and clamped.
- Auth failures, origin rejections, connection floods and bad frames are reported to the extension and logged as
  security events. `test/harness/bridge-security.mjs` exercises each of these, and CI runs it.
- `RETROVERSE_BRIDGE_TEST_ORIGIN` lets the test harness connect from `http://127.0.0.1`. The agent honours it only
  in `--synthetic` test mode, and the extension never passes it.
- Window capture is limited to the largest window owned by the target process ID. The developer command that
  streams any window is off unless `retroverse.diagnostics.devMode` is set in user settings, and it asks for
  confirmation each time.

## Eden's GDB stub

Eden binds its GDB stub to every network interface, which RetroVerse cannot change. While the stub is on, any
device on the same network can attach a debugger to the running emulator. RetroVerse shows a warning once per VS
Code session when the stub is enabled. In the default `pump` mode, RetroVerse holds the stub's single debugger
connection for the whole session and attaches only to the Eden process it started. It never connects to a stub
owned by another process.

## Saves and logs

- Battery saves and states are stored under folders named by the SHA-256 of the game file. Folders are created
  owner-only (`0700`) and files `0600`. Writes go to an exclusively created temporary file with an unpredictable
  name and are then renamed into place, so an interrupted write or a planted symlink cannot corrupt a save.
- Logs replace game file names with short hashes. Output from Eden and the capture agent passes through a
  sanitiser that replaces the game path and the home directory, removes control characters and limits line
  length. The session token is never logged.

## Supply chain and releases

- `npm ci --ignore-scripts` installs dependencies in CI, so no package lifecycle script runs. CI also runs
  `npm audit signatures` and fails on high-severity advisories. A local stub replaces the `@emulatorjs/emulatorjs`
  dependency, which `@emulatorjs/core-melonds` declares at a floating `latest` version and which RetroVerse does
  not use.
- The vendored emulator cores must match the SHA-256 pins in `scripts/cores.sha256`, on top of the lockfile's
  integrity hashes.
- Every GitHub Action is pinned to a full commit SHA. Checkouts do not keep credentials, and each workflow and
  job declares the smallest `permissions` it needs. CodeQL analyses the TypeScript, the Swift agent and the
  workflows.
- Releases include `SHA256SUMS` and GitHub build provenance attestations for each VSIX. Verify a download with
  `gh attestation verify retroverse.vsix --repo avishayil/retro-verse`.

## Known limits

- Eden itself runs with your user's privileges and opens the game file. Its own security is outside RetroVerse's
  control.
- Accessibility permission lets VS Code send key presses to Eden, and Screen Recording lets it capture Eden's
  window. macOS grants these to VS Code as a whole, not only to RetroVerse.
- The two moderate `npm audit` findings are in `vsce`'s `minimatch`, a build tool that only processes patterns
  from this repository.
