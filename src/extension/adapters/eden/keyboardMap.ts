import { sanitizeMap } from '../../settings';

/**
 * Logical Switch input -> key injected into Eden. Defaults mirror Eden's (yuzu-derived) default keyboard
 * profile. Stick directions are digital in v1 (axis beyond threshold = key held).
 */
export const DEFAULT_EDEN_KEYMAP: Readonly<Record<string, string>> = Object.freeze({
  A: 'C',
  B: 'X',
  X: 'V',
  Y: 'Z',
  L: 'Q',
  R: 'E',
  ZL: 'R',
  ZR: 'T',
  Start: 'M', // Plus
  Select: 'N', // Minus
  Up: 'UpArrow',
  Down: 'DownArrow',
  Left: 'LeftArrow',
  Right: 'RightArrow',
  LS: 'F',
  RS: 'G',
  LUp: 'W',
  LDown: 'S',
  LLeft: 'A',
  LRight: 'D',
  RUp: 'I',
  RDown: 'K',
  RLeft: 'J',
  RRight: 'L',
});

/** Precedence: Eden defaults < bindings read from the user's Eden config < retroverse.switch.keyboardMap. */
export function effectiveKeymap(overrides: Record<string, unknown> | undefined, fromEdenConfig: Record<string, string> = {}): Record<string, string> {
  return { ...DEFAULT_EDEN_KEYMAP, ...sanitizeMap(fromEdenConfig), ...sanitizeMap(overrides) };
}
