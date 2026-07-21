import { describe, expect, it } from 'vitest';

import { configureTailscaleServe, resolveTailscale, tailscaleServeSupported } from './setup.js';

const APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

describe('resolveTailscale', () => {
  it('returns the PATH hit when present', () => {
    expect(resolveTailscale(() => '/usr/bin/tailscale', 'darwin', () => true)).toBe('/usr/bin/tailscale');
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
  it('publishes Serve through the resolved absolute path and returns the HTTPS origin', () => {
    const commands: string[] = [];
    const origin = configureTailscaleServe('/usr/bin/tailscale', 'http://127.0.0.1:8137', (command, args) => {
      commands.push([command, ...args].join(' '));
      if (args.join(' ') === 'serve status') return 'https://host.tail-abc.ts.net (tailnet only)';
      return '';
    });
    expect(origin).toBe('https://host.tail-abc.ts.net');
    expect(commands).toEqual([
      '/usr/bin/tailscale serve --bg http://127.0.0.1:8137',
      '/usr/bin/tailscale serve status',
    ]);
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
      if (args.join(' ') === 'serve status') throw new Error('serve status: connection refused');
      return '';
    })).toThrow(/Serve command failed: serve status: connection refused/);
  });

  it('throws when serve status reports no HTTPS origin', () => {
    expect(() => configureTailscaleServe('/usr/bin/tailscale', 'http://127.0.0.1:8137', () => 'no serve config'))
      .toThrow(/did not report a private HTTPS origin/);
  });
});
