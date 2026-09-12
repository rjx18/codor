import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ensureLocalBinOnPath,
  installLauncherShim,
  launcherShim,
  type LauncherIo,
} from './launcher-install.js';

interface FakeIo extends LauncherIo {
  files: Map<string, string>;
  dirs: Set<string>;
  modes: Map<string, number>;
  symlinks: Set<string>;
}

function fakeIo(seed: Record<string, string> = {}): FakeIo {
  const files = new Map(Object.entries(seed));
  const dirs = new Set<string>();
  const modes = new Map<string, number>();
  const symlinks = new Set<string>();
  return {
    files,
    dirs,
    modes,
    symlinks,
    exists: (path) => files.has(path) || dirs.has(path),
    read: (path) => files.get(path),
    write: (path, content, mode) => {
      files.set(path, content);
      if (mode !== undefined) modes.set(path, mode);
    },
    rename: (from, to) => {
      const content = files.get(from);
      if (content !== undefined) {
        files.set(to, content);
        files.delete(from);
      }
      const mode = modes.get(from);
      if (mode !== undefined) {
        modes.set(to, mode);
        modes.delete(from);
      }
      symlinks.delete(to); // rename replaces the destination entry
    },
    remove: (path) => {
      files.delete(path);
      modes.delete(path);
      symlinks.delete(path);
      dirs.delete(path);
    },
    mkdirp: (path) => void dirs.add(path),
    chmod: (path, mode) => void modes.set(path, mode),
    isSymlink: (path) => symlinks.has(path),
  };
}

const HOME = '/home/tester';
const BIN = '/home/tester/.local/bin';
const LAUNCHER = '/home/tester/.local/bin/codor';
const ZPROFILE = '/home/tester/.zprofile';
const NODE = '/usr/bin/node';
const ENTRY = '/home/tester/.codor/runtime/node_modules/@richhardry/codor/node_modules/@codor/cli/dist/index.js';

describe('launcherShim', () => {
  it('pins the exact Node and CLI entrypoint in an exec line under a POSIX shebang', () => {
    const shim = launcherShim(NODE, ENTRY);
    expect(shim.startsWith('#!/bin/sh')).toBe(true);
    expect(shim).toContain(`exec "${NODE}" "${ENTRY}" "$@"`);
  });
});

describe('installLauncherShim', () => {
  it('creates an executable launcher at ~/.local/bin/codor', () => {
    const io = fakeIo();
    const result = installLauncherShim({ home: HOME, nodePath: NODE, cliEntrypoint: ENTRY, io });
    expect(result).toEqual({ path: LAUNCHER, action: 'created' });
    expect(io.files.get(LAUNCHER)).toBe(launcherShim(NODE, ENTRY));
    expect(io.modes.get(LAUNCHER)).toBe(0o755);
    expect(io.dirs.has(BIN)).toBe(true);
  });

  it('is idempotent — a re-run with the same runtime rewrites nothing', () => {
    const io = fakeIo();
    installLauncherShim({ home: HOME, nodePath: NODE, cliEntrypoint: ENTRY, io });
    expect(installLauncherShim({ home: HOME, nodePath: NODE, cliEntrypoint: ENTRY, io }).action).toBe('unchanged');
  });

  it('updates in place when the runtime path changes, never a stale entrypoint', () => {
    const io = fakeIo();
    installLauncherShim({ home: HOME, nodePath: NODE, cliEntrypoint: ENTRY, io });
    const result = installLauncherShim({ home: HOME, nodePath: '/opt/node', cliEntrypoint: ENTRY, io });
    expect(result.action).toBe('updated');
    expect(io.files.get(LAUNCHER)).toContain('/opt/node');
  });

  // Requirement: a cleanup failure must not replace the error that triggered it.
  // Not covered by the real-filesystem cleanup test, whose cleanup succeeds.
  it('preserves the primary error when the staged-file cleanup also fails', () => {
    const io = fakeIo();
    const primary = new Error('rename failed');
    io.rename = () => { throw primary; };
    io.remove = () => { throw new Error('cleanup failed'); };

    let caught: unknown;
    try {
      installLauncherShim({ home: HOME, nodePath: NODE, cliEntrypoint: ENTRY, io });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(primary);
  });
});

describe('ensureLocalBinOnPath', () => {
  it('does nothing when ~/.local/bin is already on PATH', () => {
    const io = fakeIo();
    const result = ensureLocalBinOnPath({ home: HOME, platform: 'darwin', pathEntries: [BIN, '/usr/bin'], log: () => {}, io });
    expect(result.wrote).toBe(false);
    expect(io.files.has(ZPROFILE)).toBe(false);
  });

  it('appends a marked block to ~/.zprofile on macOS when absent, preserving prior content', () => {
    const io = fakeIo({ [ZPROFILE]: 'export FOO=1\n' });
    const result = ensureLocalBinOnPath({ home: HOME, platform: 'darwin', pathEntries: ['/usr/bin'], log: () => {}, io });
    expect(result.wrote).toBe(true);
    const written = io.files.get(ZPROFILE) ?? '';
    expect(written).toContain('export FOO=1');
    expect(written).toContain('codor launcher PATH (managed by codor setup)');
    expect(written).toContain(`export PATH="${BIN}:$PATH"`);
  });

  it('is idempotent on macOS — a second run writes no second block', () => {
    const io = fakeIo();
    ensureLocalBinOnPath({ home: HOME, platform: 'darwin', pathEntries: ['/usr/bin'], log: () => {}, io });
    const afterFirst = io.files.get(ZPROFILE) ?? '';
    ensureLocalBinOnPath({ home: HOME, platform: 'darwin', pathEntries: ['/usr/bin'], log: () => {}, io });
    expect(io.files.get(ZPROFILE)).toBe(afterFirst);
    expect(afterFirst.match(/>>> codor launcher PATH/g)).toHaveLength(1); // exactly one block start
  });

  it('never edits a profile on Linux — prints guidance only when absent', () => {
    const io = fakeIo();
    const logs: string[] = [];
    const result = ensureLocalBinOnPath({ home: HOME, platform: 'linux', pathEntries: ['/usr/bin'], log: (m) => logs.push(m), io });
    expect(result.wrote).toBe(false);
    expect(io.files.has(ZPROFILE)).toBe(false);
    expect(logs.join(' ')).toMatch(/PATH/);
  });
});

const posixHostIt = it.skipIf(process.platform === 'win32');

function withTempHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'codor-launcher-symlink-'));
  try {
    run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('installLauncherShim on a real filesystem', () => {
  // Requirement: refreshing the launcher replaces the ~/.local/bin/codor path entry
  // and never writes through a symlink to its target. Not redundant with the
  // in-memory tests above, whose Map cannot represent a symlink.
  posixHostIt('replaces a pre-existing symlink without touching its target', () => {
    withTempHome((home) => {
      const bin = join(home, '.local', 'bin');
      mkdirSync(bin, { recursive: true });
      const entrypoint = join(home, 'cli-entrypoint.js');
      writeFileSync(entrypoint, '// compiled CLI entrypoint\n', { mode: 0o755 });
      symlinkSync(entrypoint, join(bin, 'codor'));

      const result = installLauncherShim({ home, nodePath: '/usr/bin/node', cliEntrypoint: entrypoint });

      expect(result.action).toBe('updated');
      expect(readFileSync(entrypoint, 'utf8')).toBe('// compiled CLI entrypoint\n');
      expect(lstatSync(join(bin, 'codor')).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(bin, 'codor'), 'utf8')).toBe(launcherShim('/usr/bin/node', entrypoint));
    });
  });

  // Requirement: a symlink is never "unchanged", even when its target already holds
  // the shim. The content check alone would leave the link in place and chmod its
  // target; only an lstat-first check replaces the entry. Not covered above.
  posixHostIt('replaces a symlink whose target already holds the desired shim', () => {
    withTempHome((home) => {
      const bin = join(home, '.local', 'bin');
      mkdirSync(bin, { recursive: true });
      const nodePath = '/usr/bin/node';
      const entrypoint = '/tmp/entry.js';
      const target = join(home, 'shim-copy');
      writeFileSync(target, launcherShim(nodePath, entrypoint), { mode: 0o644 });
      const before = statSync(target).mode;
      symlinkSync(target, join(bin, 'codor'));

      const result = installLauncherShim({ home, nodePath, cliEntrypoint: entrypoint });

      expect(result.action).toBe('updated');
      expect(lstatSync(join(bin, 'codor')).isSymbolicLink()).toBe(false);
      expect(readFileSync(target, 'utf8')).toBe(launcherShim(nodePath, entrypoint));
      expect(statSync(target).mode).toBe(before); // chmod must not follow the link
    });
  });

  // Requirement: a pre-existing symlink at the staging path is never written
  // through. A predictable staging name let that symlink's target be overwritten
  // and the link itself renamed onto ~/.local/bin/codor. Not covered above.
  posixHostIt('does not write through a symlink planted at the legacy staging path', () => {
    withTempHome((home) => {
      const bin = join(home, '.local', 'bin');
      mkdirSync(bin, { recursive: true });
      const decoy = join(home, 'decoy.js');
      writeFileSync(decoy, '// decoy\n', { mode: 0o755 });
      const legacyTmp = join(bin, 'codor.tmp');
      symlinkSync(decoy, legacyTmp);

      const result = installLauncherShim({ home, nodePath: '/usr/bin/node', cliEntrypoint: '/tmp/entry.js' });

      expect(result.action).toBe('created');
      expect(readFileSync(decoy, 'utf8')).toBe('// decoy\n');
      expect(lstatSync(legacyTmp).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(bin, 'codor')).isSymbolicLink()).toBe(false);
    });
  });

  // Requirement: a failed write or rename must not leave the staged launcher
  // behind. The path is occupied by a directory so rename fails; a leftover
  // `codor.tmp-<uuid>` there would accumulate on every failed attempt.
  posixHostIt('removes the staged file when the rename fails', () => {
    withTempHome((home) => {
      const bin = join(home, '.local', 'bin');
      const launcher = join(bin, 'codor');
      mkdirSync(launcher, { recursive: true }); // a directory blocks the rename

      expect(() => installLauncherShim({ home, nodePath: '/usr/bin/node', cliEntrypoint: '/tmp/entry.js' })).toThrow();

      const leftovers = readdirSync(bin).filter((name) => name.startsWith('codor.tmp-'));
      expect(leftovers).toEqual([]);
      expect(lstatSync(launcher).isDirectory()).toBe(true);
    });
  });
});
