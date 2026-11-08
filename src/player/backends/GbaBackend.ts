import type { Button } from '../../protocol/types';
import type { InputSnapshot } from '../input/InputManager';
import type { BackendHooks, PlayerBackend } from './Backend';

/** Subset of the @thenick775/mgba-wasm@1.1.1 module surface we use. */
interface MgbaModule {
  FS: {
    mkdir(p: string): void;
    writeFile(p: string, d: Uint8Array): void;
    readFile(p: string): Uint8Array;
    readdir(p: string): string[];
    unlink(p: string): void;
    analyzePath(p: string): { exists: boolean };
  };
  loadGame(path: string): boolean;
  getSave(): Uint8Array;
  saveState(slot: number): boolean;
  loadState(slot: number): boolean;
  pauseGame(): void;
  resumeGame(): void;
  quickReload(): void;
  quitGame(): void;
  setVolume(v: number): void;
  setFastForwardMultiplier(multiplier: number): void;
  toggleInput(enabled: boolean): void;
  buttonPress(name: string): void;
  buttonUnpress(name: string): void;
  screenshot(fileName?: string): boolean;
  addCoreCallbacks(cb: { saveDataUpdatedCallback?: (() => void) | null; videoFrameEndedCallback?: (() => void) | null; coreCrashedCallback?: (() => void) | null }): void;
  saveName?: string;
  gameName?: string;
  SDL2?: { audioContext?: AudioContext };
}

type Factory = (opts: { canvas: HTMLCanvasElement }) => Promise<MgbaModule>;

const GBA_KEYS: Partial<Record<Button, string>> = {
  A: 'a', B: 'b', L: 'l', R: 'r', Start: 'start', Select: 'select', Up: 'up', Down: 'down', Left: 'left', Right: 'right',
};

function mkdirp(fs: MgbaModule['FS'], p: string): void {
  let cur = '';
  for (const part of p.split('/').filter(Boolean)) {
    cur += '/' + part;
    try {
      fs.mkdir(cur);
    } catch {
      /* exists */
    }
  }
}

export class GbaBackend implements PlayerBackend {
  readonly kind = 'gba';
  private mod: MgbaModule | undefined;
  private canvas: HTMLCanvasElement | undefined;
  private pressed = new Set<Button>();
  private saveTimer: number | undefined;
  private frames = 0;
  private statsTimer: number | undefined;
  private paused = false;
  private gamePath = '';

  constructor(
    private readonly init: { coreJsUrl: string; romUrl: string; romName: string; battery?: Uint8Array; resumeState?: Uint8Array },
    private readonly hooks: BackendHooks,
    private volume: number,
  ) {}

  async mount(stage: HTMLElement): Promise<void> {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 160;
    canvas.className = 'screen pixelated';
    canvas.dataset.aspect = '240/160';
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    stage.appendChild(canvas);
    this.canvas = canvas;

    const [factory, rom] = await Promise.all([
      import(/* webpackIgnore: true */ this.init.coreJsUrl).then((m: { default: Factory }) => m.default),
      fetch(this.init.romUrl).then((r) => {
        if (!r.ok) throw new Error(`Could not read the game file (${r.status}).`);
        return r.arrayBuffer();
      }),
    ]);
    const mod = await factory({ canvas });
    this.mod = mod;

    // MEMFS only: the extension host is the source of truth for saves (webview IndexedDB origins are not stable).
    for (const d of ['/data/games', '/data/saves', '/data/states', '/data/screenshots', '/data/cheats', '/data/patches']) mkdirp(mod.FS, d);
    const base = this.init.romName.replace(/\.[^.]+$/, '');
    this.gamePath = `/data/games/${this.init.romName}`;
    mod.FS.writeFile(this.gamePath, new Uint8Array(rom));
    if (this.init.battery?.byteLength) mod.FS.writeFile(`/data/saves/${base}.sav`, this.init.battery);

    if (!mod.loadGame(this.gamePath)) throw new Error('mGBA could not load this game.');
    // Callbacks attach to the core instance created by loadGame, so register them afterwards.
    mod.addCoreCallbacks({
      saveDataUpdatedCallback: () => this.scheduleFlush(),
      videoFrameEndedCallback: () => void this.frames++,
      coreCrashedCallback: () => this.hooks.onStatus('error', 'The GBA core crashed.'),
    });
    mod.toggleInput(false); // our InputManager owns keyboard + gamepad
    this.setVolume(this.volume);

    if (this.init.resumeState?.byteLength) {
      await this.loadState(9, this.init.resumeState).catch(() => this.hooks.toast('warn', 'Could not restore the suspended session.'));
    }

    this.statsTimer = window.setInterval(() => {
      this.hooks.onStats({ fps: this.frames });
      this.frames = 0;
    }, 1000);

    const ctx = mod.SDL2?.audioContext;
    if (ctx && ctx.state !== 'running') this.hooks.needsGesture(async () => void (await ctx.resume()));
    this.hooks.onStatus('running');
  }

  setInput(s: InputSnapshot): void {
    const mod = this.mod;
    if (!mod) return;
    for (const b of this.pressed) if (!s.buttons.has(b) && GBA_KEYS[b]) mod.buttonUnpress(GBA_KEYS[b]!);
    for (const b of s.buttons) if (!this.pressed.has(b) && GBA_KEYS[b]) mod.buttonPress(GBA_KEYS[b]!);
    this.pressed = new Set(s.buttons);
  }

  private scheduleFlush(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flush(), 750);
  }

  async flush(): Promise<void> {
    window.clearTimeout(this.saveTimer);
    const mod = this.mod;
    if (!mod?.saveName || !mod.FS.analyzePath(mod.saveName).exists) return;
    const data = mod.getSave();
    if (data?.byteLength) this.hooks.onBattery(new Uint8Array(data));
  }

  async pause(): Promise<void> {
    if (!this.mod || this.paused) return;
    this.mod.pauseGame();
    this.paused = true;
    await this.flush();
    this.hooks.onStatus('paused');
  }

  async resume(): Promise<void> {
    if (!this.mod || !this.paused) return;
    this.mod.resumeGame();
    this.paused = false;
    this.hooks.onStatus('running');
  }

  async reset(): Promise<void> {
    await this.flush();
    this.mod?.quickReload();
    if (this.paused) await this.resume();
  }

  private findState(slot: number): string | undefined {
    const files = this.mod!.FS.readdir('/data/states');
    return files.find((f) => f.endsWith(`.ss${slot}`)) ? `/data/states/${files.find((f) => f.endsWith(`.ss${slot}`))}` : undefined;
  }

  private statePath(slot: number): string {
    const base = this.init.romName.replace(/\.[^.]+$/, '');
    return `/data/states/${base}.ss${slot}`;
  }

  async saveState(slot: number): Promise<Uint8Array> {
    const mod = this.mod;
    if (!mod) throw new Error('Game not running.');
    if (!mod.saveState(slot)) throw new Error('mGBA could not create a save state.');
    const p = this.findState(slot);
    if (!p) throw new Error('Save state file not found.');
    return new Uint8Array(mod.FS.readFile(p));
  }

  async loadState(slot: number, data: Uint8Array): Promise<void> {
    const mod = this.mod;
    if (!mod) throw new Error('Game not running.');
    const p = this.findState(slot) ?? this.statePath(slot);
    mod.FS.writeFile(p, data);
    if (!mod.loadState(slot)) throw new Error('mGBA could not load the save state.');
  }

  async screenshot(): Promise<Uint8Array> {
    const mod = this.mod;
    if (!mod) throw new Error('Game not running.');
    const name = `shot-${Date.now()}.png`;
    if (!mod.screenshot(name)) throw new Error('Screenshot failed.');
    const p = `/data/screenshots/${name}`;
    const data = new Uint8Array(mod.FS.readFile(p));
    mod.FS.unlink(p);
    return data;
  }

  readonly supportsTurbo = true;

  setTurbo(on: boolean, speed: number): void {
    // mGBA runs `multiplier` emulated frames per displayed frame; audio stays in sync (sped up).
    this.mod?.setFastForwardMultiplier(on ? Math.max(2, Math.min(8, Math.round(speed))) : 1);
  }

  setVolume(percent: number): void {
    this.volume = percent;
    // mGBA wasm's setVolume takes a 0..1 multiplier.
    this.mod?.setVolume(Math.max(0, Math.min(1, percent / 100)));
  }

  async dispose(): Promise<void> {
    window.clearInterval(this.statsTimer);
    await this.flush().catch(() => undefined);
    try {
      this.mod?.pauseGame();
      void this.mod?.SDL2?.audioContext?.close();
    } catch {
      /* best effort */
    }
    this.mod = undefined;
    this.canvas?.remove();
  }
}
