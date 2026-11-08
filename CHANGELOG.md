# Changelog

## 0.1.0

First public release.

- Plays Game Boy Advance games with mGBA and Nintendo DS games with melonDS, both compiled to WebAssembly and
  running inside VS Code.
- Plays Nintendo Switch games with a separately installed Eden on macOS. A capture agent streams Eden's window and
  audio into VS Code as H.264 and sends keyboard and gamepad input back to Eden.
- Games open in a RetroVerse section of the Explorer, below the file tree. They can also open in an editor tab.
- One keyboard layout for every system, based on desktop GBA emulators. Arrow keys move, X and Z are A and B,
  Enter is Start and Backspace is Select. Standard gamepads work without setup.
- Turbo: hold Tab, or press Shift+Tab to toggle it. GBA and DS run at 2 to 8 times speed; Switch uses Eden's turbo
  setting.
- GBA and DS battery saves, quick save and quick load, and screenshots, stored per game by content hash.
- Switch support for Eden's GDB stub, MoltenVK stability settings, Eden's own key bindings, and moving Eden's
  window to a free display so macOS keeps drawing it.
