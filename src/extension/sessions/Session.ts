import type * as vscode from 'vscode';
import type { HostToPlayer, InitPayload, PlayerCommand, PlayerToHost } from '../../protocol/messages';
import type { Capabilities, InputFrame, Platform, SessionStatus } from '../../protocol/types';
import type { GameDocument } from '../providers/GameDocument';
import type { SaveStore } from '../storage/SaveStore';

/** Transport to one player webview. */
export interface PlayerChannel {
  readonly webview: vscode.Webview;
  post(msg: HostToPlayer): Promise<boolean>;
  /** Send a command and wait for the webview's `reply` with the same id. */
  request(command: PlayerCommand, extra?: { slot?: number; data?: Uint8Array }, timeoutMs?: number): Promise<{ ok: boolean; error?: string }>;
}

export type SessionCommand = 'pause' | 'resume' | 'reset' | 'quickSave' | 'quickLoad' | 'screenshot' | 'openMods' | 'openSaves' | 'stop' | 'restart';

export interface CommandResult {
  ok: boolean;
  message?: string;
}

export type SessionEvent =
  | { type: 'status'; status: SessionStatus; detail?: string }
  | { type: 'capabilities'; capabilities: Capabilities }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export interface LaunchContext {
  document: GameDocument;
  channel: PlayerChannel;
  saves: SaveStore;
  extensionUri: vscode.Uri;
  retainContextWhenHidden: boolean;
  /**
   * Re-render the player with a Content Security Policy that allows exactly this loopback port (the capture
   * agent's WebSocket). The player reloads and asks for init again.
   */
  allowBridgePort?(port: number): void;
}

/** Host-side session; mirrors the EmulatorSession contract of the architecture doc (§3.3). */
export interface HostSession {
  readonly id: string;
  readonly platform: Platform;
  readonly title: string;
  readonly status: SessionStatus;
  readonly capabilities: Capabilities;
  /** Build the init payload for a (re)loaded webview. */
  init(): Promise<InitPayload>;
  /** Called after the init payload was posted; lets sessions re-send state that changed meanwhile. */
  afterInit?(): void;
  handleMessage(msg: PlayerToHost): Promise<void>;
  command(command: SessionCommand): Promise<CommandResult>;
  sendInput(input: InputFrame): Promise<void>;
  setVisible(visible: boolean): void;
  onEvent(listener: (e: SessionEvent) => void): vscode.Disposable;
  stop(): Promise<void>;
}

export interface EmulatorAdapter {
  readonly id: string;
  readonly platform: Platform;
  probe(): Promise<{ available: boolean; version?: string; reason?: string }>;
  start(ctx: LaunchContext): Promise<HostSession>;
}
