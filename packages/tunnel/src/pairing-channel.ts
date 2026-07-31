// harn:assume tunnel-pairing-channel-payloads ref=pairing-channel-payloads
// JSON enrollment handshake carried inside the pairing AEAD channel (PLAN §4.2
// "Inside the pairing channel"). The tunnel validates the message ENVELOPE
// (type + carrier fields); the nested switchboard identity/request/result blobs
// are opaque pass-through JSON so the tunnel stays decoupled from switchboard
// types. Each message is UTF-8 JSON sealed by the AEAD channel.
import { utf8ToBytes } from '@noble/hashes/utils.js';
import type { AeadChannel } from './aead.js';

/** host→claimant: switchboard identity, session id, and enrollment carriers. */
export interface HelloPayload {
  type: 'hello';
  switchboard: unknown;
  session_id: string;
  host_static_pub: string;
  pairing_token: string;
  relay_url: string;
  protocol: 1;
}

/** claimant→host: enrollment request, client static key, echoed token. */
export interface EnrollPayload {
  type: 'enroll';
  request: unknown;
  client_static_pub: string;
  pairing_token: string;
}

/** host→claimant: the PairingService enrollment result. */
export interface EnrolledPayload {
  type: 'enrolled';
  result: unknown;
}

/** claimant→host: final acknowledgement. */
export interface DonePayload {
  type: 'done';
}

export type PairingMessage = HelloPayload | EnrollPayload | EnrolledPayload | DonePayload;

/** A malformed pairing-channel payload (wrong type or missing/mistyped field). */
export class PairingProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairingProtocolError';
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new PairingProtocolError(`field "${key}" must be a string`);
  return value;
}

function requireKey(record: Record<string, unknown>, key: string): void {
  if (!(key in record)) throw new PairingProtocolError(`missing field "${key}"`);
}

const SESSION_ID_RE = /^[0-9a-f]{64}$/; // 32 bytes as lowercase hex (PLAN §4.1)

/** session_id must be exactly 64 lowercase hex chars, else session routing later fails. */
function requireSessionId(record: Record<string, unknown>, key: string): void {
  if (!SESSION_ID_RE.test(requireString(record, key))) {
    throw new PairingProtocolError(`field "${key}" must be 64 lowercase hex chars`);
  }
}

/** Number of bytes a base64 / base64url string decodes to, or undefined if malformed. */
function decodedByteLength(value: string): number | undefined {
  let normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = normalized.length % 4;
  if (remainder === 1) return undefined;
  if (remainder !== 0) normalized += '='.repeat(4 - remainder);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return undefined;
  try {
    return atob(normalized).length;
  } catch {
    return undefined;
  }
}

/** A static X25519 public key must base64-decode to exactly 32 bytes. */
function requireStaticKey(record: Record<string, unknown>, key: string): void {
  if (decodedByteLength(requireString(record, key)) !== 32) {
    throw new PairingProtocolError(`field "${key}" must be a base64 32-byte key`);
  }
}

/** Serialize a pairing message to UTF-8 JSON. */
export function encodePairingMessage(message: PairingMessage): Uint8Array {
  return utf8ToBytes(JSON.stringify(message));
}

/** Parse and validate a pairing message envelope from UTF-8 JSON bytes. */
export function decodePairingMessage(bytes: Uint8Array): PairingMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new PairingProtocolError('payload is not valid UTF-8 JSON');
  }
  if (!isRecord(parsed)) throw new PairingProtocolError('payload must be a JSON object');
  const type = parsed.type;
  switch (type) {
    case 'hello':
      requireKey(parsed, 'switchboard');
      requireSessionId(parsed, 'session_id');
      requireStaticKey(parsed, 'host_static_pub');
      requireString(parsed, 'pairing_token');
      requireString(parsed, 'relay_url');
      // v1 tunnel speaks only protocol 1; a mismatched version must be rejected,
      // not silently paired into a session it cannot establish.
      if (parsed.protocol !== 1) throw new PairingProtocolError('field "protocol" must equal 1');
      return parsed as unknown as HelloPayload;
    case 'enroll':
      requireKey(parsed, 'request');
      requireStaticKey(parsed, 'client_static_pub');
      requireString(parsed, 'pairing_token');
      return parsed as unknown as EnrollPayload;
    case 'enrolled':
      requireKey(parsed, 'result');
      return parsed as unknown as EnrolledPayload;
    case 'done':
      return { type: 'done' };
    default:
      throw new PairingProtocolError(`unknown pairing message type ${JSON.stringify(type)}`);
  }
}

/** Wraps an AEAD channel to seal/open validated pairing messages. */
export class PairingChannel {
  constructor(private readonly channel: AeadChannel) {}

  seal(message: PairingMessage): Uint8Array {
    return this.channel.seal(encodePairingMessage(message));
  }

  open(ciphertext: Uint8Array): PairingMessage {
    return decodePairingMessage(this.channel.open(ciphertext));
  }
}
// harn:end tunnel-pairing-channel-payloads
