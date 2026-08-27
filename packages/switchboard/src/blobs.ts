import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { WireEvent } from '@codor/protocol';

import type { JournalEventSpan } from './transcript-history-index.js';

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

  // harn:assume indexed-transcript-pages-read-only-current-selected-evidence ref=indexed-journal-byte-spans
  /** Full authoritative read plus byte spans used only to derive a rebuildable
   * lookup index. Invalid JSONL records retain the legacy behavior of being
   * skipped and therefore do not consume a journal event index. */
  readWithSpans(room: string, ref: string): {
    events: WireEvent[];
    spans: JournalEventSpan[];
  } {
    const file = this.path(room, ref);
    if (!existsSync(file)) return { events: [], spans: [] };
    const content = readFileSync(file);
    const events: WireEvent[] = [];
    const spans: JournalEventSpan[] = [];
    let offset = 0;
    while (offset < content.length) {
      const newline = content.indexOf(0x0a, offset);
      const end = newline < 0 ? content.length : newline;
      const length = end - offset;
      if (content.subarray(offset, end).toString('utf8').trim() !== '') {
        try {
          events.push(JSON.parse(content.subarray(offset, end).toString('utf8')) as WireEvent);
          spans.push({ index: events.length - 1, offset, length });
        } catch {
          // Match read(): malformed journal lines remain invisible.
        }
      }
      offset = end + 1;
    }
    return { events, spans };
  }

  /** Read only immutable event ranges selected by a warmed transcript page. */
  readSpans(room: string, ref: string, spans: readonly JournalEventSpan[]): WireEvent[] {
    if (spans.length === 0) return [];
    const file = this.path(room, ref);
    const descriptor = openSync(file, 'r');
    try {
      return spans.map((span) => {
        const buffer = Buffer.allocUnsafe(span.length);
        const bytes = readSync(descriptor, buffer, 0, span.length, span.offset);
        if (bytes !== span.length) throw new Error('indexed run journal span is unavailable');
        return JSON.parse(buffer.toString('utf8')) as WireEvent;
      });
    } finally {
      closeSync(descriptor);
    }
  }
  // harn:end indexed-transcript-pages-read-only-current-selected-evidence

  exists(room: string, ref: string): boolean {
    return existsSync(this.path(room, ref));
  }
}
