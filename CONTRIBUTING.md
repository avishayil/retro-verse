# Contributing

Bug reports and pull requests are welcome. Please never attach or link game files, BIOS files, firmware or keys
in issues or pull requests.

## Setup

```sh
npm install
npm run build          # copies the emulator cores into media/cores and bundles dist/
npm run build:native   # macOS only: builds bin/darwin-arm64/eden-bridge
```

Press F5 in VS Code and choose **Run RetroVerse (test ROMs)**. `npm run fixtures` writes small homebrew test ROMs
to `test/fixtures/roms/`. Their screen is blue, turns red while A is held and green while Start is held.

## Tests

```sh
npm run typecheck
npm test                                     # unit tests (vitest)
(cd native/eden-bridge && swift test)        # capture agent tests
npm run test:integration                     # runs the extension in a real VS Code
node test/harness/harness.mjs gba            # also nds or stream: browser checks of video, input and saves
node test/harness/switch-keys.mjs            # checks every Switch key through the capture agent
```

The browser harness needs Playwright's Chromium build (`npx playwright install chromium-headless-shell`). The
`stream` case and `switch-keys.mjs` use `eden-bridge --synthetic`, which needs no macOS permissions.

## Layout

| Path | What it holds |
|---|---|
| `src/extension/` | The extension host: editor and Explorer view providers, sessions, Eden support, saves |
| `src/player/` | The player that runs in the webview: emulator backends, input, stream decoding |
| `src/protocol/` | Message types shared by the extension and the player |
| `native/eden-bridge/` | The Swift capture agent for Switch streaming |
| `test/` | Unit tests, VS Code integration tests, browser harnesses and test ROM generator |
| `site/` | The GitHub Pages site |
| `docs/` | Architecture, protocol, security and licensing notes |

[docs/architecture.md](docs/architecture.md) explains how the pieces fit together.

## Pull requests

Keep changes focused, add or update tests, and run the checks above before you open a pull request. CI runs the
type check, unit tests, Swift tests and a package build on macOS.
