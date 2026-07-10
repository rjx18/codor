import { mkdirSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

import { watch, type FSWatcher } from 'chokidar';
import { z } from 'zod';

import type { HyperswarmTransport } from '../transport/hyperswarm.js';
import type { TransportEnvelope } from '../transport/peer.js';
import { envelopeUlid } from '../transport/peer.js';
import { LedgerResolver, type ResolvedLedgerRef } from './resolve.js';
import {
  LedgerVault,
  LedgerWriteSchema,
  type LedgerNote,
  type LedgerWrite,
} from './vault.js';

export interface LedgerChange {
  room: string;
  name: string;
  author: string;
}

export const LedgerAddRequestSchema = z.object({
  request_id: z.ulid(),
  write: LedgerWriteSchema,
}).strict();
type LedgerAddRequest = z.infer<typeof LedgerAddRequestSchema>;

interface LedgerAddResult {
  request_id: string;
  ok: boolean;
  note?: LedgerNote;
  error?: string;
}

export interface LedgerManagerOptions {
  dataDir: string;
  transport?: HyperswarmTransport;
  onChange?: (change: LedgerChange) => void;
}

// harn:assume ledger-writes-audited-in-room ref=ledger-change-audit
export class LedgerManager {
  private readonly dataDir: string;
  private readonly roomsRoot: string;
  private readonly watcher: FSWatcher;
  private readonly suppressed = new Set<string>();
  private onChange?: (change: LedgerChange) => void;
  private roomExists: (room: string) => boolean = () => false;
  private readonly stopTransport?: () => void;

  constructor(options: LedgerManagerOptions) {
    this.dataDir = options.dataDir;
    this.roomsRoot = join(this.dataDir, 'rooms');
    mkdirSync(this.roomsRoot, { recursive: true, mode: 0o700 });
    this.onChange = options.onChange;
    this.watcher = watch(this.roomsRoot, {
      ignoreInitial: true,
      persistent: false,
      awaitWriteFinish: { stabilityThreshold: 25, pollInterval: 10 },
    });
    const changed = (path: string): void => this.recordPath(path);
    this.watcher.on('add', changed);
    this.watcher.on('change', changed);
    this.watcher.on('unlink', changed);
    this.stopTransport = options.transport?.onEnvelope((envelope, peerId) =>
      this.handleEnvelope(options.transport!, envelope, peerId));
  }

  setChangeHandler(handler: (change: LedgerChange) => void): void {
    this.onChange = handler;
  }

  setRoomValidator(validator: (room: string) => boolean): void {
    this.roomExists = validator;
  }

  enable(room: string): LedgerVault {
    const vault = this.vault(room);
    vault.bootstrap();
    return vault;
  }

  isEnabled(room: string): boolean {
    return this.vault(room).isEnabled();
  }

  add(room: string, write: LedgerWrite): LedgerNote {
    const vault = this.enable(room);
    const note = vault.add(write);
    const path = resolve(vault.root, note.relative_path);
    this.recordChange(room, vault, path);
    this.suppressed.add(path);
    const expiry = setTimeout(() => this.suppressed.delete(path), 1_000);
    expiry.unref();
    return note;
  }

  note(room: string, name: string): LedgerNote | undefined {
    return this.vault(room).note(name);
  }

  resolve(room: string, names: string[]): ResolvedLedgerRef[] {
    return new LedgerResolver((targetRoom, name) => this.note(targetRoom, name))
      .resolve(room, names);
  }

  snapshot(room: string): Record<string, string> {
    return this.vault(room).snapshot();
  }

  pull(room: string, destination: string): string {
    return this.vault(room).pull(destination);
  }

  async close(): Promise<void> {
    this.stopTransport?.();
    await this.watcher.close();
  }

  private vault(room: string): LedgerVault {
    return new LedgerVault(this.dataDir, room);
  }

  private recordPath(path: string): void {
    if (!path.endsWith('.md')) return;
    const parts = relative(this.roomsRoot, path).split(sep);
    if (parts.length < 3 || parts[1] !== 'ledger') return;
    const room = parts[0]!;
    this.recordChange(room, this.vault(room), resolve(path));
  }

  private recordChange(room: string, vault: LedgerVault, path: string): void {
    if (this.suppressed.delete(resolve(path))) return;
    const note = vault.noteAt(path);
    const fallback = basename(path, '.md').replace(/^_/, '');
    const author = vault.consumeAuditAuthor(path) ?? 'operator';
    this.onChange?.({ room, name: note?.name ?? fallback, author });
  }

  private async handleEnvelope(
    transport: HyperswarmTransport,
    envelope: TransportEnvelope,
    peerId: string,
  ): Promise<void> {
    if (envelope.kind !== 'ledger_add') return;
    const candidate = envelope.payload as { request_id?: unknown } | null;
    const requestId = typeof candidate?.request_id === 'string' ? candidate.request_id : '';
    let result: LedgerAddResult;
    try {
      const request = LedgerAddRequestSchema.parse(envelope.payload);
      if (!this.roomExists(envelope.room)) throw new Error(`no such home room ${envelope.room}`);
      if (request.write.author === 'operator') {
        throw new Error("remote ledger writes cannot claim the reserved 'operator' author");
      }
      result = { request_id: request.request_id, ok: true, note: this.add(envelope.room, request.write) };
    } catch (error) {
      result = { request_id: requestId, ok: false, error: String(error) };
    }
    transport.send(peerId, { room: envelope.room, kind: 'ledger_result', payload: result });
  }
}
// harn:end ledger-writes-audited-in-room

export async function addRemoteLedgerNote(
  transport: HyperswarmTransport,
  homePeer: string,
  room: string,
  write: LedgerWrite,
  timeoutMs = 10_000,
): Promise<LedgerNote> {
  const requestId = envelopeUlid();
  return new Promise<LedgerNote>((resolve, reject) => {
    const stop = transport.onEnvelope((envelope, peerId) => {
      if (peerId !== homePeer || envelope.kind !== 'ledger_result' || envelope.room !== room) return;
      const result = envelope.payload as LedgerAddResult;
      if (result.request_id !== requestId) return;
      clearTimeout(timer);
      stop();
      if (result.ok && result.note) resolve(result.note);
      else reject(new Error(result.error ?? 'remote ledger write failed'));
    });
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`timed out waiting for ledger write ${requestId}`));
    }, timeoutMs);
    transport.send(homePeer, {
      room,
      kind: 'ledger_add',
      payload: { request_id: requestId, write } satisfies LedgerAddRequest,
    });
  });
}
