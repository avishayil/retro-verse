import type { SessionStatus } from './types';

const TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  idle: ['starting', 'stopped', 'error'],
  starting: ['running', 'paused', 'stopping', 'error', 'stopped'],
  running: ['paused', 'stopping', 'error', 'stopped', 'starting'],
  paused: ['running', 'stopping', 'error', 'stopped', 'starting'],
  stopping: ['stopped', 'error'],
  stopped: ['starting'],
  error: ['starting', 'stopped'],
};

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export class StatusMachine {
  private _status: SessionStatus = 'idle';
  private listeners = new Set<(s: SessionStatus, prev: SessionStatus) => void>();

  get status(): SessionStatus {
    return this._status;
  }

  /** Returns false (and leaves the state unchanged) for illegal transitions. */
  transition(to: SessionStatus): boolean {
    const prev = this._status;
    if (prev === to) return true;
    if (!canTransition(prev, to)) return false;
    this._status = to;
    for (const l of this.listeners) l(to, prev);
    return true;
  }

  onChange(l: (s: SessionStatus, prev: SessionStatus) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
