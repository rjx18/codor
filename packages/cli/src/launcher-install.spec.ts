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
}

function fakeIo(seed: Record<string, string> = {}): FakeIo {
  const files = new Map(Object.entries(seed));
  const dirs = new Set<string>();
  const modes = new Map<string, number>();
  return {
    files,
    dirs,
    modes,
    exists: (path) => files.has(path) || dirs.has(path),
    read: (path) => files.get(path),
    write: (path, content, mode) => {
      files.set(path, content);
      if (mode !== undefined) modes.set(path, mode);
    },
    mkdirp: (path) => void dirs.add(path),
    chmod: (path, mode) => void modes.set(path, mode),
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
