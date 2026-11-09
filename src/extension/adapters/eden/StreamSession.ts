import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { BackendInit, InitPayload, PlayerToHost } from '../../../protocol/messages';
import type { Capabilities } from '../../../protocol/types';
import { log, sanitizeLogLine } from '../../diagnostics/Log';
import { randomToken } from '../../security/tokens';
import { BaseSession } from '../../sessions/BaseSession';
import type { CommandResult, LaunchContext, SessionCommand } from '../../sessions/Session';
import { cfg, playerSettings, userSetting } from '../../settings';
import { run } from '../../util/proc';
import { BridgeClient, type BridgeEvent } from './BridgeClient';
import { effectiveKeymap } from './keyboardMap';

export const STREAM_CAPABILITIES: Capabilities = {
  saveStates: false,
  batterySave: false,
  pause: true,
  reset: true,
  screenshots: false,
  mods: true,
  audio: true,
  gamepad: true,
};

export function resolveBridgePath(extensionUri: vscode.Uri): string | undefined {
  const configured = userSetting<string>('switch.bridgePath', '').trim();
  if (configured) return configured;
  const arch = `${process.platform}-${process.arch}`;
  const candidates = [
    path.join(extensionUri.fsPath, 'bin', arch, 'eden-bridge'),
    path.join(extensionUri.fsPath, 'native', 'eden-bridge', '.build', 'release', 'eden-bridge'),
    path.join(extensionUri.fsPath, 'native', 'eden-bridge', '.build', 'debug', 'eden-bridge'),
  ];
  return candidates.find((c) => existsSync(c));
}

/**
 * Streams a native process window into the player via eden-bridge.
 * Subclasses decide which process (spawned Eden, or an existing app for the developer test).
 */
export abstract class StreamSession extends BaseSession {
  protected bridge: BridgeClient | undefined;
  protected backend: BackendInit = { kind: 'external', reason: 'Starting…' };
  private token = '';
  private stoppingBridge = false;

  constructor(ctx: LaunchContext, caps: Capabilities = STREAM_CAPABILITIES) {
    super('switch', ctx, caps);
  }

  protected base(): Omit<InitPayload, 'backend'> {
    return { platform: 'switch', title: this.title, capabilities: this.caps, settings: playerSettings() };
  }

  protected publish(backend: BackendInit): void {
    this.backend = backend;
    void this.ctx.channel.post({ v: 1, type: 'backend', payload: backend });
  }

  afterInit(): void {
    // The bridge may have changed state while init() was in flight; the webview ignores identical backends.
    void this.ctx.channel.post({ v: 1, type: 'backend', payload: this.backend });
  }

  /** Start the capture agent against `pid`. Falls back to external mode when unavailable. */
  protected async startBridge(pid: number): Promise<void> {
    if (process.platform !== 'darwin') {
      this.publish({ kind: 'external', reason: 'In-editor streaming is currently implemented for macOS only. The game runs in its own window.' });
      return;
    }
    const exe = resolveBridgePath(this.ctx.extensionUri);
    if (!exe) {
      this.publish({ kind: 'setup', problem: 'bridge-missing', detail: 'The eden-bridge capture agent is not built. Run "npm run build:native", or set retroverse.switch.bridgePath. The game runs in its own window meanwhile.' });
      return;
    }
    this.token = randomToken();
    const c = cfg();
    const bridge = new BridgeClient(exe, {
      pid,
      token: this.token,
      fps: c.get('switch.streamFps', 30),
      height: c.get('switch.streamHeight', 720),
      bitrateKbps: c.get('switch.bitrateKbps', 8000),
      keymap: effectiveKeymap(userSetting<Record<string, unknown>>('switch.keyboardMap', {}), await this.emulatorKeymap()),
      turboHotkey: await this.turboHotkey(),
      avoidPids: await editorPids(),
      place: userSetting('switch.parkWindow', true),
    });
    this.bridge = bridge;
    bridge.on('event', (e) => this.onBridgeEvent(e));
    bridge.on('exit', (info) => {
      if (this.bridge !== bridge) return;
      this.bridge = undefined;
      if (this.stoppingBridge) return;
      log.warn(`[${this.id}] bridge exited code=${info.code} signal=${info.signal}: ${info.stderrTail.slice(-3).map((l) => sanitizeLogLine(l, this.sensitivePaths)).join(' | ')}`);
      this.onBridgeLost();
    });
    try {
      await bridge.start();
    } catch (e) {
      log.error(`[${this.id}] bridge spawn failed`, e);
      this.bridge = undefined;
      this.publish({ kind: 'setup', problem: 'bridge-missing', detail: `Could not start the capture agent: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  /** Key bindings read from the emulator's own config; none by default. */
  protected async emulatorKeymap(): Promise<Record<string, string>> {
    return {};
  }

  /** Hotkey the bridge presses to toggle the emulator's turbo; none by default. */
  protected async turboHotkey(): Promise<string | undefined> {
    return undefined;
  }

  protected onBridgeLost(): void {
    this.publish({ kind: 'external', reason: 'The capture agent stopped. The game keeps running in its own window; use Restart to try streaming again.' });
  }

  private permissionsReported = false;
  /** Paths that must never appear in logs or the UI (the game file); filled in by subclasses. */
  protected sensitivePaths: string[] = [];
  private placementHinted = false;

  private onBridgeEvent(e: BridgeEvent): void {
    switch (e.type) {
      case 'hello':
        log.info(`[${this.id}] bridge ${e.version} protocol ${e.protocol}`);
        break;
      case 'permissions':
        if (!e.screen) {
          this.publish({ kind: 'setup', problem: 'permissions', detail: 'Screen Recording permission is required to show the game inside VS Code. Grant it to Visual Studio Code, then restart VS Code. The game runs in its own window meanwhile.', permissions: { screen: e.screen, accessibility: e.accessibility } });
        } else if (!e.accessibility && !this.permissionsReported) {
          this.toast('warn', 'Accessibility permission is missing: controller input cannot be sent to the emulator. Grant it to Visual Studio Code in System Settings → Privacy & Security → Accessibility.');
        }
        this.permissionsReported = true;
        break;
      case 'waiting':
        if (this.backend.kind !== 'stream') this.publish({ kind: 'external', reason: e.reason });
        break;
      case 'window':
        log.info(`[${this.id}] capturing window ${e.width}x${e.height}`);
        break;
      case 'ready': {
        const workletUrl = this.ctx.channel.webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'player', 'pcm-worklet.js')).toString();
        const stream: BackendInit = { kind: 'stream', wsUrl: `ws://127.0.0.1:${e.port}/`, token: this.token, workletUrl };
        if (this.ctx.allowBridgePort) {
          // Reload the player with a policy that allows exactly this port; its init picks up the stream backend.
          this.backend = stream;
          this.ctx.allowBridgePort(e.port);
        } else {
          this.publish(stream);
        }
        if (this.status === 'starting') this.setStatus('running');
        break;
      }
      case 'client':
        log.info(`[${this.id}] stream client ${e.connected ? 'connected' : 'disconnected'}`);
        break;
      case 'telemetry':
        void this.ctx.channel.post({ v: 1, type: 'telemetry', payload: e.data });
        break;
      case 'error':
        log.warn(`[${this.id}] bridge error ${sanitizeLogLine(e.code, this.sensitivePaths)}: ${sanitizeLogLine(e.message, this.sensitivePaths)}`);
        if (e.fatal) this.publish({ kind: 'external', reason: `Streaming failed (${sanitizeLogLine(e.message, this.sensitivePaths, undefined, 200)}). The game runs in its own window.` });
        break;
      case 'log':
        log.debug(`[${this.id}] bridge: ${sanitizeLogLine(e.message, this.sensitivePaths)}`);
        break;
      case 'placement':
        log.info(`[${this.id}] emulator window placement: ${e.result}${e.x !== undefined ? ` at ${e.x},${e.y}` : ''}${e.reason ? ` (${e.reason})` : ''}`);
        if (e.result === 'noFreeDisplay' && !this.placementHinted) {
          this.placementHinted = true;
          this.toast('info', "Keep the emulator's own window visible somewhere (macOS pauses covered windows). With a second display RetroVerse parks it there automatically.");
        }
        break;
      case 'security':
        log.warn(`[${this.id}] security: capture agent ${sanitizeLogLine(e.event, [], undefined, 60)}: ${sanitizeLogLine(e.detail ?? '', this.sensitivePaths, undefined, 200)}`);
        break;
      case 'covered':
        void this.ctx.channel.post({
          v: 1,
          type: 'notice',
          payload: { text: e.covered ? "Paused by macOS: the emulator's window is covered by another window. Uncover it (it can sit behind nothing, e.g. on your other display) and the stream resumes." : null },
        });
        break;
    }
  }

  protected async stopBridge(): Promise<void> {
    const b = this.bridge;
    if (!b) return;
    this.stoppingBridge = true;
    try {
      await b.stop();
    } finally {
      this.bridge = undefined;
      this.stoppingBridge = false;
    }
  }

  override setVisible(visible: boolean): void {
    super.setVisible(visible);
    if (!visible) this.bridge?.send({ type: 'releaseAll' });
  }

  async handleMessage(msg: PlayerToHost): Promise<void> {
    if (msg.type === 'status' && msg.payload.status === 'error') log.warn(`[${this.id}] player error: ${msg.payload.detail ?? ''}`);
  }

  abstract override command(command: SessionCommand): Promise<CommandResult>;
}

/** VS Code's own processes (extension host and its ancestors), whose windows the emulator must not sit under. */
export async function editorPids(): Promise<number[]> {
  const pids: number[] = [];
  let pid = process.ppid;
  for (let i = 0; i < 6 && pid > 1; i++) {
    pids.push(pid);
    pid = Number((await run('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { timeoutMs: 2000 })).stdout.trim()) || 0;
  }
  return pids;
}
