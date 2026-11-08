import type { Button } from '../../protocol/types';
import type { InputSnapshot } from '../input/InputManager';
import type { BackendHooks, PlayerBackend } from './Backend';

/** RetroArch/libretro emscripten module surface (EmulatorJS core build). */
interface RetroModule {
  FS: {
    mkdir(p: string): void;
    writeFile(p: string, d: Uint8Array | string): void;
    readFile(p: string): Uint8Array;
    unlink(p: string): void;
    stat(p: string): unknown;
    analyzePath(p: string): { exists: boolean };
  };
  HEAPU8: Uint8Array;
  cwrap(name: string, ret: string | null, args: string[]): (...a: unknown[]) => unknown;
  callMain(args: string[]): void;
  resumeMainLoop(): void;
  AL?: { currentCtx?: { audioCtx?: AudioContext; sources?: Record<string, { gain: GainNode }> | Map<string, { gain: GainNode }> } };
}

type Runtime = (opts: Record<string, unknown>) => Promise<RetroModule>;

/** libretro RetroPad indices used by simulate_input. */
const RETROPAD: Partial<Record<Button, number>> = {
  B: 0, Y: 1, Select: 2, Start: 3, Up: 4, Down: 5, Left: 6, Right: 7, A: 8, X: 9, L: 10, R: 11,
};

const ROM_PATH = '/game.nds';
const CFG_PATH = '/home/web_user/.config/retroarch/retroarch.cfg';

function retroarchCfg(): string {
  return [
    'savefile_directory = "/data/saves"',
    'savestate_directory = "/data/states"',
    'screenshot_directory = "/"',
    'autosave_interval = 0',
    'block_sram_overwrite = false',
    'video_gpu_screenshot = false',
    'audio_latency = 64',
    'video_vsync = true',
    'video_smooth = false',
    'input_auto_game_focus = 1',
    'menu_driver = "null"',
    'savestate_auto_save = false',
    'savestate_auto_load = false',
    'config_save_on_exit = false',
    // RetroArch hotkeys must not collide with game keys; keyboard game input is disabled below anyway.
    'input_exit_emulator = "nul"',
    'input_menu_toggle = "nul"',
    'input_toggle_fullscreen = "nul"',
    '',
  ].join('\n');
}

function coreOptions(layout: string): string {
  const opts: Record<string, string> = {
    melonds_screen_layout: layout,
    melonds_touch_mode: 'Mouse',
    melonds_boot_directly: 'enabled',
    melonds_console_mode: 'DS',
    melonds_screen_gap: '0',
  };
  return Object.entries(opts).map(([k, v]) => `${k} = "${v.replace(/"/g, '')}"`).join('\n') + '\n';
}

function writeDeep(fs: RetroModule['FS'], path: string, data: Uint8Array | string): void {
  let cur = '';
  const parts = path.split('/').filter(Boolean);
  for (const part of parts.slice(0, -1)) {
    cur += '/' + part;
    try {
      fs.mkdir(cur);
    } catch {
      /* exists */
    }
  }
  fs.writeFile(path, data);
}

function loadClassicScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load the NDS core.'));
    document.head.appendChild(s);
  });
}

export class NdsBackend implements PlayerBackend {
  readonly kind = 'nds';
  private mod: RetroModule | undefined;
  private canvas: HTMLCanvasElement | undefined;
  private fn: Record<string, (...a: unknown[]) => unknown> = {};
  private pressed = new Set<Button>();
  private lastSave: Uint8Array | undefined;
  private saveTimer: number | undefined;
  private statsTimer: number | undefined;
  private lastFrame = 0;
  private paused = false;

  constructor(
    private readonly init: { coreJsUrl: string; coreWasmUrl: string; romUrl: string; battery?: Uint8Array; resumeState?: Uint8Array },
    private readonly hooks: BackendHooks,
    private volume: number,
    private layout: string,
  ) {}

  async mount(stage: HTMLElement): Promise<void> {
    const canvas = document.createElement('canvas');
    canvas.id = 'canvas'; // RetroArch's emscripten input driver looks this up
    canvas.className = 'screen';
    canvas.dataset.aspect = this.layout.includes('Left') || this.layout.includes('Right') ? '512/192' : this.layout.includes('Only') ? '256/192' : '256/384';
    canvas.width = 256;
    canvas.height = 384;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    stage.appendChild(canvas);
    this.canvas = canvas;

    const w = window as unknown as { EJS_Runtime?: Runtime };
    const [rom] = await Promise.all([
      fetch(this.init.romUrl).then((r) => {
        if (!r.ok) throw new Error(`Could not read the game file (${r.status}).`);
        return r.arrayBuffer();
      }),
      w.EJS_Runtime ? Promise.resolve() : loadClassicScript(this.init.coreJsUrl),
    ]);
    if (!w.EJS_Runtime) throw new Error('NDS core did not initialise.');

    const layout = this.layout;
    const mod = await w.EJS_Runtime({
      noInitialRun: true,
      arguments: [],
      preRun: [],
      postRun: [],
      canvas,
      parent: stage, // the RetroArch emscripten input driver resolves '!parent' to this element
      callbacks: {
        setupCoreSettingFile: (filePath: string) => writeDeep(mod.FS, filePath, coreOptions(layout)),
      },
      print: () => undefined,
      printErr: (m: string) => /error|fail/i.test(m) && console.warn('[melonDS]', m),
      totalDependencies: 0,
      locateFile: (f: string) => (f.endsWith('.wasm') ? this.init.coreWasmUrl : f),
      getSavExt: () => '.sav',
    });
    this.mod = mod;
    const c = (n: string, r: string | null, a: string[]) => (this.fn[n] = mod.cwrap(n, r, a));
    c('system_restart', '', []);
    c('save_state_info', 'string', []);
    c('load_state', 'number', ['string', 'number']);
    c('cmd_take_screenshot', '', []);
    c('simulate_input', 'null', ['number', 'number', 'number']);
    c('toggleMainLoop', 'null', ['number']);
    c('ejs_set_variable', 'null', ['string', 'string']);
    c('save_file_path', 'string', []);
    c('cmd_savefiles', '', []);
    c('refresh_save_files', 'null', []);
    c('get_current_frame_count', 'number', []);
    c('ejs_set_keyboard_enabled', 'null', ['number']);
    c('toggle_fastforward', 'null', ['number']);
    c('set_ff_ratio', 'null', ['number']);

    writeDeep(mod.FS, CFG_PATH, retroarchCfg());
    writeDeep(mod.FS, '/data/saves/.keep', '');
    writeDeep(mod.FS, '/data/states/.keep', '');
    writeDeep(mod.FS, ROM_PATH, new Uint8Array(rom));
    if (this.init.battery?.byteLength) {
      writeDeep(mod.FS, '/data/saves/game.sav', this.init.battery);
      this.lastSave = this.init.battery;
    }

    mod.callMain([ROM_PATH]);
    mod.resumeMainLoop();
    this.fn.ejs_set_keyboard_enabled(0); // input comes from InputManager via simulate_input
    this.setVolume(this.volume);

    if (this.init.resumeState?.byteLength) {
      // Give the core a moment to finish loading before restoring.
      window.setTimeout(() => void this.loadState(9, this.init.resumeState!).catch(() => this.hooks.toast('warn', 'Could not restore the suspended session.')), 500);
    }

    // RetroArch does not tell us when SRAM changes, so poll and send only on change.
    this.saveTimer = window.setInterval(() => void this.flush(), 5000);
    this.statsTimer = window.setInterval(() => {
      const f = Number(this.fn.get_current_frame_count());
      this.hooks.onStats({ fps: Math.max(0, f - this.lastFrame) });
      this.lastFrame = f;
      this.setVolume(this.volume); // OpenAL sources are created lazily
    }, 1000);

    const ctx = mod.AL?.currentCtx?.audioCtx;
    if (ctx && ctx.state !== 'running') this.hooks.needsGesture(async () => void (await ctx.resume()));
    else if (!ctx) {
      // OpenAL context may be created lazily; check again shortly.
      window.setTimeout(() => {
        const late = mod.AL?.currentCtx?.audioCtx;
        if (late && late.state !== 'running') this.hooks.needsGesture(async () => void (await late.resume()));
      }, 1000);
    }
    this.hooks.onStatus('running');
  }

  setInput(s: InputSnapshot): void {
    if (!this.mod) return;
    for (const b of this.pressed) if (!s.buttons.has(b) && RETROPAD[b] !== undefined) this.fn.simulate_input(0, RETROPAD[b], 0);
    for (const b of s.buttons) if (!this.pressed.has(b) && RETROPAD[b] !== undefined) this.fn.simulate_input(0, RETROPAD[b], 1);
    this.pressed = new Set(s.buttons);
  }

  async flush(): Promise<void> {
    const mod = this.mod;
    if (!mod) return;
    this.fn.cmd_savefiles();
    const p = String(this.fn.save_file_path() ?? '');
    if (!p || !mod.FS.analyzePath(p).exists) return;
    const data = mod.FS.readFile(p);
    if (!data.byteLength || (this.lastSave && equal(this.lastSave, data))) return;
    this.lastSave = new Uint8Array(data);
    this.hooks.onBattery(this.lastSave);
  }

  async pause(): Promise<void> {
    if (!this.mod || this.paused) return;
    this.fn.toggleMainLoop(0);
    this.paused = true;
    await this.flush();
    this.hooks.onStatus('paused');
  }

  async resume(): Promise<void> {
    if (!this.mod || !this.paused) return;
    this.fn.toggleMainLoop(1);
    this.paused = false;
    this.hooks.onStatus('running');
  }

  async reset(): Promise<void> {
    await this.flush();
    this.fn.system_restart?.();
    if (this.paused) await this.resume();
  }

  async saveState(): Promise<Uint8Array> {
    const mod = this.mod;
    if (!mod) throw new Error('Game not running.');
    const [size, ptr, ok] = String(this.fn.save_state_info()).split('|');
    if (ok !== '1') throw new Error(`melonDS could not create a save state (${size}).`);
    const start = parseInt(ptr, 10);
    return new Uint8Array(mod.HEAPU8.subarray(start, start + parseInt(size, 10)));
  }

  async loadState(_slot: number, data: Uint8Array): Promise<void> {
    const mod = this.mod;
    if (!mod) throw new Error('Game not running.');
    try {
      mod.FS.unlink('/game.state');
    } catch {
      /* none */
    }
    mod.FS.writeFile('/game.state', data);
    this.fn.load_state('game.state', 0);
  }

  async screenshot(): Promise<Uint8Array> {
    const mod = this.mod;
    if (!mod) throw new Error('Game not running.');
    try {
      mod.FS.unlink('/screenshot.png');
    } catch {
      /* none */
    }
    this.fn.cmd_take_screenshot();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if (mod.FS.analyzePath('/screenshot.png').exists) return new Uint8Array(mod.FS.readFile('/screenshot.png'));
    }
    throw new Error('Screenshot timed out.');
  }

  readonly supportsTurbo = true;

  setTurbo(on: boolean, speed: number): void {
    if (!this.mod) return;
    // RetroArch fast-forward: ratio is the maximum speed multiplier while active.
    this.fn.set_ff_ratio?.(Math.max(2, Math.min(8, speed)));
    this.fn.toggle_fastforward?.(on ? 1 : 0);
  }

  setLayout(layout: string): void {
    this.layout = layout;
    this.fn.ejs_set_variable?.('melonds_screen_layout', layout);
    if (this.canvas) this.canvas.dataset.aspect = layout.includes('Left') || layout.includes('Right') ? '512/192' : layout.includes('Only') ? '256/192' : '256/384';
  }

  setVolume(percent: number): void {
    this.volume = percent;
    const sources = this.mod?.AL?.currentCtx?.sources;
    if (!sources) return;
    const v = Math.max(0, Math.min(1, percent / 100));
    const list = sources instanceof Map ? [...sources.values()] : Object.values(sources);
    for (const s of list) s.gain.gain.value = v;
  }

  async dispose(): Promise<void> {
    window.clearInterval(this.saveTimer);
    window.clearInterval(this.statsTimer);
    await this.flush().catch(() => undefined);
    try {
      this.fn.toggleMainLoop?.(0);
      void this.mod?.AL?.currentCtx?.audioCtx?.close();
    } catch {
      /* best effort */
    }
    this.mod = undefined;
    this.canvas?.remove();
  }
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
