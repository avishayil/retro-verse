import { describe, expect, it } from 'vitest';
import { decodeFrame, decodeInput, encodeFrame, encodeInput, WireType } from '../../src/protocol/bridgeWire';
import { parsePlayerMessage } from '../../src/protocol/messages';
import { canTransition, StatusMachine } from '../../src/protocol/stateMachine';
import { buttonsFromMask, maskFromButtons } from '../../src/protocol/types';

describe('parsePlayerMessage', () => {
  it('accepts well-formed messages', () => {
    expect(parsePlayerMessage({ v: 1, type: 'ready', payload: { protocol: 1 } }).ok).toBe(true);
    expect(parsePlayerMessage({ v: 1, type: 'save.battery', payload: { data: new Uint8Array(8) } }).ok).toBe(true);
    expect(parsePlayerMessage({ v: 1, type: 'action', payload: { action: 'quickSave' } }).ok).toBe(true);
  });

  it('rejects wrong versions, unknown types and malformed payloads', () => {
    expect(parsePlayerMessage(null).ok).toBe(false);
    expect(parsePlayerMessage({ v: 2, type: 'ready', payload: {} }).ok).toBe(false);
    expect(parsePlayerMessage({ v: 1, type: 'exec', payload: {} }).ok).toBe(false);
    expect(parsePlayerMessage({ v: 1, type: 'save.battery', payload: { data: 'AAAA' } }).ok).toBe(false);
    expect(parsePlayerMessage({ v: 1, type: 'save.state', payload: { slot: 42, data: new Uint8Array(1) } }).ok).toBe(false);
    expect(parsePlayerMessage({ v: 1, type: 'save.state', payload: { slot: '../../x', data: new Uint8Array(1) } }).ok).toBe(false);
    expect(parsePlayerMessage({ v: 1, type: 'action', payload: { action: 'rm -rf' } }).ok).toBe(false);
    expect(parsePlayerMessage({ v: 1, type: 'input', payload: { sequence: 1.5, buttons: 0, axes: {} } }).ok).toBe(false);
  });

  it('truncates oversized log messages', () => {
    const r = parsePlayerMessage({ v: 1, type: 'log', payload: { level: 'info', message: 'x'.repeat(10000) } });
    expect(r.ok && r.message.type === 'log' && r.message.payload.message.length).toBe(4000);
  });
});

describe('session state machine', () => {
  it('allows the normal lifecycle and rejects illegal jumps', () => {
    const m = new StatusMachine();
    const seen: string[] = [];
    m.onChange((s) => seen.push(s));
    expect(m.transition('running')).toBe(false); // idle -> running must pass through starting
    expect(m.transition('starting')).toBe(true);
    expect(m.transition('running')).toBe(true);
    expect(m.transition('paused')).toBe(true);
    expect(m.transition('running')).toBe(true);
    expect(m.transition('stopping')).toBe(true);
    expect(m.transition('running')).toBe(false);
    expect(m.transition('stopped')).toBe(true);
    expect(m.transition('starting')).toBe(true); // restart
    expect(seen).toEqual(['starting', 'running', 'paused', 'running', 'stopping', 'stopped', 'starting']);
  });
  it('treats self transitions as no-ops', () => {
    expect(canTransition('running', 'running')).toBe(true);
  });
});

describe('button masks', () => {
  it('round-trips', () => {
    const m = maskFromButtons(['A', 'ZR', 'Home']);
    expect(buttonsFromMask(m).sort()).toEqual(['A', 'Home', 'ZR']);
    expect(maskFromButtons([])).toBe(0);
  });
});

describe('bridge wire format', () => {
  it('round-trips frames and input payloads', () => {
    const f = encodeFrame(WireType.Video, 123456789, new Uint8Array([1, 2, 3]));
    const d = decodeFrame(f)!;
    expect(d.type).toBe(WireType.Video);
    expect(d.ts).toBe(123456789);
    expect([...d.payload]).toEqual([1, 2, 3]);
    const p = encodeInput(7, maskFromButtons(['A', 'B']), { lx: -1, ly: 0.5, rx: 0, ry: 0.25 });
    expect(decodeInput(p)).toEqual({ seq: 7, buttons: maskFromButtons(['A', 'B']), axes: { lx: -1, ly: 0.5, rx: 0, ry: 0.25 } });
  });
  it('rejects truncated frames', () => {
    expect(decodeFrame(new Uint8Array(4))).toBeUndefined();
    expect(decodeInput(new Uint8Array(3))).toBeUndefined();
  });
});
