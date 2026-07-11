import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import matter from 'gray-matter';
import { RoomIdSchema } from '@codor/protocol';
import { z } from 'zod';

export const LedgerNoteTypeSchema = z.enum(['decision', 'constraint', 'contract']);
export type LedgerNoteType = z.infer<typeof LedgerNoteTypeSchema>;

export interface LedgerNote {
  name: string;
  type?: LedgerNoteType;
  body: string;
  content: string;
  relative_path: string;
}

const NOTE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const LedgerWriteSchema = z.object({
  name: z.string().regex(NOTE_NAME, 'ledger note name must be a lowercase slug'),
  type: LedgerNoteTypeSchema,
  body: z.string(),
  author: z.string().trim().min(1, 'ledger author must not be empty'),
}).strict();
export type LedgerWrite = z.infer<typeof LedgerWriteSchema>;

const template = (name: string, type: LedgerNoteType, heading: string): string =>
  matter.stringify(`# ${heading}\n\n`, { name, type });

function safeNoteName(name: string): string {
  if (!NOTE_NAME.test(name)) throw new Error('ledger note name must be a lowercase slug');
  return name;
}

function noteTypeDirectory(type: LedgerNoteType): string {
  return `${type}s`;
}

function validLedgerWrite(write: unknown): LedgerWrite {
  const parsed = LedgerWriteSchema.safeParse(write);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'write'}: ${issue.message}`)
    .join('; ');
  throw new Error(`invalid ledger write: ${detail}`);
}

// harn:assume ledger-home-only-refs-travel ref=home-ledger-vault
export class LedgerVault {
  readonly root: string;
  private readonly auditRoot: string;

  constructor(dataDir: string, readonly room: string) {
    RoomIdSchema.parse(room);
    this.root = join(resolve(dataDir), 'rooms', room, 'ledger');
    // harn:assume codor-runtime-identity-is-a-clean-break ref=ledger-runtime-identity
    this.auditRoot = join(this.root, '.codor-audit');
    // harn:end codor-runtime-identity-is-a-clean-break
  }

  isEnabled(): boolean {
    return existsSync(this.root);
  }

  bootstrap(): void {
    for (const directory of ['decisions', 'constraints', 'contracts']) {
      mkdirSync(join(this.root, directory), { recursive: true, mode: 0o700 });
    }
    mkdirSync(this.auditRoot, { recursive: true, mode: 0o700 });
    this.writeIfMissing('INDEX.md', matter.stringify(
      '# Channel Ledger\n\n## Decisions\n\n## Constraints\n\n## Contracts\n',
      { name: 'index' },
    ));
    this.writeIfMissing(
      'decisions/_template.md',
      template('decision-template', 'decision', 'Decision'),
    );
    this.writeIfMissing(
      'constraints/_template.md',
      template('constraint-template', 'constraint', 'Constraint'),
    );
    this.writeIfMissing(
      'contracts/_template.md',
      template('contract-template', 'contract', 'Contract'),
    );
  }

  add(write: LedgerWrite): LedgerNote {
    this.bootstrap();
    const valid = validLedgerWrite(write);
    const name = safeNoteName(valid.name);
    const path = resolve(this.root, noteTypeDirectory(valid.type), `${name}.md`);
    if (!this.contains(path)) throw new Error('ledger write path must remain inside the channel vault');
    const content = matter.stringify(
      valid.body.endsWith('\n') ? valid.body : `${valid.body}\n`,
      { name, type: valid.type },
    );
    this.writeAuditMarker(path, valid.author, content);
    writeFileSync(path, content);
    return this.note(name)!;
  }

  note(name: string): LedgerNote | undefined {
    safeNoteName(name);
    if (!this.isEnabled()) return undefined;
    for (const path of this.markdownFiles()) {
      const parsed = this.parse(path);
      if (parsed.name === name) return parsed;
    }
    return undefined;
  }

  noteAt(path: string): LedgerNote | undefined {
    if (!this.contains(path) || !path.endsWith('.md') || !existsSync(path)) return undefined;
    return this.parse(path);
  }

  snapshot(): Record<string, string> {
    if (!this.isEnabled()) return {};
    return Object.fromEntries(this.markdownFiles().map((path) => [
      relative(this.root, path).split(sep).join('/'),
      readFileSync(path, 'utf8'),
    ]));
  }

  pull(destination: string): string {
    const target = join(resolve(destination), 'ledger');
    for (const [relativePath, content] of Object.entries(this.snapshot())) {
      const path = join(target, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    return target;
  }

  consumeAuditAuthor(path: string): string | undefined {
    const marker = this.auditMarker(path);
    if (!existsSync(marker)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(marker, 'utf8')) as {
        author?: unknown;
        content_hash?: unknown;
      };
      const currentHash = existsSync(path) ? this.contentHash(readFileSync(path)) : undefined;
      return typeof parsed.author === 'string' && parsed.author !== '' &&
        typeof parsed.content_hash === 'string' && parsed.content_hash === currentHash
        ? parsed.author
        : undefined;
    } finally {
      rmSync(marker, { force: true });
    }
  }

  private writeIfMissing(relativePath: string, content: string): void {
    const path = join(this.root, relativePath);
    if (!existsSync(path)) writeFileSync(path, content);
  }

  private markdownFiles(): string[] {
    const files: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === '.codor-audit') continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
      }
    };
    visit(this.root);
    return files.sort();
  }

  private parse(path: string): LedgerNote {
    const content = readFileSync(path, 'utf8');
    const parsed = matter(content);
    const fallback = basename(path, '.md').replace(/^_/, '');
    const name = typeof parsed.data.name === 'string' ? parsed.data.name : fallback;
    const noteType = LedgerNoteTypeSchema.safeParse(parsed.data.type);
    return {
      name,
      type: noteType.success ? noteType.data : undefined,
      body: parsed.content,
      content,
      relative_path: relative(this.root, path).split(sep).join('/'),
    };
  }

  private writeAuditMarker(path: string, author: string, content: string): void {
    mkdirSync(this.auditRoot, { recursive: true, mode: 0o700 });
    writeFileSync(this.auditMarker(path), JSON.stringify({
      author,
      content_hash: this.contentHash(content),
    }));
  }

  private contentHash(content: string | Buffer): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private auditMarker(path: string): string {
    const encoded = Buffer.from(relative(this.root, path), 'utf8').toString('base64url');
    return join(this.auditRoot, `${encoded}.json`);
  }

  private contains(path: string): boolean {
    const fromRoot = relative(this.root, resolve(path));
    return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !fromRoot.startsWith(sep);
  }
}
// harn:end ledger-home-only-refs-travel
