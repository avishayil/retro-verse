// Binary framing for the native bridge media WebSocket (bridge <-> webview).
// Frame: [u8 type][u64 big-endian timestamp in microseconds][payload]
// Must stay in sync with native/eden-bridge/Sources/EdenBridgeCore/Wire.swift.

export enum WireType {
  Hello = 0x01, // webview -> bridge: payload = UTF-8 token
  Config = 0x10, // bridge -> webview: payload = JSON {codec, width, height, description(base64 avcC), sampleRate, channels}
  Video = 0x11, // bridge -> webview: payload = [u8 flags(bit0=key)] + AVCC sample
  Audio = 0x12, // bridge -> webview: payload = interleaved float32 LE PCM
  Telemetry = 0x13, // bridge -> webview: payload = JSON StreamTelemetry
  Error = 0x14, // bridge -> webview: payload = UTF-8 message
  Input = 0x20, // webview -> bridge: payload = [u32 seq][u32 buttons][4 x f32 axes]
  Ping = 0x21, // webview -> bridge: payload = empty; bridge echoes as Pong with same ts
  Pong = 0x22,
  Turbo = 0x23, // webview -> bridge: payload = [u8 on]; bridge toggles the emulator's turbo hotkey to match
}

export const HEADER_BYTES = 9;

// Frames are always freshly allocated (never SharedArrayBuffer-backed), so they can go straight to WebSocket.send.
export function encodeFrame(type: WireType, tsMicros: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(HEADER_BYTES + payload.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, type);
  dv.setBigUint64(1, BigInt(Math.max(0, Math.floor(tsMicros))));
  out.set(payload, HEADER_BYTES);
  return out;
}

export interface DecodedFrame {
  type: WireType;
  ts: number;
  payload: Uint8Array;
}

export function decodeFrame(buf: ArrayBuffer | Uint8Array): DecodedFrame | undefined {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.byteLength < HEADER_BYTES) return undefined;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { type: dv.getUint8(0) as WireType, ts: Number(dv.getBigUint64(1)), payload: bytes.subarray(HEADER_BYTES) };
}

export function encodeInput(seq: number, buttons: number, axes: { lx: number; ly: number; rx: number; ry: number }): Uint8Array<ArrayBuffer> {
  const p = new Uint8Array(24);
  const dv = new DataView(p.buffer);
  dv.setUint32(0, seq >>> 0);
  dv.setUint32(4, buttons >>> 0);
  dv.setFloat32(8, axes.lx);
  dv.setFloat32(12, axes.ly);
  dv.setFloat32(16, axes.rx);
  dv.setFloat32(20, axes.ry);
  return p;
}

export function decodeInput(p: Uint8Array): { seq: number; buttons: number; axes: { lx: number; ly: number; rx: number; ry: number } } | undefined {
  if (p.byteLength !== 24) return undefined;
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  return { seq: dv.getUint32(0), buttons: dv.getUint32(4), axes: { lx: dv.getFloat32(8), ly: dv.getFloat32(12), rx: dv.getFloat32(16), ry: dv.getFloat32(20) } };
}
