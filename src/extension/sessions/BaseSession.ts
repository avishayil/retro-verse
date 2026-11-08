import * as vscode from 'vscode';
import type { InitPayload, PlayerToHost } from '../../protocol/messages';
import { StatusMachine } from '../../protocol/stateMachine';
import type { Capabilities, InputFrame, Platform, SessionStatus } from '../../protocol/types';
import { log } from '../diagnostics/Log';
import type { CommandResult, HostSession, LaunchContext, SessionCommand, SessionEvent } from './Session';

let counter = 0;

export abstract class BaseSession implements HostSession {
  readonly id = `s-${++counter}`;
  protected readonly machine = new StatusMachine();
  private readonly emitter = new vscode.EventEmitter<SessionEvent>();
  protected visible = true;

  constructor(
    readonly platform: Platform,
    protected readonly ctx: LaunchContext,
    protected caps: Capabilities,
  ) {
    this.machine.onChange((status) => this.emitter.fire({ type: 'status', status }));
  }

  get title(): string {
    return this.ctx.document.title;
  }

  get status(): SessionStatus {
    return this.machine.status;
  }

  get capabilities(): Capabilities {
    return this.caps;
  }

  protected setCapabilities(caps: Capabilities): void {
    this.caps = caps;
    this.emitter.fire({ type: 'capabilities', capabilities: caps });
  }

  protected setStatus(status: SessionStatus, detail?: string): void {
    if (!this.machine.transition(status)) {
      log.debug(`[${this.id}] ignored illegal transition ${this.machine.status} -> ${status}`);
      return;
    }
    void this.ctx.channel.post({ v: 1, type: 'status', payload: { status, detail, capabilities: this.caps } });
  }

  onEvent(listener: (e: SessionEvent) => void): vscode.Disposable {
    return this.emitter.event(listener);
  }

  protected emitLog(level: 'info' | 'warn' | 'error', message: string): void {
    this.emitter.fire({ type: 'log', level, message });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  async sendInput(_input: InputFrame): Promise<void> {
    /* WASM sessions handle input entirely inside the webview. */
  }

  protected toast(level: 'info' | 'warn' | 'error', message: string): void {
    void this.ctx.channel.post({ v: 1, type: 'toast', payload: { level, message } });
  }

  abstract init(): Promise<InitPayload>;
  abstract handleMessage(msg: PlayerToHost): Promise<void>;
  abstract command(command: SessionCommand): Promise<CommandResult>;
  abstract stop(): Promise<void>;

  dispose(): void {
    this.emitter.dispose();
  }
}
