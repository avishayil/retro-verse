import type { BackendInit, HostToPlayer, InitPayload, PlayerAction, PlayerCommand, PlayerSettings } from '../protocol/messages';
import type { Capabilities, StreamTelemetry } from '../protocol/types';
import type { BackendHooks, PlayerBackend } from './backends/Backend';
import { GbaBackend } from './backends/GbaBackend';
import { ErrorBackend, ExternalBackend, SetupBackend } from './backends/InfoBackends';
import { NdsBackend } from './backends/NdsBackend';
import { StreamBackend } from './backends/StreamBackend';
import { InputManager, type InputSnapshot } from './input/InputManager';
import { keyLabel, resolveKeyTable, SWITCH_STICK_KEYS } from './input/maps';
import { PLATFORM_BUTTONS, type Button } from '../protocol/types';
import { host } from './transport/hostChannel';
import { RomReceiver } from './transport/romReceiver';
import { button, el } from './ui/dom';
import { Toolbar } from './ui/Toolbar';

const SUSPEND_SLOT = 9;

class App {
  private readonly root = document.getElementById('app')!;
  private init: InitPayload | undefined;
  private settings: PlayerSettings | undefined;
  private backend: PlayerBackend | undefined;
  private backendKey = '';
  private input: InputManager | undefined;
  private toolbar: Toolbar | undefined;
  private stage!: HTMLElement;
  private statsEl!: HTMLElement;
  private toasts!: HTMLElement;
  private overlay: HTMLElement | undefined;
  private muted = false;
  private autoPaused = false;
  private showStats = false;
  private turboHeld = false;
  private turboToggled = false;
  private lastStats: StreamTelemetry = { fps: 0 };
  private remoteStats: StreamTelemetry | undefined;
  private mountChain: Promise<void> = Promise.resolve();
  private resizeObs = new ResizeObserver(() => this.layout());

  start(): void {
    host.onMessage((m) => void this.onMessage(m));
    document.addEventListener('visibilitychange', () => void this.onVisibility());
    window.addEventListener('blur', () => {
      if (this.settings?.pauseOnBlur && this.init?.capabilities.pause) void this.autoPause();
    });
    window.addEventListener('focus', () => {
      if (this.settings?.pauseOnBlur) void this.autoResume();
    });
    host.post('ready', { protocol: 1 });
  }

  private async onMessage(m: HostToPlayer): Promise<void> {
    switch (m.type) {
      case 'init':
        await this.applyInit(m.payload);
        break;
      case 'backend':
        if (this.init) this.queueBackend(m.payload);
        break;
      case 'command':
        await this.onCommand(m.payload.command, m.id, m.payload.slot, m.payload.data);
        break;
      case 'status':
        this.toolbar?.setStatus(m.payload.status, m.payload.detail);
        if (m.payload.capabilities) this.setCapabilities(m.payload.capabilities);
        break;
      case 'settings':
        this.applySettings(m.payload);
        break;
      case 'telemetry':
        this.remoteStats = m.payload;
        this.renderStats();
        break;
      case 'toast':
        this.toast(m.payload.level, m.payload.message);
        break;
      case 'notice':
        this.setNotice(m.payload.text);
        break;
      case 'rom.chunk':
        if (this.rom && !this.rom.push(m.payload)) this.rom = undefined;
        break;
    }
  }

  private async applyInit(p: InitPayload): Promise<void> {
    await this.teardownBackend();
    this.input?.dispose();
    this.init = p;
    this.settings = p.settings;
    this.showStats = p.settings.showStats;
    this.root.replaceChildren();
    this.toolbar = new Toolbar(p.platform, p.title, p.capabilities, {
      action: (a) => void this.onAction(a),
      toggleMute: () => this.toggleMute(),
      toggleStats: () => {
        this.showStats = !this.showStats;
        this.renderStats();
      },
      toggleFullscreen: () => document.body.classList.toggle('immersive'),
      screenshot: () => void this.onCommand('screenshot'),
      help: () => this.showHelp(),
      toggleTurbo: () => {
        this.turboToggled = !this.turboToggled;
        this.applyTurbo();
      },
    });
    this.stage = el('div', { class: `stage scale-${p.settings.scale}`, attrs: { tabindex: '0', 'aria-label': 'Game screen' } });
    this.statsEl = el('div', { class: 'stats', attrs: { 'aria-live': 'off' } });
    this.toasts = el('div', { class: 'toasts', attrs: { 'aria-live': 'polite' } });
    const exitImmersive = button('Exit full view', () => document.body.classList.remove('immersive'), { icon: '⤡' });
    exitImmersive.classList.add('exit-immersive');
    this.root.append(this.toolbar.root, this.stage, this.statsEl, this.toasts, exitImmersive);
    this.stage.addEventListener('pointerdown', () => this.stage.focus());
    this.resizeObs.disconnect();
    this.resizeObs.observe(this.stage);
    this.turboHeld = false;
    this.turboToggled = false;
    this.input = new InputManager(p.platform, p.settings.keyboard, (s) => this.onInput(s), (h) => {
      if (h === 'turboHoldOn') this.turboHeld = true;
      else if (h === 'turboHoldOff') this.turboHeld = false;
      else this.turboToggled = !this.turboToggled;
      this.applyTurbo();
    });
    this.renderStats();
    this.queueBackend(p.backend);
    this.stage.focus();
  }

  private applySettings(s: PlayerSettings): void {
    const prev = this.settings;
    this.settings = s;
    this.input?.setOverrides(s.keyboard);
    if (!this.muted) this.backend?.setVolume(s.volume);
    this.stage.className = `stage scale-${s.scale}`;
    if (prev?.showStats !== s.showStats) this.showStats = s.showStats;
    if (this.backend instanceof NdsBackend && prev?.ndsScreenLayout !== s.ndsScreenLayout) this.backend.setLayout(s.ndsScreenLayout);
    this.applyTurbo();
    this.layout();
    this.renderStats();
  }

  private setCapabilities(c: Capabilities): void {
    if (this.init) this.init.capabilities = c;
    this.toolbar?.setCapabilities(c);
  }

  /** Backends are swapped strictly in order so a fast sequence of updates cannot interleave mounts. */
  private queueBackend(b: BackendInit): void {
    const key = JSON.stringify(b, (k, v) => (v instanceof Uint8Array ? `bytes:${v.byteLength}` : v));
    if (key === this.backendKey) return;
    this.backendKey = key;
    this.mountChain = this.mountChain.then(() => this.mountBackend(b)).catch((e) => this.fail(e));
  }

  private rom: RomReceiver | undefined;

  private hooks(): BackendHooks {
    return {
      loadRom: (size) => {
        this.rom?.cancel();
        const rx = new RomReceiver(size);
        this.rom = rx;
        host.post('rom.request', {});
        return rx.done;
      },
      onBattery: (data) => host.post('save.battery', { data }),
      onStatus: (status, detail) => {
        host.post('status', { status, detail });
        this.toolbar?.setStatus(status, detail);
      },
      onStats: (s) => {
        this.lastStats = s;
        this.renderStats();
      },
      needsGesture: (resume) => this.showGestureOverlay(resume),
      toast: (level, message) => this.toast(level, message),
    };
  }

  private async mountBackend(b: BackendInit): Promise<void> {
    await this.teardownBackend();
    const s = this.settings!;
    const act = (a: PlayerAction) => void this.onAction(a);
    const vol = this.muted ? 0 : s.volume;
    let backend: PlayerBackend;
    switch (b.kind) {
      case 'gba':
        backend = new GbaBackend(b, this.hooks(), vol);
        break;
      case 'nds':
        backend = new NdsBackend(b, this.hooks(), vol, s.ndsScreenLayout);
        break;
      case 'stream':
        backend = new StreamBackend(b, this.hooks(), vol);
        break;
      case 'external':
        backend = new ExternalBackend(b.reason, act);
        break;
      case 'setup':
        backend = new SetupBackend(b, act);
        break;
      case 'error':
        backend = new ErrorBackend(b.message, act);
        break;
    }
    this.backend = backend;
    this.stage.dataset.backend = b.kind;
    try {
      await backend.mount(this.stage);
    } catch (e) {
      await this.teardownBackend();
      throw e;
    }
    this.layout();
    this.applyTurbo();
  }

  /** Turbo is on while Tab is held or after a toggle; re-applied after backend swaps and settings changes. */
  private applyTurbo(): void {
    const b = this.backend;
    const on = this.turboHeld || this.turboToggled;
    const speed = this.settings?.turboSpeed ?? 3;
    b?.setTurbo(on, speed);
    const label = this.init?.platform === 'switch' ? '(Eden)' : `×${speed}`;
    this.toolbar?.setTurbo(!!b?.supportsTurbo, on && !!b?.supportsTurbo, label);
  }

  private async teardownBackend(): Promise<void> {
    const b = this.backend;
    this.backend = undefined;
    this.overlay?.remove();
    this.overlay = undefined;
    if (b) await b.dispose().catch(() => undefined);
  }

  private fail(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    host.post('status', { status: 'error', detail: message });
    host.log('error', message);
    this.backendKey = '';
    void this.mountBackend({ kind: 'error', message });
  }

  private onInput(s: InputSnapshot): void {
    // WASM cores consume input in-page; the stream backend sends it straight to the bridge socket.
    this.backend?.setInput(s);
  }

  private async onAction(a: PlayerAction): Promise<void> {
    const local: Partial<Record<PlayerAction, PlayerCommand>> = { pause: 'pause', resume: 'resume', reset: 'reset' };
    // WASM backends handle pause/reset locally for responsiveness; everything else goes to the host.
    if (local[a] && this.init?.platform !== 'switch') return this.onCommand(local[a]!);
    host.post('action', { action: a });
  }

  private async onCommand(command: PlayerCommand, id?: string, slot?: number, data?: Uint8Array): Promise<void> {
    const reply = (ok: boolean, error?: string) => id && host.post('reply', { ok, error }, id);
    const b = this.backend;
    try {
      switch (command) {
        case 'pause':
          this.autoPaused = false;
          await b?.pause();
          break;
        case 'resume':
          this.autoPaused = false;
          await b?.resume();
          break;
        case 'reset':
          await b?.reset();
          break;
        case 'flush':
          await b?.flush();
          break;
        case 'releaseAll':
          this.input?.releaseAll();
          break;
        case 'saveState': {
          if (!b) throw new Error('Nothing is running.');
          const s = slot ?? 0;
          host.post('save.state', { slot: s, data: await b.saveState(s) });
          break;
        }
        case 'loadState':
          if (!b || !data) throw new Error('No state to load.');
          await b.loadState(slot ?? 0, data);
          this.toast('info', `Loaded state from slot ${slot ?? 0}.`);
          break;
        case 'suspend':
          if (b) host.post('save.state', { slot: SUSPEND_SLOT, data: await b.saveState(SUSPEND_SLOT), suspend: true });
          break;
        case 'screenshot':
          if (!b) throw new Error('Nothing is running.');
          host.post('screenshot', { png: await b.screenshot() });
          break;
        case 'stop':
          this.input?.releaseAll();
          await this.teardownBackend();
          this.backendKey = '';
          this.stage.replaceChildren(el('div', { class: 'info-panel' }, [el('h2', { text: 'Stopped' }), el('p', { text: 'The game was stopped. Progress was saved.' }), el('div', { class: 'actions' }, [button('Restart', () => void this.onAction('restart'), { primary: true })])]));
          host.post('status', { status: 'stopped' });
          break;
      }
      reply(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!id) this.toast('error', msg);
      reply(false, msg);
    }
  }

  private async autoPause(): Promise<void> {
    if (!this.backend || this.init?.platform === 'switch') return;
    this.autoPaused = true;
    await this.backend.pause();
  }

  private async autoResume(): Promise<void> {
    if (!this.autoPaused || !this.backend) return;
    this.autoPaused = false;
    await this.backend.resume();
  }

  private async onVisibility(): Promise<void> {
    if (document.hidden) {
      this.input?.releaseAll();
      if (this.backend && this.init?.platform !== 'switch') {
        await this.backend.flush().catch(() => undefined);
        if (this.init?.suspendOnHide) await this.onCommand('suspend');
        await this.autoPause();
      }
    } else {
      await this.autoResume();
      this.stage?.focus();
    }
  }

  private toggleMute(): void {
    this.muted = !this.muted;
    this.backend?.setVolume(this.muted ? 0 : (this.settings?.volume ?? 80));
    this.toolbar?.setMuted(this.muted);
  }

  private showGestureOverlay(resume: () => Promise<void>): void {
    if (this.overlay) return;
    const ov = el('button', { class: 'gesture-overlay', attrs: { type: 'button' } }, [el('span', { text: '▶  Click to enable sound' })]);
    ov.addEventListener('click', async () => {
      await resume().catch(() => undefined);
      ov.remove();
      this.overlay = undefined;
      this.stage.focus();
    });
    this.overlay = ov;
    this.stage.appendChild(ov);
  }

  private showHelp(): void {
    if (!this.init) return;
    // Show the effective table (defaults + user overrides), grouped per button in a stable order.
    const byButton = new Map<Button, string[]>();
    for (const [code, b] of resolveKeyTable(this.init.platform, this.settings?.keyboard ?? {})) byButton.set(b, [...(byButton.get(b) ?? []), keyLabel(code)]);
    const rows = PLATFORM_BUTTONS[this.init.platform].filter((b) => byButton.has(b)).map((b) => el('tr', {}, [el('td', { text: b }), el('td', { text: byButton.get(b)!.join(' / ') })]));
    if (this.init.platform === 'switch') rows.push(el('tr', {}, [el('td', { text: 'Left stick' }), el('td', { text: Object.values(SWITCH_STICK_KEYS).map(keyLabel).join(' ') })]));
    rows.push(el('tr', {}, [el('td', { text: 'Turbo' }), el('td', { text: 'hold Tab · Shift+Tab toggles' })]));
    const dlg = el('div', { class: 'help', attrs: { role: 'dialog' } }, [
      el('h3', { text: 'Controls' }),
      el('table', {}, rows),
      el('p', { text: 'Gamepads (standard mapping) work automatically. Keyboard overrides: setting retroverse.input.keyboard. Click the game to focus it.' }),
      button('Close', () => dlg.remove(), { primary: true }),
    ]);
    if (this.init.platform === 'nds') dlg.insertBefore(el('p', { text: 'Touch screen: click / drag with the mouse on the bottom screen.' }), dlg.lastChild);
    this.root.appendChild(dlg);
  }

  private renderStats(): void {
    if (!this.statsEl) return;
    this.statsEl.hidden = !this.showStats;
    if (!this.showStats) return;
    const s = { ...this.remoteStats, ...this.lastStats };
    const parts = [`${s.fps} fps`];
    if (s.captureMs !== undefined) parts.push(`capture ${s.captureMs} ms`);
    if (s.encodeMs !== undefined) parts.push(`encode ${s.encodeMs} ms`);
    if (s.decodeMs !== undefined) parts.push(`decode ${s.decodeMs} ms`);
    if (s.latencyMs !== undefined) parts.push(`~${s.latencyMs} ms est.`);
    if (s.bitrateKbps !== undefined) parts.push(`${Math.round(s.bitrateKbps)} kbps`);
    if (s.droppedFrames) parts.push(`dropped ${s.droppedFrames}`);
    if (this.input?.gamepadName) parts.push(`🎮 ${this.input.gamepadName.slice(0, 32)}`);
    this.statsEl.textContent = parts.join(' · ');
  }

  /** Size the canvas: fit preserves aspect, integer uses whole multiples (crisp pixels), stretch fills. */
  private layout(): void {
    const canvas = this.stage?.querySelector<HTMLCanvasElement>('canvas.screen');
    if (!canvas) return;
    const [aw, ah] = (canvas.dataset.aspect ?? '4/3').split('/').map(Number);
    const W = this.stage.clientWidth;
    const H = this.stage.clientHeight;
    const mode = this.settings?.scale ?? 'fit';
    let w: number;
    let h: number;
    if (mode === 'stretch') {
      w = W;
      h = H;
    } else {
      let k = Math.min(W / aw, H / ah);
      if (mode === 'integer' && this.init?.platform !== 'switch' && k >= 1) k = Math.floor(k);
      w = Math.floor(aw * k);
      h = Math.floor(ah * k);
    }
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }

  private noticeEl: HTMLElement | undefined;

  private setNotice(text: string | null): void {
    if (!text) {
      this.noticeEl?.remove();
      this.noticeEl = undefined;
      return;
    }
    this.noticeEl ??= el('div', { class: 'notice', attrs: { role: 'status' } });
    this.noticeEl.textContent = text;
    if (!this.noticeEl.isConnected) this.stage?.appendChild(this.noticeEl);
  }

  private toast(level: 'info' | 'warn' | 'error', message: string): void {
    if (!this.toasts) return;
    const t = el('div', { class: `toast ${level}`, text: message });
    this.toasts.appendChild(t);
    setTimeout(() => t.remove(), level === 'error' ? 8000 : 4000);
  }
}

new App().start();
