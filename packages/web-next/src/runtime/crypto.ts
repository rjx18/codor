import sodium from 'libsodium-wrappers';
import {
  PairingChannel,
  PakeClaimant,
  decodePairingMessage,
  generateTunnelKeypair,
  normalizeCode,
  splitCode,
  type PairingMessage,
} from '@codor/tunnel';
import { relayDialCandidates } from './relay-dial.js';
import { relayFetch } from './relay-transport.js';
import { type RelayComputer, selectActiveComputer } from './relay-records.js';
import {
  type Kv,
  type RelayMaterial,
  forgetComputerStore,
  hydrateActive,
  listComputers,
  migrateIfNeeded,
  recordPairedComputer,
  renameComputer,
  switchToComputer,
} from './relay-store.js';

export interface BrowserPublicIdentity {
  device_id: string;
  sign_public_key: string;
  encryption_public_key: string;
}

interface BrowserIdentity extends BrowserPublicIdentity {
  sign_secret_key: string;
  encryption_secret_key: string;
}

export interface StoredBrowserRoomKey {
  room: string;
  generation: number;
  key: string;
}

export interface StoredBrowserAccess {
  origin: string;
  authority?: 'device' | 'operator';
  token?: string;
}

interface BrowserPeer extends BrowserPublicIdentity {
  kind: 'device' | 'switchboard';
  label?: string;
}

interface PairingResult {
  switchboard: BrowserPublicIdentity;
  room_keys: { room: string; generation: number; sealed_key: string }[];
}

interface BrowserAuthChallenge {
  challenge_id: string;
  server_nonce: string;
  transcript_hash: string;
  expires_at: string;
}

// harn:assume codor-runtime-identity-is-a-clean-break ref=browser-runtime-identity
export const BROWSER_CRYPTO_DATABASE = 'codor-crypto-v1';
const STORE = 'state';
const AUTH_CHALLENGE_DOMAIN = new TextEncoder().encode('codor-auth-v1\0');
// harn:end codor-runtime-identity-is-a-clean-break
let activeAccessToken: string | undefined;
const trustedPairingAttempts = new Map<string, Promise<boolean>>();

function encode(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function concatBytes(...values: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((length, value) => length + value.length, 0));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

function challengeBytes(challenge: BrowserAuthChallenge): Uint8Array {
  const nonce = decode(challenge.server_nonce);
  const transcript = decode(challenge.transcript_hash);
  if (nonce.length !== 32 || transcript.length !== 32) {
    throw new Error('device authentication challenge is malformed');
  }
  return concatBytes(AUTH_CHALLENGE_DOMAIN, nonce, transcript);
}

export function setActiveBrowserAccessToken(token: string): string {
  activeAccessToken = token;
  return token;
}

export function currentBrowserAccessToken(fallback = ''): string {
  return activeAccessToken ?? fallback;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BROWSER_CRYPTO_DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

async function readState<T>(key: string): Promise<T | undefined> {
  const database = await openDatabase();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const request = database.transaction(STORE).objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
    });
  } finally {
    database.close();
  }
}

async function writeState(key: string, value: unknown): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB write failed'));
    });
  } finally {
    database.close();
  }
}

async function deleteState(key: string): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB delete failed'));
    });
  } finally {
    database.close();
  }
}

async function readAllState(): Promise<unknown[]> {
  const database = await openDatabase();
  try {
    return await new Promise<unknown[]>((resolve, reject) => {
      const request = database.transaction(STORE).objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
    });
  } finally {
    database.close();
  }
}

async function listStateKeys(): Promise<string[]> {
  const database = await openDatabase();
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const request = database.transaction(STORE).objectStore(STORE).getAllKeys();
      request.onsuccess = () => resolve(request.result as string[]);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
    });
  } finally {
    database.close();
  }
}

/** The IndexedDB `state` store as the KV seam the multi-computer store runs over.
 *  `lock` serializes every index mutation and the boot hydrate across tabs via the
 *  Web Locks API (a single named lock) so two tabs on one IndexedDB can't race an
 *  index read-modify-write; absent the API, it degrades to a straight pass-through. */
const browserKv: Kv = {
  get: (key) => readState(key),
  put: writeState,
  delete: deleteState,
  keys: listStateKeys,
  lock: <T,>(fn: () => Promise<T>): Promise<T> => (typeof navigator !== 'undefined' && navigator.locks
    ? (navigator.locks.request('codor-relay-store', fn) as Promise<T>)
    : fn()),
};

// harn:assume single-crypto-suite-libsodium ref=browser-libsodium-suite
export async function ensureBrowserIdentity(): Promise<BrowserPublicIdentity> {
  await sodium.ready;
  let identity = await readState<BrowserIdentity>('identity');
  if (!identity) {
    const signing = sodium.crypto_sign_keypair();
    const encryption = sodium.crypto_box_keypair();
    const signPublicKey = encode(signing.publicKey);
    identity = {
      device_id: signPublicKey,
      sign_public_key: signPublicKey,
      sign_secret_key: encode(signing.privateKey),
      encryption_public_key: encode(encryption.publicKey),
      encryption_secret_key: encode(encryption.privateKey),
    };
    await writeState('identity', identity);
  }
  return publicIdentity(identity);
}

export async function sealForBrowserPeer(message: Uint8Array, publicKey: string): Promise<string> {
  await sodium.ready;
  return encode(sodium.crypto_box_seal(message, decode(publicKey)));
}

export async function openForBrowser(ciphertext: string): Promise<Uint8Array> {
  await sodium.ready;
  const identity = await requiredIdentity();
  return sodium.crypto_box_seal_open(
    decode(ciphertext),
    decode(identity.encryption_public_key),
    decode(identity.encryption_secret_key),
  );
}

async function persistBrowserPairing(result: PairingResult, origin: string): Promise<void> {
  await writeState('peer:switchboard', { ...result.switchboard, kind: 'switchboard' } satisfies BrowserPeer);
  for (const sealed of result.room_keys) {
    await writeState(`room:${sealed.room}`, {
      room: sealed.room,
      generation: sealed.generation,
      key: encode(await openForBrowser(sealed.sealed_key)),
    } satisfies StoredBrowserRoomKey);
  }
  await storeBrowserAccess({ origin: new URL(origin).origin, authority: 'device' });
}

/**
 * Build a paired computer's complete archive material DIRECTLY from the enrolled
 * pairing result (fable) — the same key-set persistBrowserPairing would write to
 * the globals, but returned as data so the add path archives it WITHOUT ever
 * touching the shared global cache. Room keys are unsealed here, as in persist.
 */
async function relayMaterial(
  result: PairingResult,
  relay: StoredRelayRecord,
  origin: string,
): Promise<RelayMaterial> {
  const rooms: RelayMaterial['rooms'] = [];
  for (const sealed of result.room_keys) {
    rooms.push({
      room: sealed.room,
      value: {
        room: sealed.room,
        generation: sealed.generation,
        key: encode(await openForBrowser(sealed.sealed_key)),
      } satisfies StoredBrowserRoomKey,
    });
  }
  return {
    relay,
    peer: { ...result.switchboard, kind: 'switchboard' } satisfies BrowserPeer,
    access: { origin: new URL(origin).origin, authority: 'device' } satisfies StoredBrowserAccess,
    rooms,
  };
}

/** Browser-side relay tunnel record (PLAN §4.5). */
export interface StoredRelayRecord {
  relay_url: string;
  session_id: string; // 64-hex
  client_static: { pub: string; priv: string }; // base64url
  host_static_pub: string; // base64url
  /** The {primary, alias} member that actually reached the relay at pairing
   *  time (P7). Absent when the primary won. Sessions dial it first; relay_url
   *  stays the identity/keying origin so stored access is never re-keyed. */
  dial_url?: string;
}

export async function storedRelayRecord(): Promise<StoredRelayRecord | undefined> {
  return readState<StoredRelayRecord>('relay');
}

/**
 * Boot: migrate a legacy single-record install into the v2 index (idempotent),
 * then re-hydrate the global slots from the ACTIVE computer's archive (archive is
 * the truth). Returns the active relay record, or undefined when unpaired. Called
 * by initRelayMode before it builds the tunnel.
 */
export async function hydrateActiveRelay(): Promise<StoredRelayRecord | undefined> {
  const legacyPeer = await readState<BrowserPeer>('peer:switchboard');
  await migrateIfNeeded(browserKv, {
    id: legacyPeer?.device_id ?? 'legacy',
    label: 'Computer 1',
    paired_at: new Date().toISOString(),
  });
  await hydrateActive(browserKv);
  return readState<StoredRelayRecord>('relay');
}

/** The paired computers + the active id, for the switcher UI. */
export async function listPairedComputers(): Promise<{ computers: RelayComputer[]; active_id?: string }> {
  const index = await listComputers(browserKv);
  return { computers: index.computers, active_id: index.active_id };
}

/** Switch the active computer (caller reloads afterward). */
export async function switchComputer(id: string): Promise<void> {
  await switchToComputer(browserKv, id);
}

/** Rename a paired computer's label in place. */
export async function renamePairedComputer(id: string, label: string): Promise<void> {
  await renameComputer(browserKv, id, label);
}

/** Forget one specific paired computer (per-computer Forget in the switcher). */
export async function forgetPairedComputer(id: string): Promise<void> {
  await forgetComputerStore(browserKv, id);
}

/**
 * Forget the ACTIVE relay pairing (the recovery surface's / Settings' "Re-pair
 * this browser") — WITHOUT the nuclear unpairBrowser(). With multiple computers
 * this falls back to the next paired computer; with one it clears the globals and
 * drops to code entry. A subsequent pairThroughRelay records a fresh computer.
 */
export async function forgetRelayPairing(): Promise<void> {
  const active = selectActiveComputer(await listComputers(browserKv));
  if (active) {
    await forgetComputerStore(browserKv, active.id);
  } else {
    await deleteState('relay');
    await deleteState('access:switchboard');
  }
  setActiveBrowserAccessToken('');
}

/** The stable access origin used to key relay-paired switchboard access. */
export function relayAccessOrigin(relayUrl: string): string {
  return new URL(relayUrl.replace(/^ws/, 'http')).origin;
}

/**
 * Pair a browser through the blind relay (PLAN §4.2). Runs the real CPace PAKE
 * over the pairing room, enrolls into the SAME PairingService result as local
 * pairing, and persists the relay tunnel record. Real browser WebCrypto (noble
 * + libsodium) runs throughout.
 */
export async function pairThroughRelay(
  code: string,
  relayUrl: string,
  deadlineMs = (typeof window !== 'undefined' && window.__CODOR_PAIR_DEADLINE_MS) || 20_000,
): Promise<void> {
  const normalized = normalizeCode(code);
  if (!normalized) throw new Error('invalid pairing code');
  const { nameplate, secret } = splitCode(normalized);
  const identity = await ensureBrowserIdentity();
  // P7: some networks kill connections that openly name the canonical relay
  // host. Try each member of the dial pair, moving on ONLY when the room was
  // never contacted (a connect-level failure says nothing about the code); the
  // winner lands in the stored record's dial_url so sessions dial it directly.
  const candidates = relayDialCandidates(relayUrl);
  let lastError: unknown;
  for (const [index, dialUrl] of candidates.entries()) {
    try {
      await claimThroughRoom({
        nameplate,
        secret,
        identity,
        relayUrl,
        dialUrl,
        deadlineMs,
        // Bound a silently-blackholed connect only while another candidate remains.
        contactTimeoutMs: index < candidates.length - 1 ? 5_000 : undefined,
      });
      return;
    } catch (error) {
      lastError = error;
      if (!(error instanceof RelayNeverContacted)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** A claim attempt that failed before the pairing room ever answered — the
 *  signal to try the other dial-pair member; never a verdict on the code. */
class RelayNeverContacted extends Error {}

async function claimThroughRoom(args: {
  nameplate: string;
  secret: string;
  identity: BrowserPublicIdentity;
  /** The identity/keying URL the stored record carries. */
  relayUrl: string;
  /** The URL actually dialed (a member of the {primary, alias} pair). */
  dialUrl: string;
  deadlineMs: number;
  /** When set, a connect that has not heard from the room by then fails as
   *  RelayNeverContacted instead of eating the whole deadline. */
  contactTimeoutMs?: number;
}): Promise<void> {
  const { nameplate, secret, identity, relayUrl, dialUrl, deadlineMs } = args;
  const clientStatic = generateTunnelKeypair();
  const claimant = new PakeClaimant({ nameplate, secret });

  const wsBase = dialUrl.replace(/\/$/, '').replace(/^http/, 'ws');
  const socket = new WebSocket(`${wsBase}/v1/pair/${nameplate}/ws?role=claim`);
  socket.binaryType = 'arraybuffer';
  let channel: PairingChannel | undefined;
  let hello: { session_id: string; host_static_pub: string } | undefined;
  let settled = false;
  let contacted = false;

  try {
    await new Promise<void>((resolve, reject) => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let contactTimer: ReturnType<typeof setTimeout> | undefined;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        if (deadline) clearTimeout(deadline);
        if (contactTimer) clearTimeout(contactTimer);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      // A dead room (host never joins) would otherwise leave this pending forever.
      deadline = setTimeout(() => fail(new Error('relay pairing timed out — the host never joined the room')), deadlineMs);
      if (args.contactTimeoutMs !== undefined) {
        contactTimer = setTimeout(() => {
          if (!contacted) fail(new RelayNeverContacted('relay unreachable (connect timed out)'));
        }, args.contactTimeoutMs);
      }
      // A completed upgrade proves the room answered — connect-level failure is
      // only ever BEFORE open, so a reserved-but-silent room (host missing)
      // still gets the honest dead-room deadline instead of a failover.
      socket.onopen = () => {
        contacted = true;
      };
      socket.onerror = () => fail(contacted
        ? new Error('relay pairing connection failed')
        : new RelayNeverContacted('relay pairing connection failed'));
      socket.onclose = () => fail(contacted
        ? new Error('relay pairing closed before completion')
        : new RelayNeverContacted('relay pairing closed before completion'));
      socket.onmessage = (event) => {
        void (async () => {
          try {
            const bytes = new Uint8Array(event.data as ArrayBuffer);
            if (!channel) {
              if (bytes.length === 48) {
                const { msgB, tagC } = claimant.receiveMsgA(bytes);
                socket.send(msgB);
                socket.send(tagC);
              } else if (bytes.length === 32) {
                claimant.receiveHostConfirmation(bytes);
                channel = new PairingChannel(claimant.channel());
              }
              return;
            }
            const message = decodePairingMessage(claimant.channel().open(bytes));
            if (message.type === 'hello') {
              hello = { session_id: message.session_id, host_static_pub: message.host_static_pub };
              const enroll: PairingMessage = {
                type: 'enroll',
                request: { ...identity, kind: 'device', label: navigator.userAgent },
                client_static_pub: encode(clientStatic.publicKey),
                pairing_token: message.pairing_token,
              };
              socket.send(channel.seal(enroll));
            } else if (message.type === 'enrolled') {
              const result = message.result as PairingResult;
              const relay: StoredRelayRecord = {
                relay_url: relayUrl,
                session_id: hello!.session_id,
                client_static: { pub: encode(clientStatic.publicKey), priv: encode(clientStatic.secretKey) },
                host_static_pub: hello!.host_static_pub,
                // Remember which pair member actually reached the relay so the
                // session tunnel dials it first; relay_url stays the keying origin.
                ...(dialUrl !== relayUrl ? { dial_url: dialUrl } : {}),
              };
              // Archive this computer's generation DIRECTLY from the pairing result
              // — never by snapshotting the shared globals — so a concurrent active
              // session in another tab can't contaminate it and this pairing can't
              // clobber another computer's rooms. No global slots are touched here;
              // the post-pairing reload's boot hydrate populates them from the
              // now-active generation. Label defaults to "Computer N" (a re-pair of
              // the same switchboard keeps its label).
              const material = await relayMaterial(result, relay, relayAccessOrigin(relayUrl));
              const existing = await listComputers(browserKv);
              const id = result.switchboard.device_id;
              const label = existing.computers.find((c) => c.id === id)?.label
                ?? `Computer ${existing.computers.length + 1}`;
              await recordPairedComputer(browserKv, { id, label, paired_at: new Date().toISOString() }, material);
              socket.send(channel.seal({ type: 'done' }));
              settled = true;
              if (deadline) clearTimeout(deadline);
              resolve();
            }
          } catch (error) {
            fail(error);
          }
        })();
      };
    });
  } finally {
    socket.close();
  }
}

export async function completeBrowserPairing(url: URL): Promise<PairingResult> {
  const endpoint = url.searchParams.get('endpoint');
  const token = url.searchParams.get('pairing_token');
  const expectedSwitchboard = url.searchParams.get('switchboard_sign_pub');
  if (!endpoint || !token || !expectedSwitchboard) throw new Error('pairing link is incomplete');
  const identity = await ensureBrowserIdentity();
  const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/pairing/complete`, {
    method: 'POST',
    headers: { authorization: `Pairing ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...identity, kind: 'device', label: navigator.userAgent }),
  });
  if (!response.ok) throw new Error(`pairing failed: ${String(response.status)}`);
  const result = (await response.json()) as PairingResult;
  if (result.switchboard.sign_public_key !== expectedSwitchboard) {
    throw new Error('Codor signing key does not match the pairing link');
  }
  await persistBrowserPairing(result, endpoint);
  return result;
}

// harn:assume unpaired-browser-always-has-enrollment-path ref=trusted-browser-pairing-client
export function tryTrustedBrowserPairing(origin = window.location.origin): Promise<boolean> {
  const normalizedOrigin = new URL(origin).origin;
  const existing = trustedPairingAttempts.get(normalizedOrigin);
  if (existing) return existing;
  const attempt = (async () => {
    const statusResponse = await fetch(`${normalizedOrigin}/api/pairing/status`);
    if (!statusResponse.ok) {
      throw new Error(`trusted pairing status failed: ${String(statusResponse.status)}`);
    }
    const status = await statusResponse.json() as { trusted_enrollment?: unknown };
    if (status.trusted_enrollment !== true) return false;

    const identity = await ensureBrowserIdentity();
    const response = await fetch(`${normalizedOrigin}/api/pairing/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...identity, kind: 'device', label: navigator.userAgent }),
    });
    if (!response.ok) throw new Error(`trusted pairing failed: ${String(response.status)}`);
    await persistBrowserPairing(await response.json() as PairingResult, normalizedOrigin);
    return true;
  })();
  trustedPairingAttempts.set(normalizedOrigin, attempt);
  return attempt;
}
// harn:end unpaired-browser-always-has-enrollment-path

// harn:assume paired-browser-challenge-session ref=browser-session-signin
export async function openBrowserDeviceSession(origin = window.location.origin): Promise<string | undefined> {
  await sodium.ready;
  const switchboard = await readState<BrowserPeer>('peer:switchboard');
  if (switchboard?.kind !== 'switchboard') return undefined;
  const identity = await requiredIdentity();
  const challengeResponse = await relayFetch(`${origin}/api/auth/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_id: identity.device_id }),
  });
  if (!challengeResponse.ok) {
    throw new Error(`device authentication failed: ${String(challengeResponse.status)}`);
  }
  const offered = await challengeResponse.json() as {
    challenge?: BrowserAuthChallenge;
    switchboard_device_id?: string;
  };
  if (offered.switchboard_device_id !== switchboard.device_id || !offered.challenge) {
    throw new Error('device authentication Codor identity mismatch');
  }
  const challenge = offered.challenge;
  const expectedTranscript = encode(sodium.crypto_generichash(
    sodium.crypto_generichash_BYTES,
    new TextEncoder().encode(`codor-browser-session-v1\0${switchboard.device_id}`),
    null,
  ));
  if (
    typeof challenge.challenge_id !== 'string' || challenge.challenge_id === '' ||
    typeof challenge.server_nonce !== 'string' ||
    typeof challenge.transcript_hash !== 'string' ||
    challenge.transcript_hash !== expectedTranscript ||
    typeof challenge.expires_at !== 'string' ||
    Date.parse(challenge.expires_at) <= Date.now()
  ) {
    throw new Error('device authentication challenge is invalid');
  }
  const signature = encode(sodium.crypto_sign_detached(
    challengeBytes(challenge),
    decode(identity.sign_secret_key),
  ));
  const sessionResponse = await relayFetch(`${origin}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge_id: challenge.challenge_id, signature }),
  });
  if (!sessionResponse.ok) {
    throw new Error(`device authentication failed: ${String(sessionResponse.status)}`);
  }
  const session = await sessionResponse.json() as {
    access_token?: unknown;
    device_id?: unknown;
    expires_at?: unknown;
  };
  if (
    typeof session.access_token !== 'string' || session.access_token === '' ||
    session.device_id !== identity.device_id ||
    typeof session.expires_at !== 'string' ||
    Date.parse(session.expires_at) <= Date.now()
  ) {
    throw new Error('device authentication session is invalid');
  }
  return session.access_token;
}

export async function restoreBrowserAccess(origin = window.location.origin): Promise<string> {
  const switchboard = await readState<BrowserPeer>('peer:switchboard');
  if (switchboard?.kind === 'switchboard') {
    return (await openBrowserDeviceSession(origin)) ?? '';
  }
  const stored = await storedBrowserAccess();
  return stored?.origin === origin &&
      stored.authority !== 'device' &&
      typeof stored.token === 'string'
    ? stored.token
    : '';
}
// harn:end paired-browser-challenge-session

export async function storedBrowserRoomKey(room: string): Promise<StoredBrowserRoomKey | undefined> {
  return readState<StoredBrowserRoomKey>(`room:${room}`);
}

export async function storedBrowserRoomKeys(): Promise<StoredBrowserRoomKey[]> {
  // Filter by KEY PREFIX, never by value shape — the per-computer archives
  // (`computer:<id>:<gen>:room:*`) hold identically-shaped values, and must stay
  // invisible to every legacy reader. Only the active computer's global `room:*`
  // keys count.
  const keys = (await listStateKeys()).filter((k) => k.startsWith('room:'));
  const values = await Promise.all(keys.map((k) => readState<StoredBrowserRoomKey>(k)));
  return values.filter((value): value is StoredBrowserRoomKey => value !== undefined);
}

export async function persistBrowserRoomKey(
  room: string,
  generation: number,
  key: Uint8Array,
): Promise<void> {
  await sodium.ready;
  if (room === '' || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('channel key metadata is invalid');
  }
  if (key.length !== sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES) {
    throw new Error('channel key length is invalid');
  }
  const current = await storedBrowserRoomKey(room);
  if (current && current.generation > generation) return;
  await writeState(`room:${room}`, { room, generation, key: encode(key) } satisfies StoredBrowserRoomKey);
}

export async function storeBrowserAccess(access: StoredBrowserAccess): Promise<void> {
  if (
    access.origin === '' ||
    (access.authority === 'operator' && (typeof access.token !== 'string' || access.token === '')) ||
    (access.authority === 'device' && access.token !== undefined)
  ) {
    throw new Error('browser access metadata is invalid');
  }
  await writeState('access:switchboard', access);
}

export async function storedBrowserAccess(): Promise<StoredBrowserAccess | undefined> {
  return readState<StoredBrowserAccess>('access:switchboard');
}

/**
 * Pure storage-presence check — is there a persisted access record for this origin?
 * NO network, NO challenge. Boot uses it to tell a paired browser (direct device OR
 * operator `?token=` cold-launch) apart from a genuinely-unpaired one, so a failed
 * token resolution shows the recovery card instead of the "never paired" landing.
 */
export async function hasStoredBrowserAccess(origin: string): Promise<boolean> {
  const stored = await storedBrowserAccess();
  return stored !== undefined && stored.origin === new URL(origin).origin;
}

// harn:assume unpair-purges-all-browser-state ref=browser-unpair-purge
export async function unpairBrowser(): Promise<void> {
  activeAccessToken = '';
  for (const registration of await navigator.serviceWorker.getRegistrations()) {
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
    await registration.unregister();
  }
  for (const name of await caches.keys()) await caches.delete(name);
  localStorage.clear();
  const databases = typeof indexedDB.databases === 'function'
    ? await indexedDB.databases()
    : [{ name: BROWSER_CRYPTO_DATABASE }];
  await Promise.all(databases
    .map((database) => database.name)
    .filter((name): name is string => typeof name === 'string' && name.startsWith('codor-'))
    .map((name) => new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('IndexedDB delete failed'));
      request.onblocked = () => reject(new Error('IndexedDB delete was blocked'));
    })));
}
// harn:end unpair-purges-all-browser-state

function publicIdentity(identity: BrowserIdentity): BrowserPublicIdentity {
  return {
    device_id: identity.device_id,
    sign_public_key: identity.sign_public_key,
    encryption_public_key: identity.encryption_public_key,
  };
}

async function requiredIdentity(): Promise<BrowserIdentity> {
  await ensureBrowserIdentity();
  const identity = await readState<BrowserIdentity>('identity');
  if (!identity) throw new Error('browser identity disappeared');
  return identity;
}
// harn:end single-crypto-suite-libsodium

// harn:assume pairing-code-enrollment-surfaces ref=browser-pairing-code-client
interface PairingPayload {
  endpoint: string;
  pairing_token: string;
  expires_at: string;
  switchboard_sign_pub: string;
}

export async function exchangeBrowserPairingCode(
  code: string,
  origin = window.location.origin,
): Promise<URL> {
  const normalizedOrigin = new URL(origin).origin;
  const response = await fetch(`${normalizedOrigin}/api/pairing/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) throw new Error('pairing code not found');
  const offer = await response.json() as PairingPayload;
  const url = new URL('/pair', offer.endpoint);
  url.searchParams.set('endpoint', offer.endpoint);
  url.searchParams.set('pairing_token', offer.pairing_token);
  url.searchParams.set('switchboard_sign_pub', offer.switchboard_sign_pub);
  return url;
}
// harn:end pairing-code-enrollment-surfaces
