import type { StreamTelemetry } from '../../protocol/types';
import type { InputSnapshot } from '../input/InputManager';

export interface BackendHooks {
  onBattery(data: Uint8Array): void;
  onStatus(status: 'running' | 'paused' | 'error', detail?: string): void;
  onStats(stats: StreamTelemetry): void;
  /** Ask the UI to collect a user gesture (browser autoplay policy) and call the resolver. */
  needsGesture(resume: () => Promise<void>): void;
  toast(level: 'info' | 'warn' | 'error', message: string): void;
  /** Ask the host for the game file; it is streamed in chunks (the webview cannot read user files itself). */
  loadRom(size: number): Promise<Uint8Array>;
}

export interface PlayerBackend {
  readonly kind: string;
  mount(stage: HTMLElement): Promise<void>;
  setInput(s: InputSnapshot): void;
  pause(): Promise<void>;
  resume(): Promise<void>;
  reset(): Promise<void>;
  saveState(slot: number): Promise<Uint8Array>;
  loadState(slot: number, data: Uint8Array): Promise<void>;
  /** Persist battery save now (returns the data that was sent, if any). */
  flush(): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  setVolume(percent: number): void;
  /** Whether setTurbo has any effect (drives the toolbar button). */
  readonly supportsTurbo: boolean;
  /** Fast-forward on/off; `speed` is a multiplier (2–8) where the backend controls speed itself. */
  setTurbo(on: boolean, speed: number): void;
  dispose(): Promise<void>;
}

export class UnsupportedError extends Error {}

/** Base for non-emulating backends (setup screens, external mode). */
export abstract class InertBackend implements PlayerBackend {
  abstract readonly kind: string;
  abstract mount(stage: HTMLElement): Promise<void>;
  setInput(_s: InputSnapshot): void {}
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  async reset(): Promise<void> {}
  async saveState(): Promise<Uint8Array> {
    throw new UnsupportedError('Save states are not available.');
  }
  async loadState(): Promise<void> {
    throw new UnsupportedError('Save states are not available.');
  }
  async flush(): Promise<void> {}
  async screenshot(): Promise<Uint8Array> {
    throw new UnsupportedError('Screenshots are not available.');
  }
  setVolume(_percent: number): void {}
  readonly supportsTurbo: boolean = false;
  setTurbo(_on: boolean, _speed: number): void {}
  async dispose(): Promise<void> {}
}
