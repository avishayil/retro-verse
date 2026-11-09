# Third-party notices

RetroVerse is licensed under the GNU General Public License v3.0 or later (see `LICENSE`). It redistributes the
following components without changes. The build copies them from pinned npm packages into `media/cores/`.

| Component | Version | License | Source |
|---|---|---|---|
| mGBA, WebAssembly build by thenick775 | `@thenick775/mgba-wasm@1.1.1` | MPL-2.0 | https://github.com/thenick775/mgba/tree/feature/wasm (upstream https://github.com/mgba-emu/mgba) |
| melonDS libretro core, EmulatorJS build | `@emulatorjs/core-melonds@4.2.3` (core 2.0.2) | GPL-3.0 | https://github.com/EmulatorJS/melonDS (upstream https://github.com/melonDS-emu/melonDS) |

**mGBA**: copyright © 2013-2023 Jeffrey Pfau and contributors. The files are subject to the terms of the Mozilla
Public License, v. 2.0. The license text is in `licenses/MPL-2.0.txt` and ships next to the core as
`media/cores/mgba/LICENSE`. The source code for these files is available at the URLs above. MPL-2.0 is compatible
with the GPL; the files carry no "Incompatible With Secondary Licenses" notice.

**melonDS**: copyright © melonDS team and contributors, licensed under GPL-3.0. The license text that ships with
the core is in `media/cores/melonds/license.txt` and `licenses/GPL-3.0.txt`. The corresponding source is at the
URLs above.

**eden-bridge** (`bin/`) is RetroVerse code built from `native/eden-bridge/` under GPL-3.0-or-later. It links
only Apple system frameworks.

RetroVerse does not bundle Eden (GPL-3.0-or-later). Eden is a separately installed program that RetroVerse starts
as a child process, and no Eden code is included. No game ROMs, Nintendo firmware, BIOS files or keys are
included or downloaded. The test ROMs under `test/fixtures/` are generated from original code (see
`gen-roms.mjs`).
