import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Injectable filesystem surface so the launcher logic is unit-testable. `home` and
 *  the PATH entries are passed as data (from setup's resolved home/env), never read
 *  from the process, so setup's overrides stay authoritative. */
export interface LauncherIo {
  exists(path: string): boolean;
  read(path: string): string | undefined;
  write(path: string, content: string, mode?: number): void;
  mkdirp(path: string, mode: number): void;
  chmod(path: string, mode: number): void;
}

export const defaultLauncherIo: LauncherIo = {
  exists: (path) => existsSync(path),
  read: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  write: (path, content, mode) => writeFileSync(path, content, mode === undefined ? undefined : { mode }),
  mkdirp: (path, mode) => { mkdirSync(path, { recursive: true, mode }); },
  chmod: (path, mode) => chmodSync(path, mode),
};

export type LauncherAction = 'created' | 'updated' | 'unchanged';

const localBinDir = (home: string): string => join(home, '.local', 'bin');

/** The deterministic shim: exec the SAME Node and CLI entrypoint the service uses. */
export function launcherShim(nodePath: string, cliEntrypoint: string): string {
  return [
    '#!/bin/sh',
    '# codor launcher — installed by `codor setup`; re-run setup to refresh it.',
    '# Pinned to the same Node interpreter and runtime the Codor service uses, so',
    '# the command line and the background service can never disagree on runtimes.',
    `exec "${nodePath}" "${cliEntrypoint}" "$@"`,
    '',
  ].join('\n');
}

// harn:assume setup-installs-user-launcher-shim ref=launcher-shim-install
/**
 * Write (or idempotently refresh) the executable `~/.local/bin/codor` launcher that
 * exec's the service's Node + CLI entrypoint. Returns the path and whether the file
 * changed; a re-run with the same runtime rewrites nothing (but still fixes the mode).
 */
export function installLauncherShim(options: {
  home: string;
  nodePath: string;
  cliEntrypoint: string;
  io?: LauncherIo;
}): { path: string; action: LauncherAction } {
  const io = options.io ?? defaultLauncherIo;
  const dir = localBinDir(options.home);
  const path = join(dir, 'codor');
  io.mkdirp(dir, 0o700);
  const desired = launcherShim(options.nodePath, options.cliEntrypoint);
  const existing = io.read(path);
  if (existing === desired) {
    io.chmod(path, 0o755); // keep it executable even when the content already matches
    return { path, action: 'unchanged' };
  }
  io.write(path, desired, 0o755);
  return { path, action: existing === undefined ? 'created' : 'updated' };
}
// harn:end setup-installs-user-launcher-shim

const PATH_MARKER_START = '# >>> codor launcher PATH (managed by codor setup) >>>';
const PATH_MARKER_END = '# <<< codor launcher PATH (managed by codor setup) <<<';

/** The marked, idempotent ~/.zprofile block; the comment carries its own rationale. */
function zprofilePathBlock(dir: string): string {
  return [
    PATH_MARKER_START,
    '# macOS Terminal opens a login shell, which sources ~/.zprofile — so this is the',
    "# file that must carry ~/.local/bin (where 'codor setup' installs the codor",
    '# launcher). setup maintains this block; edit above or below it, not inside.',
    `export PATH="${dir}:$PATH"`,
    PATH_MARKER_END,
    '',
  ].join('\n');
}

// harn:assume setup-macos-ensures-local-bin-on-path ref=launcher-path-ensure
/**
 * Make `~/.local/bin` reachable so the shim resolves in a new shell. On macOS, when it
 * is not already on PATH, append a single marked, idempotent block to ~/.zprofile (a
 * re-run is a no-op via the marker) and report it. On Linux the profile is never
 * edited (mainstream distros already include it); only guidance is printed when it is
 * absent. Windows is out of scope. Returns whether a profile block was written.
 */
export function ensureLocalBinOnPath(options: {
  home: string;
  platform: NodeJS.Platform;
  pathEntries: string[];
  log: (message: string) => void;
  io?: LauncherIo;
}): { wrote: boolean } {
  const io = options.io ?? defaultLauncherIo;
  const dir = localBinDir(options.home);
  if (options.pathEntries.includes(dir)) return { wrote: false };
  if (options.platform !== 'darwin') {
    options.log(`add ${dir} to your PATH so the codor command resolves (it is not on PATH here)`);
    return { wrote: false };
  }
  const zprofile = join(options.home, '.zprofile');
  const existing = io.read(zprofile);
  if (existing !== undefined && existing.includes(PATH_MARKER_START)) return { wrote: false };
  const base = existing === undefined || existing === '' ? '' : existing.endsWith('\n') ? existing : `${existing}\n`;
  io.write(zprofile, `${base}${base === '' ? '' : '\n'}${zprofilePathBlock(dir)}`);
  options.log('added ~/.local/bin to your PATH in ~/.zprofile — open a new terminal for the codor command');
  return { wrote: true };
}
// harn:end setup-macos-ensures-local-bin-on-path

/**
 * The Install-step entry point: write the launcher shim, then ensure ~/.local/bin is
 * on PATH. Composition only — each obligation is anchored in its own function above.
 */
export function installLauncher(options: {
  home: string;
  nodePath: string;
  cliEntrypoint: string;
  platform: NodeJS.Platform;
  pathEntries: string[];
  log: (message: string) => void;
  io?: LauncherIo;
}): { path: string; action: LauncherAction } {
  const shim = installLauncherShim(options);
  ensureLocalBinOnPath(options);
  return shim;
}
