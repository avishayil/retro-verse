# Protocols

## Host ⇄ webview (`webview.postMessage`), version 1

Every message is `{ v: 1, type, id?, payload }`. The host validates every incoming message with
`parsePlayerMessage` (`src/protocol/messages.ts`) and drops anything that fails. Types are defined in the same
file.

* **Host → player**
  * `init`: platform, title, capabilities, settings, backend, `suspendOnHide`.
  * `rom.chunk`: `{offset, total, data, done, error?}`, one piece of the game file, in order.
  * `backend`: swaps the running backend (used by Switch while Eden starts up).
  * `command` (with an `id`): `pause`, `resume`, `reset`, `saveState`, `loadState`, `flush`, `releaseAll`,
    `screenshot`, `suspend`, `stop`.
  * `status`, `settings`, `telemetry`, `toast`.
* **Player → host**
  * `ready`, `status`.
  * `rom.request`: asks for the game file. The player never gets a URL to it.
  * `save.battery`: `{data}`.
  * `save.state`: `{slot 0 to 9, data, suspend?}`.
  * `screenshot`.
  * `reply`: `{ok, error}`, answering a `command` by `id`.
  * `action`: a toolbar button for the host to handle; must be one of a fixed allow-list.
  * `log`, `telemetry`.
  * `input`: reserved; WASM cores consume input in-page.

Binary payloads travel as `Uint8Array` and are capped at 64 MB. Save slots are integers from 0 to 9.

## Host ⇄ eden-bridge (stdio, JSON lines)

* **Bridge → host (stdout):**
  * `hello{version, protocol}`
  * `permissions{screen, accessibility}`
  * `waiting{reason}`
  * `window{width, height, title}`
  * `ready{port}`: the port must be in the range 1024 to 65535.
  * `client{connected}`
  * `telemetry{data}`
  * `error{code, message, fatal}`
* **Bridge diagnostics:** stderr. The host logs it at debug level.
* **Host → bridge (stdin):**
  * `{"type":"releaseAll"}`
  * `{"type":"pause","paused":bool}`
  * `{"type":"keymap","map":{…}}`
  * `{"type":"stop"}`
  * EOF on stdin makes the bridge shut down.
* **Arguments:** `--pid N --fps 30|60 --height 540|720|1080 --bitrate kbps --keymap JSON`, plus
  `--turbo-hotkey`, `--avoid-pid` and `--no-place`. Other modes: `--list-windows`, `--selftest`, `--synthetic`,
  `--no-audio`.
* **Token:** the first stdin line must be `{"type":"token","token":"..."}` within 2 seconds, or the bridge exits.
  The token is never passed in argv or the environment.
* **Security events (stdout):** `{"type":"security","event":"auth-failed"|"origin-rejected"|"connection-limit"|"bad-frames","detail":...}`.

## Bridge ⇄ webview (WebSocket on 127.0.0.1)

Each frame is `[u8 type][u64 BE timestamp µs][payload]`. The framing lives in `src/protocol/bridgeWire.ts` and
`native/eden-bridge/Sources/EdenBridgeCore/Wire.swift`.

| Type | Dir | Payload |
|---|---|---|
| `0x01` Hello | → bridge | UTF-8 token; must be the first message, within 2 s |
| `0x10` Config | → webview | JSON `{codec:"avc1.PPCCLL", width, height, description: base64 avcC, sampleRate, channels}` |
| `0x11` Video | → webview | `u8 flags` (bit 0 = keyframe) + AVCC sample (4-byte length-prefixed NAL units) |
| `0x12` Audio | → webview | interleaved float32 LE PCM |
| `0x13` Telemetry | → webview | JSON `{fps, captureMs, encodeMs, bitrateKbps, droppedFrames}` |
| `0x14` Error | → webview | UTF-8 message |
| `0x20` Input | → bridge | `u32 seq, u32 buttons (bit i = BUTTONS[i]), f32 lx, ly, rx, ry` (big-endian) |
| `0x21`/`0x22` Ping/Pong | ↔ | empty; the pong echoes the ping timestamp |
| `0x23` Turbo | → bridge | `u8` 1 = on, 0 = off; the bridge presses the emulator's turbo hotkey when the state changes |

Input is always a full snapshot. Lost or duplicated packets are harmless, and an all-zero snapshot releases
everything.

Limits: at most 4 unauthenticated connections at once, 1000 input or ping frames per second per connection, and a
connection is closed after 3 malformed frames.
