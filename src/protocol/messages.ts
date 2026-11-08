// Versioned message envelopes for extension host <-> webview traffic (webview.postMessage).
import { PROTOCOL_VERSION, type Capabilities, type InputFrame, type Platform, type SessionStatus, type StreamTelemetry } from './types';

export interface Envelope<T extends string, P> {
  v: typeof PROTOCOL_VERSION;
  type: T;
  id?: string;
  payload: P;
}

export interface PlayerSettings {
  scale: 'fit' | 'integer' | 'stretch';
  showStats: boolean;
  volume: number;
  pauseOnBlur: boolean;
  keyboard: Record<string, string>;
  ndsScreenLayout: string;
  /** Fast-forward multiplier for webview cores (2–8). */
  turboSpeed: number;
}

export type BackendInit =
  | { kind: 'gba'; coreJsUrl: string; romUrl: string; romName: string; battery?: Uint8Array; resumeState?: Uint8Array }
  | { kind: 'nds'; coreJsUrl: string; coreWasmUrl: string; romUrl: string; romName: string; battery?: Uint8Array; resumeState?: Uint8Array }
  | { kind: 'stream'; wsUrl: string; token: string; workletUrl: string }
  | { kind: 'external'; reason: string }
  | { kind: 'setup'; problem: 'eden-missing' | 'untrusted' | 'remote' | 'unsupported-os' | 'permissions' | 'bridge-missing'; detail: string; permissions?: { screen: boolean; accessibility: boolean } }
  | { kind: 'error'; message: string };

export interface InitPayload {
  platform: Platform;
  title: string;
  capabilities: Capabilities;
  settings: PlayerSettings;
  backend: BackendInit;
  /** When true the webview is destroyed on hide, so it should save a suspend state when hidden. */
  suspendOnHide?: boolean;
}

/** Host -> webview. */
export type HostToPlayer =
  | Envelope<'init', InitPayload>
  | Envelope<'backend', BackendInit>
  | Envelope<'command', { command: PlayerCommand; slot?: number; data?: Uint8Array }>
  | Envelope<'status', { status: SessionStatus; detail?: string; capabilities?: Capabilities }>
  | Envelope<'settings', PlayerSettings>
  | Envelope<'telemetry', StreamTelemetry>
  | Envelope<'toast', { level: 'info' | 'warn' | 'error'; message: string }>
  /** Persistent banner over the game (null text clears it). */
  | Envelope<'notice', { text: string | null }>;

export type PlayerCommand = 'pause' | 'resume' | 'reset' | 'saveState' | 'loadState' | 'flush' | 'releaseAll' | 'screenshot' | 'suspend' | 'stop';

/** Webview -> host. */
export type PlayerToHost =
  | Envelope<'ready', { protocol: number }>
  | Envelope<'status', { status: SessionStatus; detail?: string }>
  | Envelope<'save.battery', { data: Uint8Array }>
  | Envelope<'save.state', { slot: number; data: Uint8Array; suspend?: boolean }>
  | Envelope<'screenshot', { png: Uint8Array }>
  | Envelope<'input', InputFrame>
  | Envelope<'action', { action: PlayerAction }>
  | Envelope<'telemetry', StreamTelemetry>
  | Envelope<'log', { level: 'debug' | 'info' | 'warn' | 'error'; message: string }>
  | Envelope<'reply', { ok: boolean; error?: string }>;

export type PlayerAction =
  | 'pause' | 'resume' | 'reset' | 'quickSave' | 'quickLoad' | 'stop' | 'restart'
  | 'openSettings' | 'openMods' | 'openSaves' | 'locateEden' | 'openScreenPrivacy' | 'openAccessibilityPrivacy' | 'retry';

export function envelope<M extends { type: string; payload: unknown }>(type: M['type'], payload: M['payload'], id?: string): M {
  return { v: PROTOCOL_VERSION, type, payload, ...(id ? { id } : {}) } as unknown as M;
}

const PLAYER_TYPES = new Set(['ready', 'status', 'save.battery', 'save.state', 'screenshot', 'input', 'action', 'telemetry', 'log', 'reply']);
const ACTIONS = new Set<PlayerAction>(['pause', 'resume', 'reset', 'quickSave', 'quickLoad', 'stop', 'restart', 'openSettings', 'openMods', 'openSaves', 'locateEden', 'openScreenPrivacy', 'openAccessibilityPrivacy', 'retry']);
const MAX_BLOB = 64 * 1024 * 1024;

export type ParseResult<T> = { ok: true; message: T } | { ok: false; error: string };

function isBytes(x: unknown): x is Uint8Array {
  return x instanceof Uint8Array && x.byteLength <= MAX_BLOB;
}

/** Validate untrusted webview messages before the host acts on them. */
export function parsePlayerMessage(raw: unknown): ParseResult<PlayerToHost> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'not an object' };
  const m = raw as Record<string, unknown>;
  if (m.v !== PROTOCOL_VERSION) return { ok: false, error: `unsupported protocol version ${String(m.v)}` };
  if (typeof m.type !== 'string' || !PLAYER_TYPES.has(m.type)) return { ok: false, error: `unknown type ${String(m.type)}` };
  const p = m.payload as Record<string, unknown> | undefined;
  if (typeof p !== 'object' || p === null) return { ok: false, error: 'missing payload' };
  switch (m.type) {
    case 'save.battery':
      if (!isBytes(p.data)) return { ok: false, error: 'bad battery data' };
      break;
    case 'save.state':
      if (!isBytes(p.data) || !Number.isInteger(p.slot) || (p.slot as number) < 0 || (p.slot as number) > 9) return { ok: false, error: 'bad state' };
      break;
    case 'screenshot':
      if (!isBytes(p.png)) return { ok: false, error: 'bad screenshot' };
      break;
    case 'input':
      if (!Number.isInteger(p.sequence) || !Number.isInteger(p.buttons) || typeof p.axes !== 'object') return { ok: false, error: 'bad input' };
      break;
    case 'action':
      if (!ACTIONS.has(p.action as PlayerAction)) return { ok: false, error: 'bad action' };
      break;
    case 'log':
      if (typeof p.message !== 'string') return { ok: false, error: 'bad log' };
      p.message = (p.message as string).slice(0, 4000);
      break;
  }
  return { ok: true, message: m as unknown as PlayerToHost };
}
