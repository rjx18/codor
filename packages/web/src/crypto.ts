import sodium from 'libsodium-wrappers';

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
    throw new Error('switchboard signing key does not match the pairing link');
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
  const challengeResponse = await fetch(`${origin}/api/auth/challenge`, {
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
    throw new Error('device authentication switchboard identity mismatch');
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
  const sessionResponse = await fetch(`${origin}/api/auth/session`, {
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
  return (await readAllState()).filter((value): value is StoredBrowserRoomKey => {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Partial<StoredBrowserRoomKey>;
    return typeof candidate.room === 'string' &&
      typeof candidate.generation === 'number' &&
      typeof candidate.key === 'string';
  });
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
