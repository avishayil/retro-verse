import type { HostToPlayer, PlayerToHost } from '../../protocol/messages';
import { PROTOCOL_VERSION } from '../../protocol/types';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

type Msg<T extends PlayerToHost['type']> = Extract<PlayerToHost, { type: T }>;

export const host = {
  post<T extends PlayerToHost['type']>(type: T, payload: Msg<T>['payload'], id?: string): void {
    api.postMessage({ v: PROTOCOL_VERSION, type, payload, ...(id ? { id } : {}) });
  },
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.post('log', { level, message });
  },
  onMessage(handler: (m: HostToPlayer) => void): void {
    window.addEventListener('message', (e: MessageEvent) => {
      const m = e.data as HostToPlayer;
      if (m && typeof m === 'object' && m.v === PROTOCOL_VERSION && typeof m.type === 'string') handler(m);
    });
  },
  getState<T>(): T | undefined {
    return api.getState() as T | undefined;
  },
  setState(s: unknown): void {
    api.setState(s);
  },
};
