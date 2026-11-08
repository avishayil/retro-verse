import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface GdbStubConfig {
  enabled: boolean;
  port: number;
}

/** Eden's Qt config (XDG on macOS/Linux; older macOS builds used Application Support). */
export function edenConfigCandidates(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), platform: NodeJS.Platform = process.platform): string[] {
  const xdg = path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'eden', 'qt-config.ini');
  if (platform === 'win32') return [path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'eden', 'config', 'qt-config.ini')];
  if (platform === 'darwin') return [xdg, path.join(home, 'Library', 'Application Support', 'eden', 'config', 'qt-config.ini')];
  return [xdg];
}

/**
 * Parse the GDB stub settings from a Qt INI. Keys look like `use_gdbstub=true` / `gdbstub_port=6543`,
 * each with a sibling `...\default=` entry; the non-default key wins. Defaults: disabled, port 6543.
 */
export function parseGdbStub(ini: string): GdbStubConfig {
  let enabled = false;
  let port = 6543;
  for (const raw of ini.split(/\r?\n/)) {
    const m = /^\s*(use_gdbstub|gdbstub_port)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    if (m[1] === 'use_gdbstub') enabled = /^(true|1)$/i.test(m[2]);
    else {
      const n = Number(m[2]);
      if (Number.isInteger(n) && n > 0 && n < 65536) port = n;
    }
  }
  return { enabled, port };
}

export async function readGdbStubConfig(candidates = edenConfigCandidates()): Promise<GdbStubConfig & { source?: string }> {
  for (const c of candidates) {
    try {
      return { ...parseGdbStub(await readFile(c, 'utf8')), source: c };
    } catch {
      /* try next */
    }
  }
  return { enabled: false, port: 6543 };
}

/**
 * Read an Eden hotkey (Qt `QKeySequence` portable text) from qt-config.ini, e.g.
 * `Shortcuts\Main%20Window\Toggle%20Turbo%20Speed\KeySeq=Ctrl+Z`.
 */
export function parseEdenShortcut(ini: string, action: string): string | undefined {
  const key = `Shortcuts\\Main%20Window\\${action.replace(/ /g, '%20')}\\KeySeq`;
  for (const raw of ini.split(/\r?\n/)) {
    const i = raw.indexOf('=');
    if (i < 0 || raw.slice(0, i).trim() !== key) continue;
    const v = raw.slice(i + 1).trim();
    return v || undefined;
  }
  return undefined;
}

/**
 * Convert a Qt key sequence to the bridge's hotkey syntax. On macOS Qt maps "Ctrl" to the Command key and
 * "Meta" to the Control key. Returns undefined for multi-chord or unsupported sequences.
 */
export function qtSequenceToBridgeHotkey(seq: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!seq || seq.includes(',')) return undefined;
  const parts = seq.split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key || !/^([A-Za-z0-9]|F[0-9]{1,2}|Return|Tab|Space|Escape|Up|Down|Left|Right)$/.test(key)) return undefined;
  const mods: string[] = [];
  for (const m of parts) {
    const l = m.toLowerCase();
    if (l === 'ctrl') mods.push(platform === 'darwin' ? 'cmd' : 'ctrl');
    else if (l === 'meta') mods.push(platform === 'darwin' ? 'ctrl' : 'cmd');
    else if (l === 'alt') mods.push('alt');
    else if (l === 'shift') mods.push('shift');
    else return undefined;
  }
  const keyName = /^(Up|Down|Left|Right)$/.test(key) ? `${key}Arrow` : key.length === 1 ? key.toUpperCase() : key;
  return [...mods, keyName].join('+');
}

export async function readEdenTurboHotkey(candidates = edenConfigCandidates()): Promise<string | undefined> {
  for (const c of candidates) {
    try {
      const seq = parseEdenShortcut(await readFile(c, 'utf8'), 'Toggle Turbo Speed');
      return seq ? qtSequenceToBridgeHotkey(seq) : undefined;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

/** Qt::Key code -> bridge key name (see native/eden-bridge Keymap.swift). */
export function qtKeyName(code: number): string | undefined {
  if (code >= 65 && code <= 90) return String.fromCharCode(code); // A–Z
  if (code >= 48 && code <= 57) return String.fromCharCode(code); // 0–9
  const special: Record<number, string> = {
    32: 'Space',
    0x01000000: 'Escape',
    0x01000001: 'Tab',
    0x01000003: 'Delete', // Backspace
    0x01000004: 'Return',
    0x01000005: 'Return', // Enter (keypad)
    0x01000012: 'LeftArrow',
    0x01000013: 'UpArrow',
    0x01000014: 'RightArrow',
    0x01000015: 'DownArrow',
  };
  if (special[code]) return special[code];
  if (code >= 0x01000030 && code <= 0x0100003b) return `F${code - 0x01000030 + 1}`; // F1–F12
  return undefined;
}

/** Eden `player_0_button_*` suffix -> RetroVerse logical input. */
const EDEN_BUTTONS: Record<string, string> = {
  a: 'A', b: 'B', x: 'X', y: 'Y', l: 'L', r: 'R', zl: 'ZL', zr: 'ZR',
  plus: 'Start', minus: 'Select', dup: 'Up', ddown: 'Down', dleft: 'Left', dright: 'Right',
  lstick: 'LS', rstick: 'RS', home: 'Home', screenshot: 'Capture',
};

/**
 * Build the bridge keymap from the keyboard bindings in Eden's own config (player 1), so injected keys are
 * exactly what Eden listens for. Covers buttons (`engine:keyboard,…,code:N`) and keyboard-emulated sticks
 * (`engine:analog_from_button,up:…code$0N,…`). Bindings to other engines (gamepad, mouse) or code 0 are skipped.
 */
export function parseEdenKeymap(ini: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of ini.split(/\r?\n/)) {
    const m = /^player_0_(button_([a-z]+)|lstick|rstick)="?(.*?)"?\s*$/.exec(raw);
    if (!m || raw.includes('\\default=')) continue;
    const value = m[3];
    if (m[2]) {
      const logical = EDEN_BUTTONS[m[2]];
      const code = /^engine:keyboard,.*\bcode:(\d+)/.exec(value);
      const name = code ? qtKeyName(Number(code[1])) : undefined;
      if (logical && name) out[logical] = name;
      continue;
    }
    if (!value.startsWith('engine:analog_from_button')) continue;
    const prefix = m[1] === 'lstick' ? 'L' : 'R';
    for (const dir of ['up', 'down', 'left', 'right'] as const) {
      // nested params are escaped: up:engine$0keyboard$1toggle$00$1code$087
      const d = new RegExp(`\\b${dir}:engine\\$0keyboard[^,]*?code\\$0(\\d+)`).exec(value);
      const name = d ? qtKeyName(Number(d[1])) : undefined;
      if (name) out[`${prefix}${dir[0].toUpperCase()}${dir.slice(1)}`] = name;
    }
  }
  return out;
}

export async function readEdenKeymap(candidates = edenConfigCandidates()): Promise<Record<string, string>> {
  for (const c of candidates) {
    try {
      return parseEdenKeymap(await readFile(c, 'utf8'));
    } catch {
      /* try next */
    }
  }
  return {};
}
