import type { InitPayload } from '../../../protocol/messages';
import type { CommandResult, LaunchContext, SessionCommand } from '../../sessions/Session';
import { StreamSession } from './StreamSession';

/**
 * Developer test: stream an arbitrary existing app window through the same bridge pipeline used for Eden.
 * Never spawns or kills the target process.
 */
export class DevStreamSession extends StreamSession {
  constructor(
    ctx: LaunchContext,
    private readonly pid: number,
  ) {
    super(ctx, { saveStates: false, batterySave: false, pause: false, reset: true, screenshots: false, mods: false, audio: true, gamepad: true });
  }

  async init(): Promise<InitPayload> {
    if (!this.bridge) {
      this.setStatus('starting');
      await this.startBridge(this.pid);
      if (!this.bridge && this.status === 'starting') this.setStatus('running');
    }
    return { ...this.base(), backend: this.backend };
  }

  async command(command: SessionCommand): Promise<CommandResult> {
    if (command === 'reset' || command === 'restart') {
      await this.stopBridge();
      const init = await this.init();
      await this.ctx.channel.post({ v: 1, type: 'init', payload: init });
      return { ok: true };
    }
    if (command === 'stop') {
      await this.stop();
      return { ok: true };
    }
    return { ok: false, message: `${command} is not available in the stream test.` };
  }

  async stop(): Promise<void> {
    if (!this.bridge) return;
    this.setStatus('stopping');
    await this.stopBridge();
    this.setStatus('stopped');
  }
}
