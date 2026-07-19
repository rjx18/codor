import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listLocalDirectories, LocalDirectoryError } from './local-dirs.js';

describe('home-contained local directory listing', () => {
  it('lists sorted directories, hides dotdirs by default, and stops at home', () => {
    const home = mkdtempSync(join(tmpdir(), 'codor-dirs-home-'));
    mkdirSync(join(home, 'zeta'));
    mkdirSync(join(home, 'alpha'));
    mkdirSync(join(home, '.hidden'));
    writeFileSync(join(home, 'file.txt'), 'ignored');
    expect(listLocalDirectories(undefined, false, home)).toEqual({
      path: home,
      parent: null,
      dirs: [
        { name: 'alpha', path: join(home, 'alpha') },
        { name: 'zeta', path: join(home, 'zeta') },
      ],
    });
    expect(listLocalDirectories(home, true, home).dirs.map((entry) => entry.name))
      .toEqual(['.hidden', 'alpha', 'zeta']);
  });

  it('rejects traversal, symlink escape, relative, missing, and file targets', () => {
    const home = mkdtempSync(join(tmpdir(), 'codor-dirs-contained-'));
    const outside = mkdtempSync(join(tmpdir(), 'codor-dirs-outside-'));
    const file = join(home, 'file.txt');
    writeFileSync(file, 'file');
    symlinkSync(outside, join(home, 'escape'), 'junction');
    for (const target of [outside, join(home, 'escape')]) {
      expect(() => listLocalDirectories(target, false, home)).toThrowError(
        expect.objectContaining<Partial<LocalDirectoryError>>({ status: 403 }),
      );
    }
    expect(() => listLocalDirectories('relative', false, home)).toThrowError(
      expect.objectContaining<Partial<LocalDirectoryError>>({ status: 400 }),
    );
    expect(() => listLocalDirectories(join(home, 'missing'), false, home)).toThrowError(
      expect.objectContaining<Partial<LocalDirectoryError>>({ status: 404 }),
    );
    expect(() => listLocalDirectories(file, false, home)).toThrowError(
      expect.objectContaining<Partial<LocalDirectoryError>>({ status: 400 }),
    );
  });
});
