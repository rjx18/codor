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

interface BrowserPeer extends BrowserPublicIdentity {
  kind: 'device' | 'switchboard';
  label?: string;
}

interface PairingResult {
  switchboard: BrowserPublicIdentity;
  room_keys: { room: string; generation: number; sealed_key: string }[];
}

const DATABASE = 'wireroom-crypto-v1';
const STORE = 'state';

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

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
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
  await writeState('peer:switchboard', { ...result.switchboard, kind: 'switchboard' } satisfies BrowserPeer);
  for (const sealed of result.room_keys) {
    await writeState(`room:${sealed.room}`, {
      room: sealed.room,
      generation: sealed.generation,
      key: encode(await openForBrowser(sealed.sealed_key)),
    } satisfies StoredBrowserRoomKey);
  }
  return result;
}

export async function storedBrowserRoomKey(room: string): Promise<StoredBrowserRoomKey | undefined> {
  return readState<StoredBrowserRoomKey>(`room:${room}`);
}

export async function unpairBrowser(): Promise<void> {
  for (const registration of await navigator.serviceWorker.getRegistrations()) {
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
    await registration.unregister();
  }
  for (const name of await caches.keys()) await caches.delete(name);
  localStorage.clear();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('IndexedDB delete failed'));
    request.onblocked = () => reject(new Error('IndexedDB delete was blocked'));
  });
}

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
