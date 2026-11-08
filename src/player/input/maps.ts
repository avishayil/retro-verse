import { PLATFORM_BUTTONS, type Button, type Platform } from '../../protocol/types';

/**
 * One keyboard layout for every platform, built on the classic desktop GBA-emulator convention
 * (mGBA / VisualBoyAdvance: Z = B, X = A, A = L, S = R, Enter = Start, Backspace = Select, arrows = D-pad).
 * Buttons the GBA lacks are placed on keys that never clash with it:
 *   Y / X   -> C / V   (continue the Z X row of face buttons)
 *   ZL / ZR -> Q / W   (directly above L / R)
 *   left stick -> I J K L, Home -> H
 * Each platform uses the subset of buttons it has, so a given key always means the same button.
 * Exception, by design: the arrows are always *movement*. On GBA/DS that is the D-pad; Switch games move
 * with the left stick, so there the arrows drive the left stick and the D-pad moves to I J K L.
 * Values are KeyboardEvent.code; the first entry is the primary key shown in help.
 */
export const UNIFIED_KEYS: Readonly<Record<Button, readonly string[]>> = {
  A: ['KeyX'],
  B: ['KeyZ'],
  Y: ['KeyC'],
  X: ['KeyV'],
  L: ['KeyA'],
  R: ['KeyS'],
  ZL: ['KeyQ'],
  ZR: ['KeyW'],
  Start: ['Enter', 'NumpadEnter'],
  Select: ['Backspace', 'ShiftRight'],
  Up: ['ArrowUp'],
  Down: ['ArrowDown'],
  Left: ['ArrowLeft'],
  Right: ['ArrowRight'],
  Home: ['KeyH'],
  Capture: [],
  LS: [],
  RS: [],
};

/**
 * Turbo / fast-forward, as in mGBA: hold Tab to fast-forward while held, Shift+Tab to toggle it.
 * Same keys on every platform.
 */
export const TURBO_KEY = 'Tab';

/** Switch: the arrows drive the left stick (movement)… */
export const SWITCH_STICK_KEYS = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' } as const;
/** …and the D-pad lives on I J K L. */
export const SWITCH_DPAD_KEYS: Readonly<Partial<Record<Button, readonly string[]>>> = { Up: ['KeyI'], Down: ['KeyK'], Left: ['KeyJ'], Right: ['KeyL'] };

/** The unified layout restricted to one platform's buttons. */
export function defaultKeys(platform: Platform): Partial<Record<Button, readonly string[]>> {
  const out: Partial<Record<Button, readonly string[]>> = {};
  for (const b of PLATFORM_BUTTONS[platform]) if (UNIFIED_KEYS[b].length) out[b] = UNIFIED_KEYS[b];
  return out;
}

/**
 * Resolve the effective key -> button table. A user override (`retroverse.input.keyboard`, button -> code)
 * replaces that button's keys and takes the key away from any default button that used it.
 */
export function resolveKeyTable(platform: Platform, overrides: Record<string, string>): Map<string, Button> {
  const allowed = new Set(PLATFORM_BUTTONS[platform]);
  const keys = new Map<Button, string[]>();
  for (const [b, codes] of Object.entries(defaultKeys(platform)) as [Button, readonly string[]][]) keys.set(b, [...codes]);
  if (platform === 'switch') for (const [b, codes] of Object.entries(SWITCH_DPAD_KEYS) as [Button, readonly string[]][]) keys.set(b, [...codes]);
  const overridden = Object.entries(overrides).filter(([b]) => allowed.has(b as Button)) as [Button, string][];
  const taken = new Set(overridden.map(([, code]) => code));
  for (const [b, codes] of keys) keys.set(b, codes.filter((c) => !taken.has(c)));
  for (const [b, code] of overridden) keys.set(b, [code]);
  const table = new Map<string, Button>();
  for (const [b, codes] of keys) for (const c of codes) table.set(c, b);
  if (platform === 'switch') for (const c of Object.values(SWITCH_STICK_KEYS)) table.delete(c);
  return table;
}

/** Human-readable key name for help overlays. */
export function keyLabel(code: string): string {
  return code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '').replace(/^Numpad/, 'Num ').replace('ShiftRight', 'Right Shift');
}

/**
 * W3C "standard" gamepad mapping, laid out by position to match Nintendo labels
 * (bottom face = B, right face = A, left = Y, top = X).
 */
export const STANDARD_GAMEPAD: Partial<Record<number, Button>> = {
  0: 'B', 1: 'A', 2: 'Y', 3: 'X', 4: 'L', 5: 'R', 6: 'ZL', 7: 'ZR',
  8: 'Select', 9: 'Start', 10: 'LS', 11: 'RS', 12: 'Up', 13: 'Down', 14: 'Left', 15: 'Right', 16: 'Home',
};

export const STICK_DEADZONE = 0.2;
/** For digital-only platforms, how far a stick must move to count as a d-pad press. */
export const STICK_DPAD_THRESHOLD = 0.5;
