// harn:assume tunnel-mux-frame-wire-format ref=mux-wire-codec
// Stream-mux wire codec (PLAN §4.4). This byte layout is a cross-runtime
// contract shared by the browser and the switchboard over the opaque relay:
//   frame  = type(1) ‖ streamId(4 big-endian) ‖ payload
//   packet = one or more frames, each prefixed by u32-BE frame length
// The decoder is strict: it rejects truncated and length-overflowing input
// rather than returning partial frames.

export enum FrameType {
  OPEN = 0x01,
  DATA = 0x02,
  END = 0x03,
  RESET = 0x04,
  WINDOW = 0x05,
  HTTP_HEAD = 0x07,
}

/** Max bytes in a single frame payload (PLAN §5). */
export const MAX_FRAME_PAYLOAD = 64 * 1024;
/** Max bytes in a coalesced packet / WS message body (PLAN §5). */
export const MAX_COALESCED_PACKET = 256 * 1024;
/** Coalescer flushes once buffered bytes reach this size (PLAN §4.4). */
export const COALESCE_FLUSH_BYTES = 64 * 1024;
/** Coalescer flushes buffered frames after this many ms (PLAN §4.4). */
export const COALESCE_FLUSH_MS = 16;

/** type(1) + streamId(4). */
const FRAME_HEADER = 5;
/** u32-BE length prefix in front of each frame within a packet. */
const LENGTH_PREFIX = 4;
const U32_MAX = 0xffffffff;

export interface Frame {
  type: number;
  streamId: number;
  payload: Uint8Array;
}

/** Serialize one frame to type(1) ‖ streamId(4 BE) ‖ payload. */
export function encodeFrame(frame: Frame): Uint8Array {
  if (!Number.isInteger(frame.type) || frame.type < 0 || frame.type > 0xff) {
    throw new Error(`invalid frame type ${frame.type}`);
  }
  if (!Number.isInteger(frame.streamId) || frame.streamId < 0 || frame.streamId > U32_MAX) {
    throw new Error(`invalid stream id ${frame.streamId}`);
  }
  if (frame.payload.length > MAX_FRAME_PAYLOAD) {
    throw new Error(`frame payload ${frame.payload.length} exceeds ${MAX_FRAME_PAYLOAD}`);
  }
  const out = new Uint8Array(FRAME_HEADER + frame.payload.length);
  out[0] = frame.type;
  new DataView(out.buffer).setUint32(1, frame.streamId, false);
  out.set(frame.payload, FRAME_HEADER);
  return out;
}

/** Serialize a list of frames into one length-prefixed packet. */
export function encodePacket(frames: Frame[]): Uint8Array {
  const encoded = frames.map(encodeFrame);
  const total = encoded.reduce((sum, f) => sum + LENGTH_PREFIX + f.length, 0);
  if (total > MAX_COALESCED_PACKET) {
    throw new Error(`coalesced packet ${total} exceeds ${MAX_COALESCED_PACKET}`);
  }
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const frame of encoded) {
    view.setUint32(offset, frame.length, false);
    offset += LENGTH_PREFIX;
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
}

/** Parse a packet into frames. Throws on truncated or length-overflowing input. */
export function decodePacket(bytes: Uint8Array): Frame[] {
  if (bytes.length > MAX_COALESCED_PACKET) {
    throw new Error(`packet ${bytes.length} exceeds ${MAX_COALESCED_PACKET}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames: Frame[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + LENGTH_PREFIX > bytes.length) {
      throw new Error('truncated packet: incomplete frame length prefix');
    }
    const frameLen = view.getUint32(offset, false);
    offset += LENGTH_PREFIX;
    if (frameLen < FRAME_HEADER) {
      throw new Error(`invalid frame length ${frameLen}`);
    }
    if (frameLen > FRAME_HEADER + MAX_FRAME_PAYLOAD) {
      throw new Error(`frame length ${frameLen} exceeds maximum`);
    }
    if (offset + frameLen > bytes.length) {
      throw new Error('truncated packet: incomplete frame body');
    }
    const type = bytes[offset];
    const streamId = view.getUint32(offset + 1, false);
    const payload = bytes.slice(offset + FRAME_HEADER, offset + frameLen);
    frames.push({ type, streamId, payload });
    offset += frameLen;
  }
  return frames;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface CoalescerOptions {
  flushBytes?: number;
  flushMs?: number;
  /** Injectable timer for deterministic tests; defaults to globalThis timers. */
  setTimeoutFn?: (callback: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
}

/**
 * Buffers frames and emits a coalesced packet after COALESCE_FLUSH_MS or once
 * COALESCE_FLUSH_BYTES is reached, whichever comes first (PLAN §4.4). Never lets
 * a packet exceed MAX_COALESCED_PACKET.
 */
export class PacketCoalescer {
  private buffer: Frame[] = [];
  private bufferedBytes = 0;
  private timer: TimerHandle | undefined;
  private readonly flushBytes: number;
  private readonly flushMs: number;
  private readonly setTimeoutFn: (callback: () => void, ms: number) => TimerHandle;
  private readonly clearTimeoutFn: (handle: TimerHandle) => void;

  constructor(
    private readonly onPacket: (packet: Uint8Array) => void,
    options: CoalescerOptions = {},
  ) {
    this.flushBytes = options.flushBytes ?? COALESCE_FLUSH_BYTES;
    this.flushMs = options.flushMs ?? COALESCE_FLUSH_MS;
    this.setTimeoutFn = options.setTimeoutFn ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => globalThis.clearTimeout(handle));
  }

  push(frame: Frame): void {
    if (frame.payload.length > MAX_FRAME_PAYLOAD) {
      throw new Error(`frame payload ${frame.payload.length} exceeds ${MAX_FRAME_PAYLOAD}`);
    }
    const frameBytes = LENGTH_PREFIX + FRAME_HEADER + frame.payload.length;
    // Flush the current buffer first if this frame would overflow the packet cap.
    if (this.bufferedBytes > 0 && this.bufferedBytes + frameBytes > MAX_COALESCED_PACKET) {
      this.flush();
    }
    this.buffer.push(frame);
    this.bufferedBytes += frameBytes;
    if (this.bufferedBytes >= this.flushBytes) {
      this.flush();
    } else if (this.timer === undefined) {
      this.timer = this.setTimeoutFn(() => {
        this.timer = undefined;
        this.flush();
      }, this.flushMs);
    }
  }

  /** Emit any buffered frames now. No-op when empty. */
  flush(): void {
    if (this.timer !== undefined) {
      this.clearTimeoutFn(this.timer);
      this.timer = undefined;
    }
    if (this.buffer.length === 0) return;
    const frames = this.buffer;
    this.buffer = [];
    this.bufferedBytes = 0;
    this.onPacket(encodePacket(frames));
  }

  /** Drop buffered frames and cancel any pending flush timer without emitting. */
  dispose(): void {
    if (this.timer !== undefined) {
      this.clearTimeoutFn(this.timer);
      this.timer = undefined;
    }
    this.buffer = [];
    this.bufferedBytes = 0;
  }
}
// harn:end tunnel-mux-frame-wire-format
