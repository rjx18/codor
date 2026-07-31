import { describe, expect, it } from 'vitest';

import { forgetComputer } from './relay-records.js';
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

function mapKv(): Kv & { dump(): Map<string, unknown> } {
  const m = new Map<string, unknown>();
  return {
    get: async (k) => m.get(k) as never,
    put: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
    keys: async () => [...m.keys()],
    dump: () => m,
  };
}

/** One computer's archive material, built directly (as the real add path does). */
const material = (id: string): RelayMaterial => ({
  relay: { relay_url: id },
  peer: { device_id: id },
  access: { origin: id },
  rooms: [{ room: id, value: { room: id, key: id } }],
});

/**
 * Record a paired computer from material built DIRECTLY (never from the globals),
 * then hydrate — modelling the real flow: the add archives from the pairing result
 * and the post-pairing reload's boot hydrate populates the globals from it.
 */
async function pair(kv: Kv & { dump(): Map<string, unknown> }, id: string, pairedAt: string): Promise<void> {
  await recordPairedComputer(kv, { id, label: `pc-${id}`, paired_at: pairedAt }, material(id));
  await hydrateActive(kv);
}

const activeRelay = (kv: Kv & { dump(): Map<string, unknown> }): unknown =>
  (kv.dump().get('relay') as { relay_url?: string } | undefined)?.relay_url;
const globalRooms = (kv: Kv & { dump(): Map<string, unknown> }): string[] =>
  [...kv.dump().keys()].filter((k) => k.startsWith('room:'));

describe('relay-store (generation-swapped)', () => {
  it('migrateIfNeeded is idempotent and archives the legacy globals as generation 1', async () => {
    const kv = mapKv();
    await kv.put('relay', { relay_url: 'legacy' });
    await kv.put('peer:switchboard', { device_id: 'sw1' });
    await migrateIfNeeded(kv, { id: 'sw1', label: 'Computer 1', paired_at: '2026-01-01' });
    expect((await listComputers(kv)).computers).toEqual([{ id: 'sw1', label: 'Computer 1', paired_at: '2026-01-01', gen: 1 }]);
    expect(await kv.get('computer:sw1:1:relay')).toEqual({ relay_url: 'legacy' });
    await migrateIfNeeded(kv, { id: 'other', label: 'x', paired_at: '2026-02-02' });
    expect((await listComputers(kv)).computers.map((c) => c.id)).toEqual(['sw1']);
  });

  it('a fresh install with no legacy relay record writes no index and stays empty', async () => {
    const kv = mapKv();
    await migrateIfNeeded(kv, { id: 'x', label: 'x', paired_at: '1' });
    expect(await kv.get('relay-index')).toBeUndefined(); // nothing to migrate ⇒ no index written
    expect((await listComputers(kv)).computers).toHaveLength(0);
    expect(await hydrateActive(kv)).toBeUndefined();
  });

  it('pairs two computers, defaults to last paired, and hydrates its keys', async () => {
    const kv = mapKv();
    await pair(kv, 'A', '2026-01-01');
    await pair(kv, 'B', '2026-01-02');
    expect((await hydrateActive(kv))?.id).toBe('B');
    expect(activeRelay(kv)).toBe('B');
    expect(globalRooms(kv)).toEqual(['room:B']); // ONLY the active computer's room
  });

  it('keeps each computer archive disjoint — no leaked rooms from another computer', async () => {
    const kv = mapKv();
    await pair(kv, 'A', '2026-01-01');
    await pair(kv, 'B', '2026-01-02');
    expect(await kv.get('computer:A:1:room:A')).toBeDefined();
    expect(await kv.get('computer:A:1:room:B')).toBeUndefined();
    expect(await kv.get('computer:B:1:room:B')).toBeDefined();
    expect(await kv.get('computer:B:1:room:A')).toBeUndefined();
  });

  it('switch is a single index put; the reload boot hydrates the target', async () => {
    const kv = mapKv();
    await pair(kv, 'A', '2026-01-01');
    await pair(kv, 'B', '2026-01-02');
    await switchToComputer(kv, 'A');
    expect((await listComputers(kv)).active_id).toBe('A'); // marker flipped atomically
    await hydrateActive(kv); // the reload boot
    expect(activeRelay(kv)).toBe('A');
    expect(globalRooms(kv)).toEqual(['room:A']);
  });

  it('crash mid-re-pair: a half-written new generation is ignored; boot hydrates the old one', async () => {
    const kv = mapKv();
    await pair(kv, 'A', '2026-01-01'); // gen 1
    // A re-pair archived a gen-2 with fresh keys but crashed BEFORE the index flip.
    await kv.put('computer:A:2:relay', { relay_url: 'A-v2' });
    await kv.put('computer:A:2:peer:switchboard', { device_id: 'A-v2' });
    const active = await hydrateActive(kv); // index still points at gen 1
    expect(active?.gen).toBe(1);
    expect(activeRelay(kv)).toBe('A'); // the coherent OLD generation, never A-v2
  });

  it('crash mid-forget: the committed index wins; an orphaned archive never leaks', async () => {
    const kv = mapKv();
    await pair(kv, 'A', '2026-01-01');
    await pair(kv, 'B', '2026-01-02'); // active B
    // Index committed to forget B, but B's archive delete had not run yet (crash).
    await kv.put('relay-index', forgetComputer(await listComputers(kv), 'B'));
    expect(await kv.get('computer:B:1:relay')).toBeDefined(); // orphan still present
    const active = await hydrateActive(kv);
    expect(active?.id).toBe('A'); // fallback to the remaining computer
    expect(activeRelay(kv)).toBe('A'); // never the orphaned B
  });

  it('forgetting the active hydrates the fallback; forgetting the last drops to none', async () => {
    const kv = mapKv();
    await pair(kv, 'A', '2026-01-01');
    await pair(kv, 'B', '2026-01-03');
    await pair(kv, 'C', '2026-01-02');
    expect((await forgetComputerStore(kv, 'B'))?.id).toBe('C');
    expect(activeRelay(kv)).toBe('C');
    expect(await kv.get('computer:B:1:relay')).toBeUndefined();
    await forgetComputerStore(kv, 'C');
    expect(await forgetComputerStore(kv, 'A')).toBeUndefined();
    expect(kv.dump().get('relay')).toBeUndefined();
    expect(globalRooms(kv)).toEqual([]);
  });

  it('renames a computer in place', async () => {
    const kv = mapKv();
    await pair(kv, 'A', '2026-01-01');
    await renameComputer(kv, 'A', 'My laptop');
    expect((await listComputers(kv)).computers[0]?.label).toBe('My laptop');
    expect(activeRelay(kv)).toBe('A');
  });

  it('rejects a computer id containing the key-path separator', async () => {
    const kv = mapKv();
    await expect(recordPairedComputer(kv, { id: 'a:b', label: 'x', paired_at: '1' }, material('a:b'))).rejects.toThrow(/must not contain/);
    // Nothing was written — the guard fires before any archive/index mutation.
    expect(kv.dump().size).toBe(0);
  });

  it('leaves a direct-paired browser (no relay index) untouched on boot', async () => {
    const kv = mapKv();
    // A self-hosted/direct pairing: peer + rooms + access in the globals, but NO
    // relay record and NO index — it never went through the relay.
    await kv.put('peer:switchboard', { device_id: 'direct' });
    await kv.put('access:switchboard', { origin: 'https://sb.local' });
    await kv.put('room:ops', { room: 'ops', key: 'k' });
    await migrateIfNeeded(kv, { id: 'direct', label: 'Computer 1', paired_at: '1' });
    expect(await hydrateActive(kv)).toBeUndefined();
    // Globals survive — the relay boot must never wipe a direct pairing (no index
    // was written, so there is nothing for the boot hydrate to clear against).
    expect(await kv.get('peer:switchboard')).toEqual({ device_id: 'direct' });
    expect(globalRooms(kv)).toEqual(['room:ops']);
    expect(await kv.get('relay-index')).toBeUndefined();
  });

  it('a serializing lock keeps concurrent index mutations from clobbering each other', async () => {
    const base = mapKv();
    let tail: Promise<unknown> = Promise.resolve();
    const kv: Kv & { dump(): Map<string, unknown> } = {
      ...base,
      lock: (fn) => { const run = tail.then(() => fn()); tail = run.then(() => undefined, () => undefined); return run; },
    };
    // Two adds fired WITHOUT awaiting between them race the index read-modify-write.
    await Promise.all([
      recordPairedComputer(kv, { id: 'A', label: 'A', paired_at: '1' }, material('A')),
      recordPairedComputer(kv, { id: 'B', label: 'B', paired_at: '2' }, material('B')),
    ]);
    // Serialized ⇒ BOTH land (an unlocked RMW would lose one to a stale-index put).
    expect((await listComputers(kv)).computers.map((c) => c.id).sort()).toEqual(['A', 'B']);

    // Control: the identical interleaving WITHOUT a lock loses one — proving the
    // race is real and the lock (not luck) is what makes both survive.
    const unlocked = mapKv();
    await Promise.all([
      recordPairedComputer(unlocked, { id: 'A', label: 'A', paired_at: '1' }, material('A')),
      recordPairedComputer(unlocked, { id: 'B', label: 'B', paired_at: '2' }, material('B')),
    ]);
    expect((await listComputers(unlocked)).computers).toHaveLength(1);
  });
});
