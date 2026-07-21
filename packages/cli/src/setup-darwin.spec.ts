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
const ENDPOINT = 'http://127.0.0.1:8137';

function deps(overrides: Partial<LaunchAgentBootstrap> = {}): { commands: string[]; logs: string[]; deps: LaunchAgentBootstrap } {
  const commands: string[] = [];
  const logs: string[] = [];
  const base: LaunchAgentBootstrap = {
    exec: (command, args) => { commands.push([command, ...args].join(' ')); return ''; },
    probe: async () => false,
    sleep: async () => undefined,
    domain: DOMAIN,
    target: TARGET,
    plistPath: PLIST,
    nodePath: NODE,
    endpoint: ENDPOINT,
    log: (message) => logs.push(message),
    ...overrides,
  };
  return { commands, logs, deps: base };
}

describe('bootstrapLaunchAgent', () => {
  it('bootout, bootstrap, enable, kickstart on a clean start, without probing', async () => {
    const probe = vi.fn(async () => false);
    const { commands, deps: d } = deps({ probe });
    await bootstrapLaunchAgent(d);
    expect(commands).toEqual([
      `launchctl bootout ${TARGET}`,
      `launchctl bootstrap ${DOMAIN} ${PLIST}`,
      `launchctl enable ${TARGET}`,
      `launchctl kickstart -k ${TARGET}`,
    ]);
    expect(probe).not.toHaveBeenCalled();
  });

  it('keeps an already-healthy daemon and does not restart it when bootstrap errors', async () => {
    const { commands, logs, deps: d } = deps({ probe: async () => true });
    d.exec = (command, args) => {
      commands.push([command, ...args].join(' '));
      if (command === 'launchctl' && args[0] === 'bootstrap') throw new Error('Bootstrap failed: 37: already in progress');
      return '';
    };
    await bootstrapLaunchAgent(d);
    // Only bootout + the failed bootstrap ran; no enable, no kickstart (no restart).
    expect(commands).toEqual([`launchctl bootout ${TARGET}`, `launchctl bootstrap ${DOMAIN} ${PLIST}`]);
    expect(logs.join(' ')).toContain('already loaded and healthy');
  });

  it('unloads, waits, re-bootstraps, then enables and kickstarts on a transient exit-5', async () => {
    let bootstraps = 0;
    const { commands, deps: d } = deps({
      probe: async () => false,
    });
    d.exec = (command, args) => {
      commands.push([command, ...args].join(' '));
      if (command === 'launchctl' && args[0] === 'bootstrap') {
        bootstraps += 1;
        if (bootstraps === 1) throw new Error('Bootstrap failed: 5: Input/output error');
      }
      return '';
    };
    await bootstrapLaunchAgent(d);
    expect(commands).toEqual([
      `launchctl bootout ${TARGET}`,
      `launchctl bootstrap ${DOMAIN} ${PLIST}`, // fails (exit 5)
      `launchctl bootout ${TARGET}`, // unload before retry
      `launchctl bootstrap ${DOMAIN} ${PLIST}`, // succeeds
      `launchctl enable ${TARGET}`,
      `launchctl kickstart -k ${TARGET}`,
    ]);
  });

  it('fails with one concise diagnostic, never suggesting root, after the bounded recovery', async () => {
    const { deps: d } = deps({
      exec: (command, args) => {
        if (command === 'launchctl' && args[0] === 'bootstrap') throw new Error('Bootstrap failed: 5: Input/output error');
        if (command === 'launchctl' && args[0] === 'print') return 'app.codor.switchboard = {\n  state = not running\n}';
        return '';
      },
      probe: async () => false, // never healthy
    });
    await expect(bootstrapLaunchAgent(d)).rejects.toThrow(/could not start the Codor LaunchAgent/);
    await expect(bootstrapLaunchAgent(d)).rejects.not.toThrow(/sudo|root/i);
  });

  it('throws immediately for a non-retryable error', async () => {
    let bootstraps = 0;
    const { deps: d } = deps({
      exec: (command, args) => {
        if (command === 'launchctl' && args[0] === 'bootstrap') { bootstraps += 1; throw new Error('Bootstrap failed: 125: Malformed plist'); }
        return '';
      },
      probe: async () => false,
    });
    await expect(bootstrapLaunchAgent(d)).rejects.toThrow(/could not start/);
    expect(bootstraps).toBe(1); // no retry for a non-transient error
  });

  it('validates the plist before running any launchctl command', async () => {
    vi.mocked(existsSync).mockImplementationOnce(() => false); // plist missing
    const { commands, deps: d } = deps();
    await expect(bootstrapLaunchAgent(d)).rejects.toThrow(/plist is missing/);
    expect(commands).toEqual([]);
  });

  it('rejects a non-absolute Node path before any launchctl command', async () => {
    const { commands, deps: d } = deps({ nodePath: 'node' });
    await expect(bootstrapLaunchAgent(d)).rejects.toThrow(/must be absolute/);
    expect(commands).toEqual([]);
  });
});
