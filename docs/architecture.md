# Architecture (as implemented)

This document describes what the code does today. The last section lists where the implementation departs
from the original design.

```
VS Code ── CustomReadonlyEditor "retroverse.player" ──► GameDocument (URI + metadata only)
   │                                                       │
   │ attachPlayer(): webview + PanelChannel ◄──postMessage──┤ Player webview (dist/player)
   │                                                       │   InputManager (keyboard + Gamepad API)
   ▼                                                       │   GbaBackend   → mGBA wasm   (media/cores/mgba)
SessionManager ── HostSession ◄── EmulatorRegistry         │   NdsBackend   → melonDS wasm (media/cores/melonds)
   │               ├─ WasmSession (gba, nds): saves/states │   StreamBackend→ WebCodecs H.264 + AudioWorklet
   │               └─ EdenSession  (switch)                │   External/Setup/Error info panels
   │                    ├─ ProcessSupervisor(Eden)         │
   │                    └─ BridgeClient ──stdio JSON──► eden-bridge ◄──ws://127.0.0.1 (token)──┘
   ▼                                                      ScreenCaptureKit → VideoToolbox → MediaServer
SaveStore (globalStorage/saves/<sha256>/<core>/…)        InputInjector → CGEventPostToPid(Eden)
```

## Modules

| Path | Role |
|---|---|
| `src/protocol/` | Shared between host and webview: types, versioned messages and validation (`parsePlayerMessage`), the session state machine, and the bridge binary framing. |
| `src/extension/providers/` | The custom editor, `attachPlayer` (webview options, message routing, lifecycle) and `PanelChannel` (request/reply with timeouts). |
| `src/extension/sessions/` | The `HostSession`/`EmulatorAdapter` contract (doc §3.3), `BaseSession`, and `SessionManager`, which tracks the active session and the `retroverse.cap.*` context keys. |
| `src/extension/adapters/wasm/` | The host side of in-webview emulation: ROM validation, ROM identity, battery saves, states, screenshots and the ROM change watcher. |
| `src/extension/adapters/eden/` | `EdenLocator` (discovery, argv building, data dir), `ProcessSupervisor` (no shell, SIGTERM→SIGKILL, SIGSTOP/SIGCONT), `BridgeClient`, `StreamSession` (bridge orchestration, falls back to external mode), `EdenSession`, and `DevStreamSession`. |
| `src/extension/security/` | Path canonicalisation and allowed-root checks, executable validation, tokens and nonces. |
| `src/player/` | The webview app: toolbar, input, backends, media pipeline. |
| `native/eden-bridge/` | The Swift capture/encode/serve/inject agent. `EdenBridgeCore` holds the pure logic covered by `swift test`. |

## Key flows

* **Opening a GBA/NDS game**
  1. The webview posts `ready`.
  2. `WasmSession.init()` canonicalises the path, enforces the size cap, computes the SHA-256 identity and loads
     the battery save.
  3. It returns `init` with core URLs and the ROM URL. Only the ROM's real directory is added to
     `localResourceRoots`.
  4. The webview fetches the ROM, writes it into MEMFS under a synthetic name (`game.gba`) and boots the core.
* **Persistence**
  * The webview posts `save.battery` when SRAM changes. mGBA reports this through its `saveDataUpdatedCallback`,
    debounced; melonDS is polled every 5 s and sends only on change. Saves are also flushed on pause, hide, stop
    and dispose.
  * The host serialises all writes, so `quickSave` resolves only after the state is on disk.
* **Hidden tab**
  * Buttons are released, the battery save is flushed, and the game auto-pauses.
  * When `retainContextWhenHidden` is off, a suspend state is also saved and restored on the next `init`.
* **Switch**
  1. Trust/remote/Eden checks happen first. If any fails, the webview shows a setup screen and nothing is
     spawned.
  2. Eden is spawned (`--game` for `eden-cli`, `-g` for the Qt build).
  3. `eden-bridge --pid` is spawned with the token in its environment.
  4. The bridge reports progress over stdout: `permissions`, then `waiting`/`window`, then `ready{port}`.
  5. The host publishes a `stream` backend to the webview.
  6. The webview connects to the port and sends `Hello(token)`.
  7. The bridge sends `Config(avcC)`, then a keyframe, then `Video`/`Audio`/`Telemetry` frames. The webview
     sends full `Input` snapshots back every 250 ms and on every change.

## Measured performance (Apple Silicon, test harness)

| Path | Result |
|---|---|
| GBA (mGBA) | 60 fps; input-to-pixel verified; save states ≈1.3 KB; battery save 32 KB. |
| NDS (melonDS) | 56 to 60 fps; save states ≈6.5 MB (uncompressed). |
| Stream (synthetic 720p30) | 30 fps; encode ≈5.5 ms, decode ≈0.7 ms; ≈3 Mbps for the simple pattern. Audio is buffered at about 60 ms. |

The stream latency figure in the stats overlay is an *estimate*: RTT/2 + capture + encode + decode. Measuring
true glass-to-glass latency still needs an external measurement.

## Differences from the original design

* **Packaging:** one extension package with three esbuild bundles, not a monorepo. `src/protocol` is shared by
  import.
* **NDS core:** melonDS (EmulatorJS libretro build, GPL-3) replaces Desmond, because Desmond's licence is
  unclear.
* **GBA core:** mGBA is pinned to 1.1.1. Version 2.x needs pthreads/`SharedArrayBuffer`, which VS Code webviews
  (not cross-origin isolated) can't provide.
* **Stream transport:** H.264 + PCM over an authenticated loopback WebSocket, decoded with WebCodecs, replaces
  WebRTC. On a single machine this avoids ICE/SDP complexity and still meets the 720p30 target. WebRTC remains
  an option for remote scenarios.
* **Switch pause:** done with process signals, since Eden exposes no control API to an unmodified binary.
