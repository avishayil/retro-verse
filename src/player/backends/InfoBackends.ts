import type { BackendInit, PlayerAction } from '../../protocol/messages';
import { button, el } from '../ui/dom';
import { InertBackend } from './Backend';

type Act = (a: PlayerAction) => void;

function panel(title: string, body: string, actions: HTMLElement[], kind: 'info' | 'warn' | 'error' = 'info'): HTMLElement {
  return el('div', { class: `info-panel ${kind}` }, [el('h2', { text: title }), ...body.split('\n\n').map((p) => el('p', { text: p })), el('div', { class: 'actions' }, actions)]);
}

export class ExternalBackend extends InertBackend {
  readonly kind = 'external';
  private node: HTMLElement | undefined;
  constructor(
    private readonly reason: string,
    private readonly act: Act,
  ) {
    super();
  }
  async mount(stage: HTMLElement): Promise<void> {
    this.node = panel('Running outside the editor', this.reason, [button('Stop', () => this.act('stop')), button('Restart', () => this.act('restart')), button('Settings', () => this.act('openSettings'))]);
    stage.appendChild(this.node);
  }
  override async dispose(): Promise<void> {
    this.node?.remove();
  }
}

export class SetupBackend extends InertBackend {
  readonly kind = 'setup';
  private node: HTMLElement | undefined;
  constructor(
    private readonly info: Extract<BackendInit, { kind: 'setup' }>,
    private readonly act: Act,
  ) {
    super();
  }
  async mount(stage: HTMLElement): Promise<void> {
    const a = this.act;
    const titles: Record<typeof this.info.problem, string> = {
      'eden-missing': 'Eden emulator not found',
      untrusted: 'Workspace not trusted',
      remote: 'Local desktop required',
      'unsupported-os': 'Not supported on this OS',
      permissions: 'Permission needed',
      'bridge-missing': 'Capture agent missing',
    };
    const actions: HTMLElement[] = [];
    switch (this.info.problem) {
      case 'eden-missing':
        actions.push(button('Locate Eden…', () => a('locateEden'), { primary: true }), button('Settings', () => a('openSettings')), button('Retry', () => a('retry')));
        break;
      case 'permissions':
        if (!this.info.permissions?.screen) actions.push(button('Open Screen Recording settings', () => a('openScreenPrivacy'), { primary: true }));
        if (!this.info.permissions?.accessibility) actions.push(button('Open Accessibility settings', () => a('openAccessibilityPrivacy')));
        actions.push(button('Retry', () => a('retry')), button('Stop', () => a('stop')));
        break;
      case 'bridge-missing':
        actions.push(button('Settings', () => a('openSettings')), button('Retry', () => a('retry')), button('Stop', () => a('stop')));
        break;
      default:
        actions.push(button('Settings', () => a('openSettings')), button('Retry', () => a('retry')));
    }
    this.node = panel(titles[this.info.problem], this.info.detail, actions, 'warn');
    stage.appendChild(this.node);
  }
  override async dispose(): Promise<void> {
    this.node?.remove();
  }
}

export class ErrorBackend extends InertBackend {
  readonly kind = 'error';
  private node: HTMLElement | undefined;
  constructor(
    private readonly message: string,
    private readonly act: Act,
  ) {
    super();
  }
  async mount(stage: HTMLElement): Promise<void> {
    this.node = panel('Something went wrong', this.message, [button('Restart', () => this.act('restart'), { primary: true }), button('Settings', () => this.act('openSettings'))], 'error');
    stage.appendChild(this.node);
  }
  override async dispose(): Promise<void> {
    this.node?.remove();
  }
}
