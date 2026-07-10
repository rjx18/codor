import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { WireEvent } from '@wireroom/protocol';

/**
 * Run event journal: JSONL blobs on disk, one per run message
 * (`<root>/<room>/runs/<msg-id>.jsonl`), referenced by
 * RunSummary.events_ref — the DB never stores event payloads.
 */
export class BlobStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  ref(msgId: number): string {
    return `runs/${msgId}.jsonl`;
  }

  // harn:assume blob-path-contained ref=blob-path-containment
  path(room: string, ref: string): string {
    const file = resolve(this.root, room, ref);
    const fromRoot = relative(this.root, file);
    if (
      fromRoot === '..' ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new Error('run blob path escapes the configured root');
    }
    return file;
  }
  // harn:end blob-path-contained

  append(room: string, ref: string, event: WireEvent): void {
    const file = this.path(room, ref);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(event)}\n`);
  }

  /** All journaled events for a run; [] when the blob never got written. */
  read(room: string, ref: string): WireEvent[] {
    const file = this.path(room, ref);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as WireEvent];
        } catch {
          return [];
        }
      });
  }

  exists(room: string, ref: string): boolean {
    return existsSync(this.path(room, ref));
  }
}
