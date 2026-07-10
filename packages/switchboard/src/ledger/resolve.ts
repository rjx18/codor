import type { LedgerNote } from './vault.js';

export interface ResolvedLedgerRef {
  name: string;
  body: string;
}

export type LedgerLookup = (room: string, name: string) => LedgerNote | undefined;

export class LedgerResolver {
  constructor(private readonly lookup: LedgerLookup) {}

  resolve(room: string, names: string[]): ResolvedLedgerRef[] {
    const seen = new Set<string>();
    return names.flatMap((name) => {
      if (seen.has(name)) return [];
      seen.add(name);
      const note = this.lookup(room, name);
      return note ? [{ name: note.name, body: note.content }] : [];
    });
  }
}
