import { describe, expect, it } from 'vitest';
import { deadzone } from '../../src/player/input/InputManager';
import { defaultKeys, resolveKeyTable, STANDARD_GAMEPAD, SWITCH_STICK_KEYS, UNIFIED_KEYS } from '../../src/player/input/maps';
import { PLATFORM_BUTTONS, type Platform } from '../../src/protocol/types';

const PLATFORMS: Platform[] = ['gba', 'nds', 'switch'];

describe('input mapping', () => {
  it('applies a rescaled deadzone', () => {
    expect(deadzone(0.1)).toBe(0);
    expect(deadzone(-0.19)).toBe(0);
    expect(deadzone(1)).toBe(1);
    expect(deadzone(-1)).toBe(-1);
    expect(deadzone(0.6)).toBeCloseTo(0.5);
  });

  it('follows the desktop GBA-emulator convention (mGBA/VBA)', () => {
    const t = resolveKeyTable('gba', {});
    expect(t.get('KeyX')).toBe('A');
    expect(t.get('KeyZ')).toBe('B');
    expect(t.get('KeyA')).toBe('L');
    expect(t.get('KeyS')).toBe('R');
    expect(t.get('Enter')).toBe('Start');
    expect(t.get('Backspace')).toBe('Select');
    expect(t.get('ArrowUp')).toBe('Up');
  });

  it('uses one layout everywhere: a key means the same button on every platform', () => {
    const tables = PLATFORMS.map((p) => resolveKeyTable(p, {}));
    const all = new Set(tables.flatMap((t) => [...t.keys()]));
    for (const code of all) {
      if (/^Arrow|^Key[IJKL]$/.test(code)) continue; // movement: D-pad on GBA/DS, left stick on Switch (below)
      const meanings = new Set(tables.map((t) => t.get(code)).filter(Boolean));
      expect(meanings.size, `${code} maps to ${[...meanings]}`).toBe(1);
    }
    // the GBA mapping is preserved verbatim on NDS, and on Switch for everything except movement
    for (const [code, b] of resolveKeyTable('gba', {})) {
      expect(resolveKeyTable('nds', {}).get(code)).toBe(b);
      if (!code.startsWith('Arrow')) expect(resolveKeyTable('switch', {}).get(code)).toBe(b);
    }
  });

  it('arrows are movement everywhere: D-pad on GBA/DS, left stick on Switch (D-pad on I J K L)', () => {
    expect(resolveKeyTable('gba', {}).get('ArrowUp')).toBe('Up');
    expect(resolveKeyTable('nds', {}).get('ArrowLeft')).toBe('Left');
    const sw = resolveKeyTable('switch', {});
    expect(sw.get('ArrowUp')).toBeUndefined(); // handled as stick axes, not a button
    expect(Object.values(SWITCH_STICK_KEYS).sort()).toEqual(['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp']);
    expect(sw.get('KeyI')).toBe('Up');
    expect(sw.get('KeyK')).toBe('Down');
    expect(sw.get('KeyJ')).toBe('Left');
    expect(sw.get('KeyL')).toBe('Right');
  });

  it('has no duplicate keys and only buttons each platform has', () => {
    const codes = Object.values(UNIFIED_KEYS).flat();
    expect(new Set(codes).size).toBe(codes.length);
    for (const p of PLATFORMS) {
      const allowed = new Set(PLATFORM_BUTTONS[p]);
      for (const b of Object.keys(defaultKeys(p))) expect(allowed.has(b as never)).toBe(true);
    }
    expect(resolveKeyTable('gba', {}).get('KeyC')).toBeUndefined(); // GBA has no Y
  });

  it('user overrides replace a button and steal the key from its old owner', () => {
    const t = resolveKeyTable('gba', { A: 'KeyZ' });
    expect(t.get('KeyZ')).toBe('A');
    expect(t.get('KeyX')).toBeUndefined();
    expect([...t.values()].filter((b) => b === 'B')).toEqual([]); // B lost its only key
    expect(resolveKeyTable('gba', { Y: 'KeyQ' }).get('KeyQ')).toBeUndefined(); // not a GBA button
  });

  it('uses Nintendo positional face buttons for standard gamepads', () => {
    expect(STANDARD_GAMEPAD[0]).toBe('B');
    expect(STANDARD_GAMEPAD[1]).toBe('A');
  });
});
