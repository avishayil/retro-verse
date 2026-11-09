# Changelog

## 0.1.0

First public release.

### Play

- Plays Game Boy Advance games with mGBA and Nintendo DS games with melonDS, both compiled to WebAssembly and
  running inside VS Code.
- Plays Nintendo Switch games with a separately installed Eden on macOS. A capture agent streams Eden's window and
  audio into VS Code as H.264 and sends keyboard and gamepad input back to Eden, using Eden's own key bindings.
- Games open in a RetroVerse section of the Explorer, below the file tree. They can also open in an editor tab.
- One keyboard layout for every system, based on desktop GBA emulators. Arrow keys move, X and Z are A and B,
  Enter is Start and Backspace is Select. Standard gamepads work without setup.
- Turbo: hold Tab, or press Shift+Tab to toggle it. GBA and DS run at 2 to 8 times speed; Switch uses Eden's
  turbo setting.
- GBA and DS battery saves, quick save and quick load, and screenshots, stored per game by content hash.
- Switch support for Eden's GDB stub, MoltenVK stability settings, and moving Eden's window to a free display so
  macOS keeps drawing it.

### Security

- The player webview cannot read any user files. Game files are streamed to it, and a strict Content Security
  Policy limits scripts, styles and connections to the extension's own folders and, for Switch, the capture
  agent's exact port.
- Settings that choose programs, arguments, environment variables or file locations are ignored in workspace
  settings, so a cloned repository cannot set them.
- Executables must be owned by you or root and must not be writable by others. Helper tools run by absolute path,
  and Eden and the capture agent get filtered environments.
- The capture agent runs with the macOS hardened runtime and receives its session token over stdin. Its
  WebSocket accepts only VS Code webviews presenting the token, limits unauthenticated connections and input
  rate, and closes connections that send malformed frames.
- Save folders and files are readable only by you, and log output hides game paths and the home directory.
- RetroVerse warns when Eden's GDB stub is enabled, because Eden exposes it to the local network.
- Releases include SHA256SUMS and build provenance attestations. CI pins every GitHub Action by commit SHA,
  installs without lifecycle scripts, checks npm signatures and advisories, verifies pinned hashes of the emulator
  cores, and runs CodeQL.
