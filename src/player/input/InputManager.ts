import { PLATFORM_BUTTONS, ZERO_AXES, type Axes, type Button, type Platform } from '../../protocol/types';
import { resolveKeyTable, TURBO_KEY, STANDARD_GAMEPAD, STICK_DEADZONE, STICK_DPAD_THRESHOLD, SWITCH_STICK_KEYS } from './maps';

export interface InputSnapshot {
  buttons: ReadonlySet<Button>;
  axes: Axes;
}

export type Hotkey = 'turboHoldOn' | 'turboHoldOff' | 'turboToggle';

export function deadzone(v: number): number {
  if (Math.abs(v) < STICK_DEADZONE) return 0;
  return Math.sign(v) * Math.min(1, (Math.abs(v) - STICK_DEADZONE) / (1 - STICK_DEADZONE));
}

/**
 * Merges keyboard + Gamepad API into full snapshots, emitted only on change.
 * Everything is released on blur, tab hide, gamepad disconnect, or dispose.
 */
export class InputManager {
  private readonly keysDown = new Set<string>();
  private keyToButton = new Map<string, Button>();
  private allowed: ReadonlySet<Button>;
  private last = '';
  private raf = 0;
  private enabled = true;
  private readonly ac = new AbortController();
  gamepadName: string | undefined;
  private turboHeld = false;

  constructor(
    private readonly platform: Platform,
    overrides: Record<string, string>,
    private readonly onChange: (s: InputSnapshot) => void,
    private readonly onHotkey: (h: Hotkey) => void = () => undefined,
  ) {
    this.allowed = new Set(PLATFORM_BUTTONS[platform]);
    this.setOverrides(overrides);
    const opts = { signal: this.ac.signal };
    window.addEventListener('keydown', (e) => this.onKey(e, true), opts);
    window.addEventListener('keyup', (e) => this.onKey(e, false), opts);
    window.addEventListener('blur', () => this.releaseAll(), opts);
    document.addEventListener('visibilitychange', () => document.hidden && this.releaseAll(), opts);
    window.addEventListener('gamepaddisconnected', () => this.releaseAll(), opts);
    const loop = () => {
      this.poll();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  setOverrides(overrides: Record<string, string>): void {
    this.keyToButton = resolveKeyTable(this.platform, overrides);
  }

  /** Disable while modal UI (e.g. setup screens) has focus. Disabling releases everything. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.releaseAll();
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (!this.enabled) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return; // leave VS Code shortcuts alone
    if (e.code === TURBO_KEY) {
      // Tab must never move focus out of the game.
      e.preventDefault();
      if (e.repeat) return;
      if (e.shiftKey) {
        if (down) this.onHotkey('turboToggle');
      } else if (down !== this.turboHeld) {
        this.turboHeld = down;
        this.onHotkey(down ? 'turboHoldOn' : 'turboHoldOff');
      }
      return;
    }
    const mapped = this.keyToButton.has(e.code) || (this.platform === 'switch' && Object.values(SWITCH_STICK_KEYS).includes(e.code as never));
    if (!mapped) return;
    e.preventDefault();
    if (down) this.keysDown.add(e.code);
    else this.keysDown.delete(e.code);
    this.poll();
  }

  releaseAll(): void {
    this.keysDown.clear();
    if (this.turboHeld) {
      this.turboHeld = false;
      this.onHotkey('turboHoldOff');
    }
    this.emit({ buttons: new Set(), axes: { ...ZERO_AXES } }, true);
  }

  private poll(): void {
    if (!this.enabled) return;
    const buttons = new Set<Button>();
    for (const code of this.keysDown) {
      const b = this.keyToButton.get(code);
      if (b) buttons.add(b);
    }
    const axes: Axes = { ...ZERO_AXES };
    if (this.platform === 'switch') {
      if (this.keysDown.has(SWITCH_STICK_KEYS.left)) axes.lx -= 1;
      if (this.keysDown.has(SWITCH_STICK_KEYS.right)) axes.lx += 1;
      if (this.keysDown.has(SWITCH_STICK_KEYS.up)) axes.ly -= 1;
      if (this.keysDown.has(SWITCH_STICK_KEYS.down)) axes.ly += 1;
    }
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    this.gamepadName = undefined;
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      this.gamepadName ??= pad.id;
      if (pad.mapping === 'standard') {
        pad.buttons.forEach((btn, i) => {
          const b = STANDARD_GAMEPAD[i];
          if (b && (btn.pressed || btn.value > 0.5)) buttons.add(b);
        });
      }
      const [lx = 0, ly = 0, rx = 0, ry = 0] = pad.axes;
      axes.lx = clamp(axes.lx + deadzone(lx));
      axes.ly = clamp(axes.ly + deadzone(ly));
      axes.rx = clamp(axes.rx + deadzone(rx));
      axes.ry = clamp(axes.ry + deadzone(ry));
    }
    if (this.platform !== 'switch') {
      // Digital-only systems: left stick doubles as d-pad.
      if (axes.lx <= -STICK_DPAD_THRESHOLD) buttons.add('Left');
      if (axes.lx >= STICK_DPAD_THRESHOLD) buttons.add('Right');
      if (axes.ly <= -STICK_DPAD_THRESHOLD) buttons.add('Up');
      if (axes.ly >= STICK_DPAD_THRESHOLD) buttons.add('Down');
    }
    for (const b of [...buttons]) if (!this.allowed.has(b)) buttons.delete(b);
    this.emit({ buttons, axes });
  }

  private emit(s: InputSnapshot, force = false): void {
    const key = [...s.buttons].sort().join(',') + `|${s.axes.lx.toFixed(2)},${s.axes.ly.toFixed(2)},${s.axes.rx.toFixed(2)},${s.axes.ry.toFixed(2)}`;
    if (!force && key === this.last) return;
    this.last = key;
    this.onChange(s);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.releaseAll();
    this.ac.abort();
  }
}

function clamp(v: number): number {
  return Math.max(-1, Math.min(1, v));
}
