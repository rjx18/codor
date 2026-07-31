// harn:assume tunnel-stream-mux ref=mux-stream-state
// Shared, transport-agnostic stream multiplexer (PLAN §4.4). ONE implementation
// runs on both endpoints so windowed flow-control credit and stream state can
// never diverge. It consumes/produces opaque packets (the driver handles AEAD):
// receivePacket() decodes frames; outbound frames are coalesced and handed to
// onPacket(). Streams are bidirectional; each direction has its own send window
// and is half-closed independently by END.
import { FrameType, MAX_FRAME_PAYLOAD, PacketCoalescer, decodePacket, type Frame } from './frames.js';

/** OPEN kind bytes (PLAN §4.4). */
export const StreamKind = {
  APP_WS: 0x01,
  HTTP: 0x02,
} as const;

/** Per-direction starting credit (PLAN §4.4/§5). */
export const DEFAULT_WINDOW = 512 * 1024;
export const APP_WS_WINDOW = 4 * 1024 * 1024;

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder('utf-8', { fatal: true });

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, false);
  return out;
}
function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export interface MuxStreamHandlers {
  /** Peer DATA arrived. The consumer must call consume(n) as it drains, to return credit. */
  onData?: (chunk: Uint8Array) => void;
  /** Peer HTTP_HEAD arrived (parsed JSON). */
  onHead?: (head: unknown) => void;
  /** Peer half-closed its direction (END). */
  onEnd?: () => void;
  /** Peer aborted the stream (RESET). */
  onReset?: (reason: string) => void;
  /** This side's send window refilled from empty — writes can resume. */
  onWritable?: () => void;
}

/** One bidirectional mux stream. */
export class MuxStream implements MuxStreamHandlers {
  onData?: (chunk: Uint8Array) => void;
  onHead?: (head: unknown) => void;
  onEnd?: () => void;
  onReset?: (reason: string) => void;
  onWritable?: () => void;

  /** credit remaining to send to the peer */
  private sendWindow: number;
  private readonly sendQueue: Uint8Array[] = [];
  private queuedBytes = 0;
  private endRequested = false;
  private localEnded = false;
  private remoteEnded = false;
  private closed = false;

  constructor(
    readonly id: number,
    readonly kind: number,
    initialWindow: number,
    private readonly mux: StreamMux,
  ) {
    this.sendWindow = initialWindow;
  }

  /** Bytes buffered because the send window is exhausted. */
  get bufferedAmount(): number {
    return this.queuedBytes;
  }

  /** Queue application bytes for the peer; sends as far as the window allows. */
  write(data: Uint8Array): void {
    if (this.endRequested || this.closed) throw new Error(`write after end/reset on stream ${this.id}`);
    if (data.length === 0) return;
    this.sendQueue.push(data);
    this.queuedBytes += data.length;
    this.pump();
  }

  /** Send a HTTP_HEAD frame (opaque JSON). Not subject to DATA flow control. */
  sendHead(head: unknown): void {
    if (this.endRequested || this.closed) throw new Error(`head after end/reset on stream ${this.id}`);
    this.mux.emit({ type: FrameType.HTTP_HEAD, streamId: this.id, payload: utf8.encode(JSON.stringify(head)) });
  }

  /**
   * Half-close this side's direction. END is DEFERRED until any window-stalled
   * DATA has drained, so it can never overtake or truncate queued bytes.
   */
  end(): void {
    if (this.endRequested || this.closed) return;
    this.endRequested = true;
    if (this.sendQueue.length === 0) this.flushEnd();
  }

  private flushEnd(): void {
    this.localEnded = true;
    this.mux.emit({ type: FrameType.END, streamId: this.id, payload: new Uint8Array(0) });
    this.maybeClose();
  }

  /** Abort the whole stream. */
  reset(reason: string): void {
    if (this.closed) return;
    const reasonBytes = utf8.encode(reason).subarray(0, 0xffff);
    this.mux.emit({ type: FrameType.RESET, streamId: this.id, payload: concat(u16(reasonBytes.length), reasonBytes) });
    this.destroy();
  }

  /** Return `n` bytes of credit to the peer as this side drains received DATA. */
  consume(n: number): void {
    if (this.closed || n <= 0) return;
    this.mux.emit({ type: FrameType.WINDOW, streamId: this.id, payload: u32(n) });
  }

  // ---- internal, called by StreamMux ----

  pump(): void {
    while (this.sendQueue.length > 0 && this.sendWindow > 0) {
      const head = this.sendQueue[0];
      const n = Math.min(head.length, this.sendWindow, MAX_FRAME_PAYLOAD);
      this.mux.emit({ type: FrameType.DATA, streamId: this.id, payload: head.subarray(0, n) });
      this.sendWindow -= n;
      this.queuedBytes -= n;
      if (n === head.length) this.sendQueue.shift();
      else this.sendQueue[0] = head.subarray(n);
    }
    // A deferred END fires only once the queue is fully drained.
    if (this.sendQueue.length === 0 && this.endRequested && !this.localEnded) this.flushEnd();
  }

  grantSendWindow(n: number): void {
    const wasStalled = this.sendWindow === 0 && this.sendQueue.length > 0;
    this.sendWindow += n;
    this.pump();
    if (wasStalled && this.sendWindow > 0) this.onWritable?.();
  }

  receiveEnd(): void {
    this.remoteEnded = true;
    this.onEnd?.();
    this.maybeClose();
  }

  private maybeClose(): void {
    if (this.localEnded && this.remoteEnded) this.destroy();
  }

  destroy(): void {
    this.closed = true;
    this.sendQueue.length = 0;
    this.queuedBytes = 0;
    this.mux.forget(this.id);
  }
}

export interface StreamMuxOptions {
  /** 'host' opens even stream ids, 'client' opens odd ids (PLAN §4.4). */
  role: 'host' | 'client';
  /**
   * Emit a coalesced outbound packet (the driver encrypts + sends it).
   * CONTRACT: the handler MUST NOT synchronously re-enter this mux (i.e. it must
   * not call receivePacket() before returning). Real transports deliver packets
   * as async WS message events on both sides; synchronous re-delivery would
   * recurse through the coalescer's flush. Hand the packet to the transport (or
   * queue it) and return.
   */
  onPacket: (packet: Uint8Array) => void;
  /** A peer-opened stream; set its handlers synchronously inside this callback. */
  onStream: (stream: MuxStream) => void;
  /** Coalescer flush cadence overrides (tests). */
  flushBytes?: number;
  flushMs?: number;
  setTimeoutFn?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

export class StreamMux {
  private readonly streams = new Map<number, MuxStream>();
  private nextId: number;
  private readonly coalescer: PacketCoalescer;
  private readonly onStream: (stream: MuxStream) => void;

  constructor(private readonly options: StreamMuxOptions) {
    this.nextId = options.role === 'client' ? 1 : 2;
    this.onStream = options.onStream;
    this.coalescer = new PacketCoalescer(options.onPacket, {
      flushBytes: options.flushBytes,
      flushMs: options.flushMs,
      setTimeoutFn: options.setTimeoutFn,
      clearTimeoutFn: options.clearTimeoutFn,
    });
  }

  /** Locally open a new stream. For APP_WS pass the browser session token. */
  openStream(kind: number, opts: { token?: Uint8Array; window?: number } = {}): MuxStream {
    const id = this.nextId;
    this.nextId += 2;
    const window = opts.window ?? (kind === StreamKind.APP_WS ? APP_WS_WINDOW : DEFAULT_WINDOW);
    const stream = new MuxStream(id, kind, window, this);
    this.streams.set(id, stream);
    let payload: Uint8Array;
    if (kind === StreamKind.APP_WS) {
      const token = opts.token ?? new Uint8Array(0);
      payload = concat(new Uint8Array([kind]), u16(token.length), token);
    } else {
      payload = new Uint8Array([kind]);
    }
    this.emit({ type: FrameType.OPEN, streamId: id, payload });
    return stream;
  }

  /** Feed one decrypted inbound packet. */
  receivePacket(packet: Uint8Array): void {
    for (const frame of decodePacket(packet)) this.handleFrame(frame);
  }

  /** Force any buffered outbound frames out as a packet now. */
  flush(): void {
    this.coalescer.flush();
  }

  /** Reset every open stream and drop buffered output (shutdown). */
  close(reason = 'closed'): void {
    for (const stream of [...this.streams.values()]) stream.reset(reason);
    this.coalescer.flush();
    this.coalescer.dispose();
  }

  emit(frame: Frame): void {
    this.coalescer.push(frame);
  }

  forget(id: number): void {
    this.streams.delete(id);
  }

  private handleFrame(frame: Frame): void {
    if (frame.type === FrameType.OPEN) {
      this.handleOpen(frame);
      return;
    }
    const stream = this.streams.get(frame.streamId);
    if (!stream) return; // unknown/closed stream (e.g. RESET raced DATA): drop
    switch (frame.type) {
      case FrameType.DATA:
        stream.onData?.(frame.payload);
        break;
      case FrameType.HTTP_HEAD:
        stream.onHead?.(this.parseHead(frame.payload));
        break;
      case FrameType.WINDOW:
        if (frame.payload.length >= 4) stream.grantSendWindow(new DataView(frame.payload.buffer, frame.payload.byteOffset, 4).getUint32(0, false));
        break;
      case FrameType.END:
        stream.receiveEnd();
        break;
      case FrameType.RESET:
        stream.onReset?.(this.parseReason(frame.payload));
        stream.destroy();
        break;
      default:
        break; // unknown frame type: ignore
    }
  }

  private handleOpen(frame: Frame): void {
    if (this.streams.has(frame.streamId) || frame.payload.length < 1) return; // dup/malformed OPEN: ignore
    const kind = frame.payload[0];
    const window = kind === StreamKind.APP_WS ? APP_WS_WINDOW : DEFAULT_WINDOW;
    const stream = new MuxStream(frame.streamId, kind, window, this);
    this.streams.set(frame.streamId, stream);
    if (kind === StreamKind.APP_WS && frame.payload.length >= 3) {
      const tokenLen = new DataView(frame.payload.buffer, frame.payload.byteOffset + 1, 2).getUint16(0, false);
      (stream as MuxStream & { openToken?: Uint8Array }).openToken = frame.payload.subarray(3, 3 + tokenLen);
    }
    this.onStream(stream);
  }

  private parseHead(payload: Uint8Array): unknown {
    try {
      return JSON.parse(utf8Decode.decode(payload));
    } catch {
      return null;
    }
  }

  private parseReason(payload: Uint8Array): string {
    if (payload.length < 2) return '';
    const len = new DataView(payload.buffer, payload.byteOffset, 2).getUint16(0, false);
    try {
      return utf8Decode.decode(payload.subarray(2, 2 + len));
    } catch {
      return '';
    }
  }
}

/** The app-WS session token a peer sent on OPEN (host reads this to dial loopback). */
export function openToken(stream: MuxStream): Uint8Array | undefined {
  return (stream as MuxStream & { openToken?: Uint8Array }).openToken;
}

// App-WS message framing. The mux DATA stream is a byte stream that fragments at
// window/64 KiB boundaries, so a WebSocket MESSAGE must be length-delimited to
// survive reassembly — both the switchboard and browser app-WS bridges use these.
/** Length-delimit one WS message (u32-BE length ‖ bytes) for the mux byte stream. */
export function frameMessage(message: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + message.length);
  new DataView(out.buffer).setUint32(0, message.length, false);
  out.set(message, 4);
  return out;
}

/** Reassembles whole length-delimited messages from a fragmented byte stream. */
export class MessageReassembler {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    const combined = new Uint8Array(this.buffer.length + chunk.length);
    combined.set(this.buffer);
    combined.set(chunk, this.buffer.length);
    this.buffer = combined;
    const messages: Uint8Array[] = [];
    while (this.buffer.length >= 4) {
      const length = new DataView(this.buffer.buffer, this.buffer.byteOffset, 4).getUint32(0, false);
      if (this.buffer.length < 4 + length) break;
      messages.push(this.buffer.slice(4, 4 + length));
      this.buffer = this.buffer.slice(4 + length);
    }
    return messages;
  }
}
// harn:end tunnel-stream-mux
