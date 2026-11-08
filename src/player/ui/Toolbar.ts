import type { PlayerAction } from '../../protocol/messages';
import type { Capabilities, Platform, SessionStatus } from '../../protocol/types';
import { button, el } from './dom';

const PLATFORM_LABEL: Record<Platform, string> = { gba: 'GBA', nds: 'NDS', switch: 'SWITCH' };

export interface ToolbarHandlers {
  action(a: PlayerAction): void;
  toggleMute(): void;
  toggleStats(): void;
  toggleFullscreen(): void;
  screenshot(): void;
  help(): void;
  toggleTurbo(): void;
}

export class Toolbar {
  readonly root: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly pauseBtn: HTMLButtonElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly turboBtn: HTMLButtonElement;
  private readonly capButtons: { cap: keyof Capabilities; el: HTMLElement }[] = [];

  constructor(platform: Platform, title: string, caps: Capabilities, h: ToolbarHandlers) {
    this.statusEl = el('span', { class: 'status', text: 'starting' });
    this.pauseBtn = button('Pause', () => h.action(this.pauseBtn.dataset.state === 'paused' ? 'resume' : 'pause'), { icon: '⏸', title: 'Pause / resume' });
    this.muteBtn = button('Mute', () => h.toggleMute(), { icon: '🔊' });
    this.turboBtn = button('Turbo', () => h.toggleTurbo(), { icon: '⏩', title: 'Turbo / fast-forward (hold Tab, Shift+Tab toggles)' });
    this.turboBtn.hidden = true;
    const gated = (cap: keyof Capabilities, b: HTMLElement) => {
      this.capButtons.push({ cap, el: b });
      return b;
    };
    this.root = el('div', { class: 'toolbar', attrs: { role: 'toolbar' } }, [
      el('span', { class: `badge ${platform}`, text: PLATFORM_LABEL[platform] }),
      el('span', { class: 'title', text: title, title }),
      this.statusEl,
      el('span', { class: 'spacer' }),
      gated('pause', this.pauseBtn),
      gated('reset', button('Reset', () => h.action('reset'), { icon: '↺' })),
      this.turboBtn,
      gated('saveStates', button('Save', () => h.action('quickSave'), { icon: '💾', title: 'Quick save state (F5)' })),
      gated('saveStates', button('Load', () => h.action('quickLoad'), { icon: '📂', title: 'Quick load state (F8)' })),
      gated('screenshots', button('Shot', () => h.screenshot(), { icon: '📷', title: 'Screenshot' })),
      gated('audio', this.muteBtn),
      gated('mods', button('Mods', () => h.action('openMods'), { icon: '🧩', title: 'Open mods folder' })),
      button('Saves', () => h.action('openSaves'), { icon: '🗂', title: 'Open saves folder' }),
      button('Stats', () => h.toggleStats(), { icon: '📈', title: 'Toggle performance stats' }),
      button('Keys', () => h.help(), { icon: '⌨', title: 'Controls' }),
      button('Full', () => h.toggleFullscreen(), { icon: '⛶', title: 'Fill the editor' }),
      button('Settings', () => h.action('openSettings'), { icon: '⚙' }),
    ]);
    this.setCapabilities(caps);
  }

  setCapabilities(caps: Capabilities): void {
    // Unsupported features are absent, not merely disabled (e.g. no save-state buttons for Switch).
    for (const { cap, el: e } of this.capButtons) e.hidden = !caps[cap];
  }

  setStatus(s: SessionStatus, detail?: string): void {
    this.statusEl.textContent = s;
    this.statusEl.dataset.status = s;
    this.statusEl.title = detail ?? '';
    const paused = s === 'paused';
    this.pauseBtn.dataset.state = paused ? 'paused' : 'running';
    this.pauseBtn.querySelector('.label')!.textContent = paused ? 'Resume' : 'Pause';
    this.pauseBtn.querySelector('.codicon-text')!.textContent = paused ? '▶' : '⏸';
  }

  /** `label` e.g. "×3"; hidden when the backend has no turbo. */
  setTurbo(available: boolean, on: boolean, label: string): void {
    this.turboBtn.hidden = !available;
    this.turboBtn.classList.toggle('active', on);
    this.turboBtn.setAttribute('aria-pressed', String(on));
    this.turboBtn.querySelector('.label')!.textContent = on ? `Turbo ${label}` : 'Turbo';
  }

  setMuted(m: boolean): void {
    this.muteBtn.querySelector('.label')!.textContent = m ? 'Unmute' : 'Mute';
    this.muteBtn.querySelector('.codicon-text')!.textContent = m ? '🔇' : '🔊';
  }
}
