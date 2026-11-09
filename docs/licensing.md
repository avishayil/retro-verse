# Licensing

RetroVerse is licensed under the GPL-3.0-or-later. That is required because it redistributes the GPL-3.0 melonDS
core, and it matches Eden's license.

mGBA's files are MPL-2.0, which is compatible with the GPL. They are redistributed without changes, together with
the MPL-2.0 text and the source location listed in `THIRD_PARTY_NOTICES.md`.

Eden is not redistributed. It is a separately installed program that RetroVerse starts as a child process and
controls only through its command line, operating system signals, its GDB stub and synthetic key events.

No code from goudreinette/nds-emulator-vscode or Desmond is used. The RetroArch start-up sequence in `NdsBackend`
was written independently after reading EmulatorJS's GPL-3.0 `GameManager.js`, which is license compatible.

## Release checklist

1. `licenses/MPL-2.0.txt` is present. The release workflow fails without it.
2. The VSIX contains `LICENSE`, `THIRD_PARTY_NOTICES.md`, `licenses/`, `media/cores/mgba/LICENSE` and
   `media/cores/melonds/license.txt`.
3. The tagged commit is public on GitHub, which provides the corresponding source for that VSIX, including
   `native/eden-bridge`.
