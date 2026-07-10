import sodium from 'sodium-native';

import {
  type AuthChallenge,
  signChallenge,
} from '../crypto/challenge.js';
import type { CryptoVault } from '../crypto/pairing.js';

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ignoreStreamError = (): void => undefined;

export interface NoiseDuplex {
  readonly handshakeHash: Uint8Array | null;
  readonly remotePublicKey?: Uint8Array;
  destroyed?: boolean;
  on(event: 'data', listener: (chunk: Uint8Array) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  off(event: 'data', listener: (chunk: Uint8Array) => void): this;
  off(event: 'close', listener: () => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  write(chunk: Uint8Array): boolean;
  destroy(error?: Error): void;
}

export interface TransportEnvelope<T = unknown> {
  envelope_id: string;
  room: string;
  kind: string;
  payload: T;
}

export interface OutgoingEnvelope<T = unknown> {
  room: string;
  kind: string;
  payload: T;
}

type HelloPayload =
  | { type: 'identity'; device_id: string; transcript_hash: string }
  | { type: 'challenge'; challenge: AuthChallenge }
  | { type: 'response'; challenge_id: string; signature: string }
  | { type: 'auth_ok'; device_id: string };

type EnvelopeHandler = (envelope: TransportEnvelope, peerId: string) => void | Promise<void>;
type AuthHandler = (peerId: string) => void;
type RejectHandler = (error: Error) => void;

function encodeBase32(value: bigint, length: number): string {
  let output = '';
  for (let index = 0; index < length; index++) {
    output = ULID_ALPHABET[Number(value & 31n)]! + output;
    value >>= 5n;
  }
  return output;
}

export function envelopeUlid(now = Date.now): string {
  const random = Buffer.alloc(10);
  sodium.randombytes_buf(random);
  let randomness = 0n;
  for (const byte of random) randomness = (randomness << 8n) | BigInt(byte);
  return `${encodeBase32(BigInt(now()), 10)}${encodeBase32(randomness, 16)}`;
}

export function validateEnvelope(value: unknown): TransportEnvelope {
  if (typeof value !== 'object' || value === null) throw new Error('envelope must be an object');
  const candidate = value as Partial<TransportEnvelope>;
  if (typeof candidate.envelope_id !== 'string' || !ULID_PATTERN.test(candidate.envelope_id)) {
    throw new Error('envelope_id must be a ULID');
  }
  if (typeof candidate.room !== 'string') throw new Error('envelope room must be a string');
  if (typeof candidate.kind !== 'string' || candidate.kind.length === 0) {
    throw new Error('envelope kind must be a non-empty string');
  }
  if (!Object.hasOwn(candidate, 'payload')) throw new Error('envelope payload is required');
  return candidate as TransportEnvelope;
}

export function encodeEnvelope(envelope: TransportEnvelope): Buffer {
  const body = Buffer.from(JSON.stringify(validateEnvelope(envelope)), 'utf8');
  if (body.length > MAX_FRAME_BYTES) throw new Error('transport frame is too large');
  const framed = Buffer.allocUnsafe(4 + body.length);
  framed.writeUInt32LE(body.length, 0);
  body.copy(framed, 4);
  return framed;
}

export class EnvelopeDecoder {
  private buffered = Buffer.alloc(0);

  push(chunk: Uint8Array): TransportEnvelope[] {
    this.buffered = Buffer.concat([this.buffered, Buffer.from(chunk)]);
    const envelopes: TransportEnvelope[] = [];
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32LE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) throw new Error('invalid transport frame length');
      if (this.buffered.length < 4 + length) break;
      const body = this.buffered.subarray(4, 4 + length);
      this.buffered = this.buffered.subarray(4 + length);
      envelopes.push(validateEnvelope(JSON.parse(body.toString('utf8'))));
    }
    return envelopes;
  }
}

function transcriptHash(stream: NoiseDuplex): string {
  if (!stream.handshakeHash || stream.handshakeHash.length === 0) {
    throw new Error('Noise stream is missing its handshake hash');
  }
  const digest = Buffer.alloc(sodium.crypto_generichash_BYTES);
  sodium.crypto_generichash(digest, Buffer.from(stream.handshakeHash));
  return digest.toString('base64url');
}

// harn:assume envelope-ids-not-room-seq-for-dedup ref=reliable-envelope-channel
// harn:assume peer-auth-challenge-before-traffic ref=authenticated-noise-stream
export class ReliablePeer {
  private stream: NoiseDuplex | undefined;
  private decoder = new EnvelopeDecoder();
  private readonly pending = new Map<string, TransportEnvelope>();
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private processing = Promise.resolve();
  private currentTranscript = '';
  private remoteIdentity: string | undefined;
  private verifiedRemote = false;
  private acceptedByRemote = false;
  private ready = false;
  private closed = false;
  private readonly stopWatchingRevocation: () => void;
  private readonly dataListener = (chunk: Uint8Array): void => this.receive(chunk);
  private readonly closeListener = (): void => this.detach();
  private readonly errorListener = (): void => this.detach();

  constructor(
    private readonly crypto: CryptoVault,
    private readonly onEnvelope: EnvelopeHandler,
    private readonly onAuthenticated: AuthHandler,
    private readonly onRejected: RejectHandler,
  ) {
    this.stopWatchingRevocation = crypto.keys.onPeerRevoked((deviceId) => {
      if (deviceId === this.remoteIdentity) this.stream?.destroy(new Error('peer revoked'));
    });
  }

  get peerId(): string | undefined {
    return this.remoteIdentity;
  }

  get authenticated(): boolean {
    return this.ready && this.stream !== undefined;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  attach(stream: NoiseDuplex): void {
    if (this.closed) throw new Error('peer channel is closed');
    this.removeStreamListeners();
    this.stream = stream;
    this.decoder = new EnvelopeDecoder();
    this.currentTranscript = transcriptHash(stream);
    this.verifiedRemote = false;
    this.acceptedByRemote = false;
    this.ready = false;
    stream.on('data', this.dataListener);
    stream.on('close', this.closeListener);
    stream.on('error', this.errorListener);
    this.sendHello({
      type: 'identity',
      device_id: this.crypto.keys.identity.device_id,
      transcript_hash: this.currentTranscript,
    });
  }

  send<T>(outgoing: OutgoingEnvelope<T>): string {
    if (outgoing.kind === 'hello' || outgoing.kind === 'ack') {
      throw new Error(`application envelopes cannot use reserved kind '${outgoing.kind}'`);
    }
    const envelope: TransportEnvelope<T> = { envelope_id: envelopeUlid(), ...outgoing };
    this.pending.set(envelope.envelope_id, envelope);
    if (this.authenticated) this.write(envelope);
    return envelope.envelope_id;
  }

  sendRunEventAck(room: string, rpcId: string, eventIndex: number): string {
    if (!Number.isSafeInteger(eventIndex) || eventIndex < 0) throw new Error('event_index must be nonnegative');
    return this.send({ room, kind: 'run_event_ack', payload: { rpc_id: rpcId, event_index: eventIndex } });
  }

  disconnect(): void {
    this.stream?.destroy();
  }

  close(): void {
    this.closed = true;
    this.stopWatchingRevocation();
    const stream = this.stream;
    this.removeStreamListeners();
    stream?.on('error', ignoreStreamError);
    stream?.destroy();
    this.stream = undefined;
  }

  private receive(chunk: Uint8Array): void {
    let envelopes: TransportEnvelope[];
    try {
      envelopes = this.decoder.push(chunk);
    } catch (error) {
      this.reject(error);
      return;
    }
    for (const envelope of envelopes) {
      this.processing = this.processing.then(() => this.handle(envelope)).catch((error: unknown) => {
        this.reject(error);
      });
    }
  }

  private async handle(envelope: TransportEnvelope): Promise<void> {
    if (envelope.kind === 'hello') {
      this.handleHello(envelope.payload as HelloPayload);
      return;
    }
    if (!this.authenticated) throw new Error('application envelope received before peer authentication');
    if (envelope.kind === 'ack') {
      const payload = envelope.payload as { envelope_id?: unknown };
      if (typeof payload.envelope_id !== 'string') throw new Error('ack is missing envelope_id');
      this.pending.delete(payload.envelope_id);
      return;
    }
    if (this.seen.has(envelope.envelope_id)) {
      this.sendAck(envelope.envelope_id);
      return;
    }
    await this.onEnvelope(envelope, this.remoteIdentity!);
    this.remember(envelope.envelope_id);
    this.sendAck(envelope.envelope_id);
  }

  private handleHello(payload: HelloPayload): void {
    if (payload.type === 'identity') {
      if (payload.transcript_hash !== this.currentTranscript) throw new Error('Noise transcript mismatch');
      if (!this.crypto.keys.getPeer(payload.device_id)) throw new Error('peer is not enrolled');
      if (this.remoteIdentity && this.remoteIdentity !== payload.device_id) {
        throw new Error('peer identity changed across reconnect');
      }
      this.remoteIdentity = payload.device_id;
      const challenge = this.crypto.challenges.issue(payload.device_id, this.currentTranscript);
      this.sendHello({ type: 'challenge', challenge });
      return;
    }
    if (payload.type === 'challenge') {
      if (payload.challenge.transcript_hash !== this.currentTranscript) throw new Error('challenge transcript mismatch');
      this.sendHello({
        type: 'response',
        challenge_id: payload.challenge.challenge_id,
        signature: signChallenge(payload.challenge, this.crypto.keys.identity),
      });
      return;
    }
    if (payload.type === 'response') {
      const peer = this.crypto.challenges.verify(payload.challenge_id, payload.signature);
      if (this.remoteIdentity !== peer.device_id) throw new Error('challenge identity mismatch');
      this.verifiedRemote = true;
      this.sendHello({ type: 'auth_ok', device_id: this.crypto.keys.identity.device_id });
      this.becomeReady();
      return;
    }
    if (payload.type === 'auth_ok') {
      if (payload.device_id !== this.remoteIdentity) throw new Error('auth acknowledgement identity mismatch');
      this.acceptedByRemote = true;
      this.becomeReady();
      return;
    }
    throw new Error('unknown hello payload');
  }

  private becomeReady(): void {
    if (this.ready || !this.verifiedRemote || !this.acceptedByRemote || !this.remoteIdentity) return;
    this.ready = true;
    this.onAuthenticated(this.remoteIdentity);
    for (const envelope of this.pending.values()) this.write(envelope);
  }

  private sendHello(payload: HelloPayload): void {
    this.write({ envelope_id: envelopeUlid(), room: '', kind: 'hello', payload });
  }

  private sendAck(envelopeId: string): void {
    this.write({
      envelope_id: envelopeUlid(),
      room: '',
      kind: 'ack',
      payload: { envelope_id: envelopeId },
    });
  }

  private write(envelope: TransportEnvelope): void {
    if (!this.stream || this.stream.destroyed) return;
    this.stream.write(encodeEnvelope(envelope));
  }

  private remember(envelopeId: string): void {
    this.seen.add(envelopeId);
    this.seenOrder.push(envelopeId);
    if (this.seenOrder.length <= 10_000) return;
    this.seen.delete(this.seenOrder.shift()!);
  }

  private reject(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.onRejected(normalized);
    this.stream?.destroy(normalized);
  }

  private detach(): void {
    this.removeStreamListeners();
    this.stream = undefined;
    this.ready = false;
    this.verifiedRemote = false;
    this.acceptedByRemote = false;
  }

  private removeStreamListeners(): void {
    if (!this.stream) return;
    this.stream.off('data', this.dataListener);
    this.stream.off('close', this.closeListener);
    this.stream.off('error', this.errorListener);
  }
}
// harn:end peer-auth-challenge-before-traffic
// harn:end envelope-ids-not-room-seq-for-dedup
