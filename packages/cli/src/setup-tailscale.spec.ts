import { resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { configureTailscaleServe, resolveTailscale, tailscaleServeSupported } from './setup.js';

const APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

describe('resolveTailscale', () => {
  it('returns the PATH hit when present', () => {
    // resolveTailscale normalizes the PATH hit through resolve(); build the
    // fixture the same way so the expectation matches on every platform.
    const pathHit = resolve(sep, 'usr', 'bin', 'tailscale');
    expect(resolveTailscale(() => pathHit, 'darwin', () => true)).toBe(pathHit);
  });

  it('falls back to the macOS app location when PATH misses but the app exists', () => {
    const path = resolveTailscale(() => undefined, 'darwin', (candidate) => candidate === APP_CLI);
    expect(path).toBe(APP_CLI);
  });

  it('does not use the macOS app location on other platforms', () => {
    expect(resolveTailscale(() => undefined, 'linux', () => true)).toBeUndefined();
  });

  it('returns undefined when neither PATH nor an app location has it', () => {
    expect(resolveTailscale(() => undefined, 'darwin', () => false)).toBeUndefined();
  });
});

describe('tailscaleServeSupported', () => {
  it('is true when `serve --help` exits cleanly', () => {
    const commands: string[] = [];
    const supported = tailscaleServeSupported(APP_CLI, (command, args) => { commands.push([command, ...args].join(' ')); return ''; });
    expect(supported).toBe(true);
    expect(commands).toEqual([`${APP_CLI} serve --help`]);
  });

  it('is false when the CLI has no serve subcommand', () => {
    const supported = tailscaleServeSupported('/usr/bin/tailscale', () => { throw new Error("flag provided but not defined: 'serve'"); });
    expect(supported).toBe(false);
  });
});

describe('configureTailscaleServe', () => {
  const SELF_STATUS = (dnsName: string): string => JSON.stringify({ Self: { DNSName: dnsName } });

  it('publishes Serve through the resolved absolute path and returns the current HTTPS origin', () => {
    const commands: string[] = [];
    const origin = configureTailscaleServe('/usr/bin/tailscale', 'http://127.0.0.1:8137', (command, args) => {
      commands.push([command, ...args].join(' '));
      if (args.join(' ') === 'status --json') return SELF_STATUS('host.tail-abc.ts.net.');
      if (args.join(' ') === 'serve status') {
        return 'https://host.tail-abc.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:8137';
      }
      return '';
    });
    expect(origin).toBe('https://host.tail-abc.ts.net');
    expect(commands).toEqual([
      '/usr/bin/tailscale serve --bg http://127.0.0.1:8137',
      '/usr/bin/tailscale status --json',
      '/usr/bin/tailscale serve status',
    ]);
  });

  it('selects the current device origin when a stale origin sorts first', () => {
    const status = [
      'https://host.tail-abc.ts.net (tailnet only)',
      '|-- / proxy http://127.0.0.1:8137',
      '',
      'https://host.tail-xyz.ts.net (tailnet only)',
      '|-- / proxy http://127.0.0.1:8137',
    ].join('\n');
    const origin = configureTailscaleServe('/usr/bin/tailscale', 'http://127.0.0.1:8137', (_command, args) => {
      if (args.join(' ') === 'status --json') return SELF_STATUS('host.tail-xyz.ts.net.');
      if (args.join(' ') === 'serve status') return status;
      return '';
    });
    expect(origin).toBe('https://host.tail-xyz.ts.net');
  });

  it('names the configured origins and the reset when none matches the current device', () => {
    const status = [
      'https://host.tail-abc.ts.net (tailnet only)',
      '|-- / proxy http://127.0.0.1:8137',
      '',
      'https://host.tail-xyz.ts.net (tailnet only)',
      '|-- / proxy http://127.0.0.1:8137',
    ].join('\n');
    let message = '';
    try {
      configureTailscaleServe('/usr/bin/tailscale', 'http://127.0.0.1:8137', (_command, args) => {
        if (args.join(' ') === 'status --json') return SELF_STATUS('host.tail-new.ts.net.');
        if (args.join(' ') === 'serve status') return status;
        return '';
      });
    } catch (caught) {
      message = caught instanceof Error ? caught.message : String(caught);
    }
    expect(message).toContain('https://host.tail-abc.ts.net');
    expect(message).toContain('https://host.tail-xyz.ts.net');
    expect(message).toContain('tailscale serve reset');
  });

  it('rejects a current-name origin that does not proxy the Codor endpoint', () => {
    const status = [
      'https://host.tail-xyz.ts.net (tailnet only)',
      '|-- / proxy http://127.0.0.1:9999',
    ].join('\n');
    expect(() => configureTailscaleServe('/usr/bin/tailscale', 'http://127.0.0.1:8137', (_command, args) => {
      if (args.join(' ') === 'status --json') return SELF_STATUS('host.tail-xyz.ts.net.');
      return status;
    })).toThrow(/does not publish http:\/\/127\.0\.0\.1:8137/);
  });

  it('ignores a handler that proxies the Codor endpoint below the root path', () => {
    const status = [
      'https://host.tail-xyz.ts.net:10443 (tailnet only)',
      '|-- /codor proxy http://127.0.0.1:8137',
      '',
      'https://host.tail-xyz.ts.net (tailnet only)',
      '|-- / proxy http://127.0.0.1:8137',
    ].join('\n');
    const origin = configureTailscaleServe('/usr/bin/tailscale', 'http://127.0.0.1:8137', (_command, args) => {
      if (args.join(' ') === 'status --json') return SELF_STATUS('host.tail-xyz.ts.net.');
      if (args.join(' ') === 'serve status') return status;
      return '';
    });
    expect(origin).toBe('https://host.tail-xyz.ts.net');
  });

  it('does not attach an HTTP handler to the HTTPS origin printed before it', () => {
    const status = [
      'https://host.tail-xyz.ts.net (tailnet only)',
      '|-- / proxy http://127.0.0.1:9999',
      '',
      'http://host.tail-xyz.ts.net (tailnet only)',
      '|-- / proxy http://127.0.0.1:8137',
    ].join('\n');
    expect(() => configureTailscaleServe('/usr/bin/tailscale', 'http://127.0.0.1:8137', (_command, args) => {
      if (args.join(' ') === 'status --json') return SELF_STATUS('host.tail-xyz.ts.net.');
      if (args.join(' ') === 'serve status') return status;
      return '';
    })).toThrow(/does not publish http:\/\/127\.0\.0\.1:8137/);
  });

  it('fails clearly when the current device name is unreadable', () => {
    expect(() => configureTailscaleServe('/usr/bin/tailscale', 'http://127.0.0.1:8137', (_command, args) => {
      if (args.join(' ') === 'status --json') return 'not json';
      return 'https://host.tail-abc.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:8137';
    })).toThrow(/could not read the current device name/);
  });

  it('labels a status --json failure as a status failure, not a Serve failure', () => {
    expect(() => configureTailscaleServe('/usr/bin/tailscale', 'http://127.0.0.1:8137', (_command, args) => {
      if (args.join(' ') === 'status --json') throw new Error('tailscale status: not running');
      return '';
    })).toThrow(/Tailscale status command failed: tailscale status: not running/);
  });

  it('throws a distinct "Serve command failed" diagnostic when the serve command fails', () => {
    expect(() => configureTailscaleServe('/usr/bin/tailscale', 'http://127.0.0.1:8137', (_command, args) => {
      if (args[0] === 'serve' && args[1] === '--bg') throw new Error('serve: not logged in\nrun tailscale up');
      return '';
    })).toThrow(/Serve command failed: serve: not logged in/);
  });

  it('preserves the full multiline diagnostic, including a later actionable stderr line', () => {
    // The actionable guidance is on a later stderr line, not the first message line.
    const error = Object.assign(new Error('serve: access denied'), {
      stderr: 'enable Tailscale Serve for your tailnet in the admin console, then retry',
    });
    expect(() => configureTailscaleServe('/usr/bin/tailscale', 'http://127.0.0.1:8137', (_command, args) => {
      if (args[0] === 'serve' && args[1] === '--bg') throw error;
      return '';
    })).toThrow(/enable Tailscale Serve for your tailnet in the admin console/);
  });

  it('does not duplicate stderr when Node already embedded it in the command message', () => {
    const stderr = [
      'sending serve config: Access denied: serve config denied',
      '',
      "Use 'sudo tailscale serve --bg http://127.0.0.1:8137'.",
      "To not require root, use 'sudo tailscale set --operator=$USER' once.",
    ].join('\n');
    const error = Object.assign(new Error([
      'Command failed: /usr/bin/tailscale serve --bg http://127.0.0.1:8137',
      stderr,
    ].join('\n')), { stderr });
    let message = '';
    try {
      configureTailscaleServe('/usr/bin/tailscale', 'http://127.0.0.1:8137', (_command, args) => {
        if (args[0] === 'serve' && args[1] === '--bg') throw error;
        return '';
      });
    } catch (caught) {
      message = caught instanceof Error ? caught.message : String(caught);
    }
    expect(message.match(/sending serve config: Access denied: serve config denied/g)).toHaveLength(1);
    expect(message.match(/To not require root/g)).toHaveLength(1);
  });

  it('wraps a serve status command failure as the Serve-command-failed category', () => {
    expect(() => configureTailscaleServe('/usr/bin/tailscale', 'http://127.0.0.1:8137', (_command, args) => {
      if (args.join(' ') === 'status --json') return SELF_STATUS('host.tail-abc.ts.net.');
      if (args.join(' ') === 'serve status') throw new Error('serve status: connection refused');
      return '';
    })).toThrow(/Serve command failed: serve status: connection refused/);
  });

  it('throws when serve status reports no HTTPS origin', () => {
    expect(() => configureTailscaleServe('/usr/bin/tailscale', 'http://127.0.0.1:8137', (_command, args) => {
      if (args.join(' ') === 'status --json') return SELF_STATUS('host.tail-abc.ts.net.');
      return 'no serve config';
    })).toThrow(/did not report a private HTTPS origin/);
  });

  // harn:assume setup-bounds-tailscale-serve-consent-and-keeps-diagnostics-actionable ref=tailscale-serve-consent-regression
  it('includes stdout in the diagnostic when serve --bg times out waiting for consent', () => {
    // A tailnet with no HTTPS certificates enabled makes `serve --bg` block on an
    // interactive consent prompt instead of failing; Tailscale prints that prompt,
    // including the consent URL, to stdout rather than stderr.
    const error = Object.assign(new Error('Command failed: /usr/bin/tailscale serve --bg http://127.0.0.1:8137'), {
      stdout: 'To enable HTTPS Certificates for your tailnet, visit:\nhttps://login.tailscale.com/f/https',
      killed: true,
      signal: 'SIGTERM',
    });
    expect(() => configureTailscaleServe('/usr/bin/tailscale', 'http://127.0.0.1:8137', (_command, args) => {
      if (args[0] === 'serve' && args[1] === '--bg') throw error;
      return '';
    })).toThrow(/https:\/\/login\.tailscale\.com\/f\/https/);
  });

  it('bounds the serve --bg call with a timeout but leaves later reads unbounded', () => {
    const calls: Array<{ args: string[]; options: { timeoutMs?: number } | undefined }> = [];
    configureTailscaleServe('/usr/bin/tailscale', 'http://127.0.0.1:8137', (_command, args, options) => {
      calls.push({ args, options });
      if (args.join(' ') === 'status --json') return SELF_STATUS('host.tail-abc.ts.net.');
      if (args.join(' ') === 'serve status') {
        return 'https://host.tail-abc.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:8137';
      }
      return '';
    });
    expect(calls[0]).toEqual({ args: ['serve', '--bg', 'http://127.0.0.1:8137'], options: { timeoutMs: 20_000 } });
    expect(calls[1]).toEqual({ args: ['status', '--json'], options: undefined });
    expect(calls[2]).toEqual({ args: ['serve', 'status'], options: undefined });
  });
  // harn:end setup-bounds-tailscale-serve-consent-and-keeps-diagnostics-actionable
});
