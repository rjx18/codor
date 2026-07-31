// P3 multi-computer pairing: the PURE index + selection logic, deliberately free
// of IndexedDB so it can be unit-tested like a reducer (fable's design note — the
// same treatment the recovery classifier got). The IndexedDB seam in crypto.ts
// maps these index entries to/from each computer's archived key material; this
// module only decides WHICH computers exist and which one is active.

/** One paired computer/switchboard. `id` is the stable switchboard identity. */
export interface RelayComputer {
  /** Stable per-computer id — the switchboard's device_id (sign public key). */
  id: string;
  /** Human label shown in the switcher. */
  label: string;
  /** ISO timestamp of the (most recent) pairing — drives the last-paired default. */
  paired_at: string;
  /**
   * Which archive GENERATION holds this computer's keys (`computer:<id>:<gen>:*`).
   * Every re-pair writes a fresh, complete generation and flips this in a single
   * index put — so a crash never exposes a half-written generation; the index
   * points only ever at a complete one, and superseded generations are junk.
   */
  gen: number;
}

/** The browser's list of paired computers + which one is active. */
export interface RelayIndex {
  version: 2;
  computers: RelayComputer[];
  /** The persisted active selection; absent ⇒ use the last-paired default. */
  active_id?: string;
}

export function emptyIndex(): RelayIndex {
  return { version: 2, computers: [] };
}

/**
 * The active computer: exactly one ⇒ that one (straight in); otherwise the
 * persisted `active_id` when it still exists, else the LAST PAIRED (max
 * paired_at). Returns undefined only when there are no computers (unpaired).
 */
export function selectActiveComputer(index: RelayIndex): RelayComputer | undefined {
  const { computers, active_id } = index;
  if (computers.length === 0) return undefined;
  if (active_id !== undefined) {
    const chosen = computers.find((c) => c.id === active_id);
    if (chosen) return chosen;
  }
  return computers.reduce((best, c) => (c.paired_at > best.paired_at ? c : best));
}

/** Add (or re-pair/update) a computer and make it active. */
export function addComputer(index: RelayIndex, computer: RelayComputer): RelayIndex {
  const computers = [...index.computers.filter((c) => c.id !== computer.id), computer];
  return { version: 2, computers, active_id: computer.id };
}

/**
 * Forget one computer. If it was active, fall back to the last-paired remaining
 * computer, or to no active (⇒ drop to code entry) when the list is now empty.
 */
export function forgetComputer(index: RelayIndex, id: string): RelayIndex {
  const computers = index.computers.filter((c) => c.id !== id);
  if (index.active_id !== id) {
    return { version: 2, computers, active_id: index.active_id };
  }
  return { version: 2, computers, active_id: selectActiveComputer({ version: 2, computers })?.id };
}

/** Persist a switch to an existing computer (no-op if the id is unknown). */
export function setActive(index: RelayIndex, id: string): RelayIndex {
  if (!index.computers.some((c) => c.id === id)) return index;
  return { ...index, active_id: id };
}

/**
 * Migrate a legacy v1 single-record install into a v2 index. `legacy` carries the
 * one computer's identity/label extracted from the old `relay`/`peer:switchboard`
 * keys; absent ⇒ an empty (unpaired) index.
 */
export function migrateFromV1(legacy: RelayComputer | undefined): RelayIndex {
  return legacy ? { version: 2, computers: [legacy], active_id: legacy.id } : emptyIndex();
}
