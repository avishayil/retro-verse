// Shared types between the extension host and the player webview.
// Keep this file free of Node or DOM imports: it is bundled into both.

export const PROTOCOL_VERSION = 1 as const;

export type Platform = 'gba' | 'nds' | 'switch';

export type SessionStatus = 'idle' | 'starting' | 'running' | 'paused' | 'stopping' | 'stopped' | 'error';

export interface Capabilities {
  saveStates: boolean;
  batterySave: boolean;
  pause: boolean;
  reset: boolean;
  screenshots: boolean;
  mods: boolean;
  audio: boolean;
  gamepad: boolean;
}

export const NO_CAPABILITIES: Capabilities = Object.freeze({
  saveStates: false,
  batterySave: false,
  pause: false,
  reset: false,
  screenshots: false,
  mods: false,
  audio: false,
  gamepad: false,
});

/** Logical buttons. Each platform uses a subset. */
export const BUTTONS = [
  'A', 'B', 'X', 'Y', 'L', 'R', 'ZL', 'ZR',
  'Start', 'Select', 'Up', 'Down', 'Left', 'Right',
  'Home', 'Capture', 'LS', 'RS',
] as const;
export type Button = (typeof BUTTONS)[number];

export const PLATFORM_BUTTONS: Record<Platform, readonly Button[]> = {
  gba: ['A', 'B', 'L', 'R', 'Start', 'Select', 'Up', 'Down', 'Left', 'Right'],
  nds: ['A', 'B', 'X', 'Y', 'L', 'R', 'Start', 'Select', 'Up', 'Down', 'Left', 'Right'],
  switch: ['A', 'B', 'X', 'Y', 'L', 'R', 'ZL', 'ZR', 'Start', 'Select', 'Up', 'Down', 'Left', 'Right', 'Home', 'Capture', 'LS', 'RS'],
};

export interface Axes {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
}

/** A complete snapshot of controller state. Snapshots (not deltas) make release-all trivially correct. */
export interface InputFrame {
  sequence: number;
  buttons: number; // bitmask indexed by BUTTONS
  axes: Axes;
}

export function buttonBit(b: Button): number {
  return 1 << BUTTONS.indexOf(b);
}

export function buttonsFromMask(mask: number): Button[] {
  return BUTTONS.filter((_, i) => (mask & (1 << i)) !== 0);
}

export function maskFromButtons(buttons: Iterable<Button>): number {
  let m = 0;
  for (const b of buttons) m |= buttonBit(b);
  return m;
}

export const ZERO_AXES: Axes = Object.freeze({ lx: 0, ly: 0, rx: 0, ry: 0 });

export interface StreamTelemetry {
  fps: number;
  captureMs?: number;
  encodeMs?: number;
  decodeMs?: number;
  queueDepth?: number;
  bitrateKbps?: number;
  latencyMs?: number;
  droppedFrames?: number;
}
