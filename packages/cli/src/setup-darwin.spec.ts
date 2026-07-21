import { existsSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { bootstrapLaunchAgent, type LaunchAgentBootstrap } from './setup.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(() => true) };
});

const DOMAIN = 'gui/501';
const TARGET = 'gui/501/app.codor.switchboard';
const PLIST = '/Users/x/Library/LaunchAgents/app.codor.switchboard.plist';
const NODE = '/opt/homebrew/bin/node';
const ENTRY = '/opt/homebrew/lib/node_modules/@codor/cli/dist/index.js';
const ENDPOINT = 'http://127.0.0.1:8137';

/** An exec stub driven by per-command behaviors; records the command sequence. */
function execWith(behavior: {
  bootstrap?: () => string;
  print?: () => string; // throws => target not loaded
  bootout?: () => string;
}): { commands: string[]; exec: (command: string, args: string[]) => string } {
  const commands: string[] = [];
  const exec = (command: string, args: string[]): string => {
    commands.push([command, ...args].join(' '));
    if (command === 'launchctl' && args[0] === 'bootstrap') return (behavior.bootstrap ?? (() => ''))();
    if (command === 'launchctl' && args[0] === 'print') return (behavior.print ?? (() => { throw new Error('Could not find service'); }))();
    if (command === 'launchctl' && args[0] === 'bootout') return (behavior.bootout ?? (() => ''))();
    return '';
  };
  return { commands, exec };
}

function deps(exec: LaunchAgentBootstrap['exec'], overrides: Partial<LaunchAgentBootstrap> = {}): LaunchAgentBootstrap {
  return {
    exec,
    probe: async () => false,
    sleep: async () => undefined,
    exists: () => true,
    domain: DOMAIN,
    target: TARGET,
    plistPath: PLIST,
    nodePath: NODE,
    cliEntrypoint: ENTRY,
    endpoint: ENDPOINT,
    log: () => undefined,
    ...overrides,
  };
}

const exit5 = (): never => { throw Object.assign(new Error(`Command failed: launchctl bootstrap ${DOMAIN} ${PLIST}\nBootstrap failed: 5: Input/output error`), { status: 5, stderr: 'Bootstrap failed: 5: Input/output error\n' }); };

describe('bootstrapLaunchAgent validation', () => {
  it('lints the plist and requires Node and the entrypoint before any launchctl command', async () => {
    const { commands, exec } = execWith({});
    await bootstrapLaunchAgent(deps(exec));
    expect(commands[0]).toBe(`plutil -lint ${PLIST}`);
    expect(commands.slice(1)).toEqual([
      `launchctl bootout ${TARGET}`,
      `launchctl bootstrap ${DOMAIN} ${PLIST}`,
      `launchctl enable ${TARGET}`,
      `launchctl kickstart -k ${TARGET}`,
    ]);
  });

  it('throws before any launchctl command when the plist is missing', async () => {
    vi.mocked(existsSync).mockImplementationOnce(() => false);
    const { commands, exec } = execWith({});
    await expect(bootstrapLaunchAgent(deps(exec))).rejects.toThrow(/plist is missing/);
    expect(commands).toEqual([]);
  });

  it('throws before any launchctl command when the CLI entrypoint does not exist', async () => {
    const { commands, exec } = execWith({});
    await expect(bootstrapLaunchAgent(deps(exec, { exists: (path) => path !== ENTRY }))).rejects.toThrow(/CLI entrypoint does not exist/);
    expect(commands.filter((c) => c.startsWith('launchctl'))).toEqual([]);
  });

  it('throws when plutil rejects the plist', async () => {
    const { exec } = execWith({});
    const failingPlutil: LaunchAgentBootstrap['exec'] = (command, args) => {
      if (command === 'plutil') throw new Error('property list error');
      return exec(command, args);
    };
    await expect(bootstrapLaunchAgent(deps(failingPlutil))).rejects.toThrow(/did not pass plutil/);
  });
});

describe('bootstrapLaunchAgent recovery', () => {
  it("retries Richard's exact multiline exit-5 error and then completes", async () => {
    let attempts = 0;
    const { commands, exec } = execWith({ bootstrap: () => { attempts += 1; if (attempts === 1) exit5(); return ''; } });
    await bootstrapLaunchAgent(deps(exec, { probe: async () => false }));
    expect(commands.filter((c) => c.includes('bootstrap')).length).toBe(2); // failed, then succeeded
    expect(commands).toContain(`launchctl enable ${TARGET}`);
  });

  it('treats a status-5 error with no matching text as retryable', async () => {
    let attempts = 0;
    const { commands, exec } = execWith({ bootstrap: () => { attempts += 1; if (attempts === 1) throw Object.assign(new Error('opaque'), { status: 5 }); return ''; } });
    await bootstrapLaunchAgent(deps(exec));
    expect(commands.filter((c) => c.includes('bootstrap')).length).toBe(2);
  });

  it('accepts an already-loaded, healthy daemon on a bootstrap error without restarting', async () => {
    const { commands, exec } = execWith({
      bootstrap: () => { throw Object.assign(new Error('Bootstrap failed: 37: already loaded'), { status: 37 }); },
      print: () => 'app.codor.switchboard = { state = running }', // loaded
    });
    await bootstrapLaunchAgent(deps(exec, { probe: async () => true }));
    expect(commands).not.toContain(`launchctl enable ${TARGET}`);
    expect(commands).not.toContain(`launchctl kickstart -k ${TARGET}`);
  });

  it('does NOT accept a briefly-healthy orphan whose print is absent', async () => {
    // Probe answers true (dying process) but print says not loaded: not success.
    let attempts = 0;
    const { commands, exec } = execWith({
      bootstrap: () => { attempts += 1; if (attempts < 3) exit5(); return ''; },
      print: () => { throw new Error('Could not find service'); }, // absent
    });
    await bootstrapLaunchAgent(deps(exec, { probe: async () => true }));
    // It retried rather than returning on the healthy-but-unloaded probe.
    expect(attempts).toBe(3);
    expect(commands).toContain(`launchctl enable ${TARGET}`);
  });

  it('fails with one concise diagnostic, never suggesting root, after the bounded recovery', async () => {
    const { exec } = execWith({ bootstrap: () => exit5(), print: () => { throw new Error('absent'); } });
    await expect(bootstrapLaunchAgent(deps(exec, { probe: async () => false }))).rejects.toThrow(/could not start the Codor LaunchAgent/);
    const { exec: exec2 } = execWith({ bootstrap: () => exit5(), print: () => { throw new Error('absent'); } });
    await expect(bootstrapLaunchAgent(deps(exec2, { probe: async () => false }))).rejects.not.toThrow(/sudo|root/i);
  });

  it('throws immediately for a non-retryable error', async () => {
    let attempts = 0;
    const { exec } = execWith({ bootstrap: () => { attempts += 1; throw Object.assign(new Error('Bootstrap failed: 125: Malformed'), { status: 125 }); } });
    await expect(bootstrapLaunchAgent(deps(exec, { probe: async () => false }))).rejects.toThrow(/could not start/);
    expect(attempts).toBe(1);
  });
});
