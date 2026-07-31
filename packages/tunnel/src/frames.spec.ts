import { describe, expect, it } from 'vitest';
import {
  COALESCE_FLUSH_BYTES,
  Frame,
  FrameType,
  MAX_COALESCED_PACKET,
  MAX_FRAME_PAYLOAD,
  PacketCoalescer,
  decodePacket,
  encodeFrame,
  encodePacket,
} from './frames.js';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe('encodeFrame', () => {
  it('lays out type(1) ‖ streamId(4 BE) ‖ payload', () => {
    const encoded = encodeFrame({ type: FrameType.DATA, streamId: 0x01020304, payload: bytes(0xaa, 0xbb) });
    expect([...encoded]).toEqual([0x02, 0x01, 0x02, 0x03, 0x04, 0xaa, 0xbb]);
  });

  it('rejects oversized payloads and out-of-range fields', () => {
    expect(() => encodeFrame({ type: FrameType.DATA, streamId: 0, payload: new Uint8Array(MAX_FRAME_PAYLOAD + 1) })).toThrow();
    expect(() => encodeFrame({ type: 256, streamId: 0, payload: bytes() })).toThrow();
    expect(() => encodeFrame({ type: FrameType.DATA, streamId: -1, payload: bytes() })).toThrow();
    expect(() => encodeFrame({ type: FrameType.DATA, streamId: 0x1_0000_0000, payload: bytes() })).toThrow();
  });
});

describe('packet round-trip', () => {
  it('round-trips a single frame', () => {
    const frame: Frame = { type: FrameType.OPEN, streamId: 1, payload: bytes(1, 2, 3) };
    const decoded = decodePacket(encodePacket([frame]));
    expect(decoded).toHaveLength(1);
    expect(decoded[0].type).toBe(FrameType.OPEN);
    expect(decoded[0].streamId).toBe(1);
    expect([...decoded[0].payload]).toEqual([1, 2, 3]);
  });

  it('round-trips several coalesced frames in order', () => {
    const frames: Frame[] = [
      { type: FrameType.OPEN, streamId: 1, payload: bytes(0x01) },
      { type: FrameType.DATA, streamId: 1, payload: bytes(0xde, 0xad, 0xbe, 0xef) },
      { type: FrameType.WINDOW, streamId: 3, payload: bytes() },
      { type: FrameType.END, streamId: 1, payload: bytes() },
    ];
    const decoded = decodePacket(encodePacket(frames));
    expect(decoded.map((f) => [f.type, f.streamId, [...f.payload]])).toEqual(
      frames.map((f) => [f.type, f.streamId, [...f.payload]]),
    );
  });

  it('round-trips an empty packet', () => {
    expect(decodePacket(encodePacket([]))).toEqual([]);
  });

  it('decodes a frame whose payload is exactly MAX_FRAME_PAYLOAD', () => {
    const payload = new Uint8Array(MAX_FRAME_PAYLOAD).fill(0x7f);
    const decoded = decodePacket(encodePacket([{ type: FrameType.DATA, streamId: 5, payload }]));
    expect(decoded[0].payload).toHaveLength(MAX_FRAME_PAYLOAD);
  });
});

describe('decodePacket strictness', () => {
  it('rejects a truncated length prefix', () => {
    expect(() => decodePacket(bytes(0x00, 0x00))).toThrow(/truncated/);
  });

  it('rejects a truncated frame body', () => {
    // Claims a 6-byte frame but only supplies 5.
    expect(() => decodePacket(bytes(0x00, 0x00, 0x00, 0x06, 0x02, 0x00, 0x00, 0x00, 0x00))).toThrow(/truncated/);
  });

  it('rejects a frame length below the header size', () => {
    expect(() => decodePacket(bytes(0x00, 0x00, 0x00, 0x04, 0x02, 0x00, 0x00, 0x00))).toThrow(/invalid frame length/);
  });

  it('rejects a frame length claiming more than MAX_FRAME_PAYLOAD', () => {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, 5 + MAX_FRAME_PAYLOAD + 1, false);
    expect(() => decodePacket(new Uint8Array(view.buffer))).toThrow(/exceeds maximum/);
  });

  it('decodes correctly from a non-zero byteOffset view', () => {
    const packet = encodePacket([{ type: FrameType.DATA, streamId: 9, payload: bytes(0x11, 0x22) }]);
    const padded = new Uint8Array(packet.length + 3);
    padded.set(packet, 3);
    const view = padded.subarray(3);
    const decoded = decodePacket(view);
    expect(decoded[0].streamId).toBe(9);
    expect([...decoded[0].payload]).toEqual([0x11, 0x22]);
  });
});

describe('PacketCoalescer', () => {
  it('flushes buffered frames after the timer fires', () => {
    let scheduled: (() => void) | undefined;
    const packets: Uint8Array[] = [];
    const coalescer = new PacketCoalescer((p) => packets.push(p), {
      setTimeoutFn: (cb) => {
        scheduled = cb;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: () => {
        scheduled = undefined;
      },
    });
    coalescer.push({ type: FrameType.DATA, streamId: 1, payload: bytes(1) });
    coalescer.push({ type: FrameType.DATA, streamId: 1, payload: bytes(2) });
    expect(packets).toHaveLength(0); // buffered, waiting for timer
    scheduled?.();
    expect(packets).toHaveLength(1);
    expect(decodePacket(packets[0]).map((f) => [...f.payload])).toEqual([[1], [2]]);
  });

  it('flushes immediately when the byte threshold is reached', () => {
    const packets: Uint8Array[] = [];
    const coalescer = new PacketCoalescer((p) => packets.push(p), {
      flushBytes: 16,
      setTimeoutFn: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimeoutFn: () => {},
    });
    coalescer.push({ type: FrameType.DATA, streamId: 1, payload: new Uint8Array(20) });
    expect(packets).toHaveLength(1);
  });

  it('never emits a packet exceeding MAX_COALESCED_PACKET', () => {
    const packets: Uint8Array[] = [];
    const coalescer = new PacketCoalescer((p) => packets.push(p), {
      flushBytes: MAX_COALESCED_PACKET, // disable size-triggered flush until the cap
      setTimeoutFn: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimeoutFn: () => {},
    });
    for (let i = 0; i < 6; i++) {
      coalescer.push({ type: FrameType.DATA, streamId: 1, payload: new Uint8Array(MAX_FRAME_PAYLOAD) });
    }
    coalescer.flush();
    for (const packet of packets) {
      expect(packet.length).toBeLessThanOrEqual(MAX_COALESCED_PACKET);
    }
    // All six frames survive across the forced splits.
    const totalFrames = packets.reduce((n, p) => n + decodePacket(p).length, 0);
    expect(totalFrames).toBe(6);
  });

  it('dispose drops buffered frames without emitting', () => {
    const packets: Uint8Array[] = [];
    const coalescer = new PacketCoalescer((p) => packets.push(p), {
      setTimeoutFn: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimeoutFn: () => {},
    });
    coalescer.push({ type: FrameType.DATA, streamId: 1, payload: bytes(1) });
    coalescer.dispose();
    coalescer.flush();
    expect(packets).toHaveLength(0);
  });

  it('exposes the specified flush byte default', () => {
    expect(COALESCE_FLUSH_BYTES).toBe(64 * 1024);
  });
});
