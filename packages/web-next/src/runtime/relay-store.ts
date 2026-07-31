// P3 multi-computer storage over an injectable KV seam (IndexedDB in prod, a Map
// in tests) so the crash-safety is unit-testable. INVARIANT (fable): each
// computer's key material lives in an immutable ARCHIVE GENERATION
// (`computer:<id>:<gen>:*`); the index entry {id, gen} is the ONLY truth, and the
// global slots (`relay`, `peer:switchboard`, `access:switchboard`, `room:*`) are a
// derived cache re-hydrated from the active generation every boot. Every mutation
// — add, re-pair, switch, forget — commits through a SINGLE atomic index put: a
// new generation is written COMPLETELY first, then the index flips to it. A crash
// anywhere leaves the index pointing at a complete generation (never a mixed key
// set); superseded generations are junk, lazily deleted on the next touch.

import {
  type RelayComputer,
  type RelayIndex,
  addComputer,
  emptyIndex,
  forgetComputer,
  selectActiveComputer,
  setActive,
} from './relay-records.js';

export interface Kv {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  /**
   * Optional cross-context serializer (Web Locks in the browser). When present,
   * every index mutation and the boot hydrate run inside it so two tabs sharing
   * one IndexedDB can't interleave a read-modify-write on the index, race a prune
   * against an in-progress generation, or collide forget-vs-re-add. Absent (the
   * Map-KV unit seam) ⇒ pass-through: single-context callers need no locking.
   */
  lock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * The complete key-set of ONE computer's archive generation. The add path builds
 * this DIRECTLY from the enrolled pairing result (fable) — never by snapshotting
 * the shared global cache — so a concurrent active session in another tab cannot
 * contaminate the new computer's archive (there is no read-globals window to race).
 */
export interface RelayMaterial {
  relay: unknown;
  peer: unknown;
  access: unknown;
  rooms: Array<{ room: string; value: unknown }>;
}

/** Run under the KV's serializer when it has one; otherwise straight through. */
function serialize<T>(kv: Kv, fn: () => Promise<T>): Promise<T> {
  return kv.lock ? kv.lock(fn) : fn();
}

const INDEX_KEY = 'relay-index';
const GLOBAL_SINGLETONS = ['relay', 'peer:switchboard', 'access:switchboard'] as const;
const genRoot = (id: string, gen: number): string => `computer:${id}:${gen}:`;
const archiveKey = (id: string, gen: number, cls: string): string => `${genRoot(id, gen)}${cls}`;

/**
 * The id is a PATH SEGMENT in `computer:<id>:<gen>:*`, so a colon inside it would
 * let one computer's `computer:<id>:` prefix match another computer's archive
 * (and confuse the generation parse). Device ids are colon-free base64url, so this
 * only fires on a contract violation — but it makes the key-path invariant explicit
 * and unbreakable rather than merely conventional.
 */
function assertPlainId(id: string): void {
  if (id.includes(':')) throw new Error(`relay computer id must not contain ':' (got ${JSON.stringify(id)})`);
}

function isRelayIndex(value: unknown): value is RelayIndex {
  return (
    typeof value === 'object' && value !== null &&
    (value as RelayIndex).version === 2 && Array.isArray((value as RelayIndex).computers)
  );
}

async function readIndex(kv: Kv): Promise<RelayIndex> {
  const raw = await kv.get(INDEX_KEY);
  return isRelayIndex(raw) ? raw : emptyIndex();
}

/** ONLY the global (active-cache) room keys — archived `computer:*` keys excluded. */
async function globalRoomKeys(kv: Kv): Promise<string[]> {
  return (await kv.keys()).filter((k) => k.startsWith('room:'));
}

/** Snapshot the current global slots into a computer's (new) archive generation.
 *  Used ONLY by the v1→v2 migration, which is genuinely single-context (boot). */
async function archiveGeneration(kv: Kv, id: string, gen: number): Promise<void> {
  for (const cls of GLOBAL_SINGLETONS) {
    const v = await kv.get(cls);
    if (v !== undefined) await kv.put(archiveKey(id, gen, cls), v);
  }
  for (const rk of await globalRoomKeys(kv)) await kv.put(archiveKey(id, gen, rk), await kv.get(rk));
}

/** Write a computer's (new) archive generation DIRECTLY from supplied material —
 *  the add path's source of truth, never the shared global cache. */
async function writeGeneration(kv: Kv, id: string, gen: number, m: RelayMaterial): Promise<void> {
  await kv.put(archiveKey(id, gen, 'relay'), m.relay);
  await kv.put(archiveKey(id, gen, 'peer:switchboard'), m.peer);
  await kv.put(archiveKey(id, gen, 'access:switchboard'), m.access);
  for (const { room, value } of m.rooms) await kv.put(archiveKey(id, gen, `room:${room}`), value);
}

/** Replace the global slots with a generation's archived keys (archive → cache). */
async function hydrateGeneration(kv: Kv, id: string, gen: number): Promise<void> {
  for (const rk of await globalRoomKeys(kv)) await kv.delete(rk); // drop another computer's rooms
  for (const cls of GLOBAL_SINGLETONS) {
    const v = await kv.get(archiveKey(id, gen, cls));
    if (v !== undefined) await kv.put(cls, v);
    else await kv.delete(cls);
  }
  const prefix = archiveKey(id, gen, 'room:');
  for (const k of await kv.keys()) {
    if (k.startsWith(prefix)) await kv.put(`room:${k.slice(prefix.length)}`, await kv.get(k));
  }
}

async function clearGlobals(kv: Kv): Promise<void> {
  for (const cls of GLOBAL_SINGLETONS) await kv.delete(cls);
  for (const rk of await globalRoomKeys(kv)) await kv.delete(rk);
}

/** Delete a computer's whole archive (all generations). */
async function deleteArchive(kv: Kv, id: string): Promise<void> {
  const prefix = `computer:${id}:`;
  for (const k of await kv.keys()) if (k.startsWith(prefix)) await kv.delete(k);
}

/** Lazily delete every archived generation of a computer except the one to keep. */
async function pruneOldGenerations(kv: Kv, id: string, keep: number): Promise<void> {
  const prefix = `computer:${id}:`;
  for (const k of await kv.keys()) {
    if (!k.startsWith(prefix)) continue;
    if (Number(k.slice(prefix.length).split(':')[0]) !== keep) await kv.delete(k);
  }
}

async function hydrateActiveInner(kv: Kv): Promise<RelayComputer | undefined> {
  // Read the RAW index: a browser with NO index has never been relay-paired
  // (it may be a direct/self-hosted pairing) — its globals are not ours to clear.
  // Only an index that EXISTS but resolves to no active computer (every relay
  // computer forgotten) clears the relay globals.
  const raw = await kv.get(INDEX_KEY);
  if (!isRelayIndex(raw)) return undefined;
  const active = selectActiveComputer(raw);
  if (!active) {
    await clearGlobals(kv);
    return undefined;
  }
  await hydrateGeneration(kv, active.id, active.gen);
  return active;
}

/** Boot: re-hydrate the globals from the ACTIVE generation and return it (truth). */
export async function hydrateActive(kv: Kv): Promise<RelayComputer | undefined> {
  return serialize(kv, () => hydrateActiveInner(kv));
}

/**
 * Record a freshly-paired computer. `material` is the new computer's complete
 * key-set, built by the caller DIRECTLY from the pairing result (never the shared
 * global cache); we write it into a NEW complete generation, then commit the index
 * in one put (a re-pair bumps the generation atomically), and lazily prune
 * superseded generations. Serialized so the index RMW can't race another tab.
 */
export async function recordPairedComputer(
  kv: Kv,
  computer: Omit<RelayComputer, 'gen'>,
  material: RelayMaterial,
): Promise<void> {
  assertPlainId(computer.id);
  return serialize(kv, async () => {
    const index = await readIndex(kv);
    const gen = (index.computers.find((c) => c.id === computer.id)?.gen ?? 0) + 1;
    await writeGeneration(kv, computer.id, gen, material);
    await kv.put(INDEX_KEY, addComputer(index, { ...computer, gen }));
    await pruneOldGenerations(kv, computer.id, gen);
  });
}

/** Switch active computer — one atomic index put; boot hydrates on the reload. */
export async function switchToComputer(kv: Kv, id: string): Promise<void> {
  return serialize(kv, async () => {
    const index = await readIndex(kv);
    if (!index.computers.some((c) => c.id === id)) return;
    await kv.put(INDEX_KEY, setActive(index, id));
  });
}

/** Rename a computer's label in place (index-only; keys/active untouched). */
export async function renameComputer(kv: Kv, id: string, label: string): Promise<void> {
  return serialize(kv, async () => {
    const index = await readIndex(kv);
    await kv.put(INDEX_KEY, { ...index, computers: index.computers.map((c) => (c.id === id ? { ...c, label } : c)) });
  });
}

/**
 * Forget one computer: commit the index without its entry (single put), THEN
 * lazily delete its archive (orphan cleanup — safe because the index no longer
 * references it), then re-hydrate the fallback (or clear). Returns the now-active
 * computer, or undefined when none remain. The whole sequence is serialized (and
 * calls the UNwrapped hydrate to avoid a Web-Locks self-deadlock).
 */
export async function forgetComputerStore(kv: Kv, id: string): Promise<RelayComputer | undefined> {
  return serialize(kv, async () => {
    await kv.put(INDEX_KEY, forgetComputer(await readIndex(kv), id));
    await deleteArchive(kv, id);
    return hydrateActiveInner(kv);
  });
}

/**
 * Idempotent v1→v2 migration: a legacy relay install has its one computer's keys
 * in the global slots. Snapshot them as generation 1 and commit the index. A
 * present index means we already migrated ⇒ no-op. A browser with NO `relay`
 * global was never relay-paired (fresh, or direct/self-hosted) ⇒ leave it
 * entirely untouched — writing an empty index here would make the boot hydrate
 * wipe a direct pairing's globals.
 */
export async function migrateIfNeeded(kv: Kv, legacy: Omit<RelayComputer, 'gen'>): Promise<void> {
  assertPlainId(legacy.id);
  return serialize(kv, async () => {
    if ((await kv.get(INDEX_KEY)) !== undefined) return;
    if ((await kv.get('relay')) === undefined) return;
    await archiveGeneration(kv, legacy.id, 1);
    await kv.put(INDEX_KEY, { version: 2, computers: [{ ...legacy, gen: 1 }], active_id: legacy.id } satisfies RelayIndex);
  });
}

/** The paired computers + active id, for the switcher UI. */
export async function listComputers(kv: Kv): Promise<RelayIndex> {
  return readIndex(kv);
}
