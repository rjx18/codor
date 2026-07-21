import { describe, expect, it } from 'vitest';

import { copyToClipboard, type ClipboardResult, type ClipboardSpawn } from './clipboard.js';

const URL = 'https://host.ts.net/pair?pairing_token=YrBG41M28KVjYaR05P7Zb7HcykxA-3pPGa18bPCXvoo';

/** A spawn that records every invocation and returns a scripted result. */
function recorder(result: (command: string) => ClipboardResult = () => ({ status: 0 })) {
  const calls: Array<{ command: string; args: readonly string[]; input: string }> = [];
  const spawn: ClipboardSpawn = (command, args, input) => {
    calls.push({ command, args, input });
    return result(command);
  };
  return { calls, spawn };
}

/** A `which` that reports only the named tools as installed. */
const has = (...tools: string[]) => (command: string): string | undefined =>
  tools.includes(command) ? `/usr/bin/${command}` : undefined;

// harn:assume setup-copies-pairing-link-once-via-clipboard ref=clipboard-copy-regression
describe('copyToClipboard', () => {
  it('uses pbcopy on macOS and passes the URL on stdin, never in argv', () => {
    const { calls, spawn } = recorder();
    const ok = copyToClipboard(URL, { platform: 'darwin', env: {}, which: has('pbcopy'), spawn });
    expect(ok).toBe(true);
    expect(calls).toEqual([{ command: 'pbcopy', args: [], input: URL }]);
    // The token must never leak into process arguments.
    expect(calls.every(({ args }) => !args.join(' ').includes('pairing_token'))).toBe(true);
  });

  it('uses clip.exe on Windows', () => {
    const { calls, spawn } = recorder();
    const ok = copyToClipboard(URL, { platform: 'win32', env: {}, which: has('clip.exe'), spawn });
    expect(ok).toBe(true);
    expect(calls.map((call) => call.command)).toEqual(['clip.exe']);
  });

  it('uses clip.exe on WSL, detected from the environment', () => {
    const { calls, spawn } = recorder();
    const ok = copyToClipboard(URL, { platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, which: has('clip.exe'), spawn });
    expect(ok).toBe(true);
    expect(calls.map((call) => call.command)).toEqual(['clip.exe']);
  });

  it('prefers wl-copy on Linux when it is available', () => {
    const { calls, spawn } = recorder();
    const ok = copyToClipboard(URL, { platform: 'linux', env: {}, which: has('wl-copy', 'xclip', 'xsel'), spawn });
    expect(ok).toBe(true);
    expect(calls.map((call) => call.command)).toEqual(['wl-copy']);
  });

  it('falls back to xclip, then xsel, when earlier Linux tools are absent', () => {
    const xclip = recorder();
    expect(copyToClipboard(URL, { platform: 'linux', env: {}, which: has('xclip', 'xsel'), spawn: xclip.spawn })).toBe(true);
    expect(xclip.calls.map((call) => call.command)).toEqual(['xclip']);
    expect(xclip.calls[0]!.args).toEqual(['-selection', 'clipboard']);

    const xsel = recorder();
    expect(copyToClipboard(URL, { platform: 'linux', env: {}, which: has('xsel'), spawn: xsel.spawn })).toBe(true);
    expect(xsel.calls.map((call) => call.command)).toEqual(['xsel']);
    expect(xsel.calls[0]!.args).toEqual(['--clipboard', '--input']);
  });

  it('tries the next Linux tool when an available one fails', () => {
    const { calls, spawn } = recorder((command) => (command === 'wl-copy' ? { status: 1 } : { status: 0 }));
    const ok = copyToClipboard(URL, { platform: 'linux', env: {}, which: has('wl-copy', 'xclip'), spawn });
    expect(ok).toBe(true);
    expect(calls.map((call) => call.command)).toEqual(['wl-copy', 'xclip']);
  });

  it('returns false when no clipboard tool is installed', () => {
    const { calls, spawn } = recorder();
    const ok = copyToClipboard(URL, { platform: 'linux', env: {}, which: has(), spawn });
    expect(ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('returns false when the only tool exits non-zero', () => {
    const { spawn } = recorder(() => ({ status: 1 }));
    expect(copyToClipboard(URL, { platform: 'darwin', env: {}, which: has('pbcopy'), spawn })).toBe(false);
  });

  it('returns false, never throwing, when the spawn errors', () => {
    const spawn: ClipboardSpawn = () => ({ status: null, error: new Error('ENOENT') });
    expect(copyToClipboard(URL, { platform: 'darwin', env: {}, which: has('pbcopy'), spawn })).toBe(false);
  });
});
// harn:end setup-copies-pairing-link-once-via-clipboard
