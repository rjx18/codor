import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { deviceKeyId, generateTunnelKeypair, type TunnelKeypair } from '@codor/tunnel';

import { privateJsonWrite } from '../crypto/keys.js';

// harn:assume relay-store-persistence ref=relay-store
// Sealed switchboard relay record (PLAN §4.5) at <dataDir>/crypto/relay.json,
// written 0600 via privateJsonWrite. session_id (32 bytes as 64-hex) and the
// host_static X25519 keypair are generated once on first enable and stay stable
// across restarts so paired devices keep connecting; rotate() replaces session_id
// (paired devices must then re-pair).
export const DEFAULT_RELAY_URL = 'https://relay.codor.app';
// The workers.dev alias terminates at the same Worker + Durable Objects as the
// canonical hostname, but its SNI is NOT filtered on networks that reset the vanity
// name for non-browser TLS (a Node dial exposes SNI; a browser gets ECH and does not).
// So a Node switchboard can reach the relay here when relay.codor.app is unreachable.
export const DEFAULT_RELAY_ALIAS = 'https://codor-relay.junweixiong.workers.dev';
const RELAY_FILE = 'relay.json';
const SESSION_ID_BYTES = 32;

export interface RelayDeviceRecord {
  device_id: string;
  /** hex of SHA-256(client_static_pub)[0..8] — the session-handshake key id. */
  kid: string;
  /** base64 X25519 public key. */
  client_static_pub: string;
  label?: string;
  enrolled_at: string;
}

export interface RelayRecord {
  version: 1;
  enabled: boolean;
  relay_url: string;
  /** 64 lowercase hex chars (32 bytes). Empty until first enable. */
  session_id: string;
  host_static: { pub: string; priv: string };
  devices: RelayDeviceRecord[];
  /** The dial URL that last established a session — the reachability "winner",
   *  a member of {DEFAULT_RELAY_URL, DEFAULT_RELAY_ALIAS}. Meaningful only while
   *  relay_url is the default canonical; absent means dial the configured URL. */
  dial_url?: string;
}

export interface RelayStoreOptions {
  randomBytes?: (length: number) => Uint8Array;
  now?: () => number;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const fromB64 = (value: string) => new Uint8Array(Buffer.from(value, 'base64'));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

function defaultRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function emptyRecord(): RelayRecord {
  return { version: 1, enabled: false, relay_url: DEFAULT_RELAY_URL, session_id: '', host_static: { pub: '', priv: '' }, devices: [] };
}

export class RelayStore {
  private readonly path: string;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly now: () => number;
  private record: RelayRecord;

  constructor(dataDir: string, options: RelayStoreOptions = {}) {
    this.path = join(dataDir, 'crypto', RELAY_FILE);
    this.randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.now = options.now ?? Date.now;
    this.record = this.read();
  }

  private read(): RelayRecord {
    if (!existsSync(this.path)) return emptyRecord();
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<RelayRecord>;
      return { ...emptyRecord(), ...parsed, devices: parsed.devices ?? [] };
    } catch {
      return emptyRecord();
    }
  }

  private write(): void {
    privateJsonWrite(this.path, this.record);
  }

  /** Ensure a session id and host static keypair exist (generated once). */
  private ensureMaterial(): void {
    if (!this.record.session_id) this.record.session_id = hex(this.randomBytes(SESSION_ID_BYTES));
    if (!this.record.host_static.pub || !this.record.host_static.priv) {
      const keypair = generateTunnelKeypair(this.randomBytes);
      this.record.host_static = { pub: b64(keypair.publicKey), priv: b64(keypair.secretKey) };
    }
  }

  get enabled(): boolean {
    return this.record.enabled;
  }

  get relayUrl(): string {
    return this.record.relay_url;
  }

  /**
   * The URL RelayLink should dial: the cached winner when the configured URL is the
   * default canonical AND the winner is a member of the {canonical, alias} pair;
   * otherwise the configured URL. It NEVER serves an alias winner for a custom
   * relay_url — the store, not the caller, enforces that scope.
   */
  get dialUrl(): string {
    if (
      this.record.relay_url === DEFAULT_RELAY_URL &&
      (this.record.dial_url === DEFAULT_RELAY_URL || this.record.dial_url === DEFAULT_RELAY_ALIAS)
    ) {
      return this.record.dial_url;
    }
    return this.record.relay_url;
  }

  /** The other member of the {canonical, alias} pair to fail over to, or undefined for
   *  a custom relay_url (which must never fall back to our alias). */
  get dialFallback(): string | undefined {
    if (this.record.relay_url !== DEFAULT_RELAY_URL) return undefined;
    return this.dialUrl === DEFAULT_RELAY_ALIAS ? DEFAULT_RELAY_URL : DEFAULT_RELAY_ALIAS;
  }

  /** Cache the URL that established a session as the winner. A no-op unless the
   *  configured URL is the default canonical and `url` is a member of the pair; a
   *  custom relay_url instead drops any stale winner. */
  setDialWinner(url: string): void {
    if (this.record.relay_url !== DEFAULT_RELAY_URL) {
      if (this.record.dial_url !== undefined) {
        this.record.dial_url = undefined;
        this.write();
      }
      return;
    }
    if (url !== DEFAULT_RELAY_URL && url !== DEFAULT_RELAY_ALIAS) return;
    if (this.record.dial_url === url) return;
    this.record.dial_url = url;
    this.write();
  }

  /** 64-hex session id (empty before first enable). */
  get sessionId(): string {
    return this.record.session_id;
  }

  get sessionIdBytes(): Uint8Array {
    return new Uint8Array(Buffer.from(this.record.session_id, 'hex'));
  }

  get hostStatic(): TunnelKeypair {
    return { publicKey: fromB64(this.record.host_static.pub), secretKey: fromB64(this.record.host_static.priv) };
  }

  get hostStaticPubB64(): string {
    return this.record.host_static.pub;
  }

  listDevices(): RelayDeviceRecord[] {
    return [...this.record.devices];
  }

  /** Enable the relay tier, generating session id + host static keypair on first use. */
  enable(relayUrl?: string): void {
    if (relayUrl && relayUrl !== this.record.relay_url) {
      this.record.relay_url = relayUrl;
      this.record.dial_url = undefined; // a URL change invalidates the cached winner
    }
    this.ensureMaterial();
    this.record.enabled = true;
    this.write();
  }

  disable(): void {
    this.record.enabled = false;
    this.write();
  }

  /** Override the relay URL (e.g. from CODOR_TUNNEL_URL) without changing enablement. */
  setRelayUrl(url: string): void {
    if (this.record.relay_url === url) return;
    this.record.relay_url = url;
    this.record.dial_url = undefined; // a URL change invalidates the cached winner
    this.write();
  }

  /** Replace the session id; paired devices must re-pair to learn the new one. */
  rotate(): string {
    this.record.session_id = hex(this.randomBytes(SESSION_ID_BYTES));
    this.write();
    return this.record.session_id;
  }

  /** Record (or refresh) a device enrolled through relay pairing. */
  addDevice(input: { device_id: string; client_static_pub: string; label?: string }): RelayDeviceRecord {
    const kid = hex(deviceKeyId(fromB64(input.client_static_pub)));
    const record: RelayDeviceRecord = {
      device_id: input.device_id,
      kid,
      client_static_pub: input.client_static_pub,
      label: input.label,
      enrolled_at: new Date(this.now()).toISOString(),
    };
    this.record.devices = [...this.record.devices.filter((d) => d.device_id !== input.device_id), record];
    this.write();
    return record;
  }

  removeDevice(deviceId: string): void {
    const next = this.record.devices.filter((d) => d.device_id !== deviceId);
    if (next.length !== this.record.devices.length) {
      this.record.devices = next;
      this.write();
    }
  }

  /** Look up a device's base64 client static key by its hex kid (session handshake). */
  clientStaticPubByKid(kidHex: string): string | undefined {
    return this.record.devices.find((d) => d.kid === kidHex)?.client_static_pub;
  }
}
// harn:end relay-store-persistence
