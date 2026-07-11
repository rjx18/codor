import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeWorkingDirectory } from './working-directory.js';

describe('working directory normalization', () => {
  it('expands home shorthand and preserves absolute directories', () => {
    const home = mkdtempSync(join(tmpdir(), 'wireroom-cwd-home-'));
    expect(normalizeWorkingDirectory('~/', home)).toBe(home);
    expect(normalizeWorkingDirectory(home, '/unused')).toBe(home);
  });

  it('rejects relative, missing, and file paths with specific diagnostics', () => {
    const home = mkdtempSync(join(tmpdir(), 'wireroom-cwd-errors-'));
    const file = join(home, 'file.txt');
    writeFileSync(file, 'not a directory');
    expect(() => normalizeWorkingDirectory('relative', home)).toThrow(
      'working directory relative must be absolute',
    );
    expect(() => normalizeWorkingDirectory('~/missing', home)).toThrow(
      `working directory ${join(home, 'missing')} does not exist`,
    );
    expect(() => normalizeWorkingDirectory(file, home)).toThrow(`${file} is not a directory`);
  });
});
