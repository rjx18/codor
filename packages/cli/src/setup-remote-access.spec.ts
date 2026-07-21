import { describe, expect, it } from 'vitest';

import { runRemoteAccess } from './setup.js';

type Menu = { message: string; options: Array<{ id: string }> };

/** A choose that returns scripted answers in order and records the menus shown. */
function scripted(answers: string[], shown: Menu[] = []): (menu: Menu) => Promise<string> {
  const queue = [...answers];
  return async (menu: Menu): Promise<string> => {
    shown.push(menu);
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected extra prompt: ${menu.message}`);
    return next;
  };
}

// harn:assume setup-recovers-remote-access-with-one-clear-decision ref=setup-remote-access-regression
describe('runRemoteAccess', () => {
  const base = (over: Partial<Parameters<typeof runRemoteAccess>[0]> = {}): Parameters<typeof runRemoteAccess>[0] => ({
    choice: 'remote',
    localEndpoint: 'http://127.0.0.1:8137',
    platform: 'linux',
    log: () => undefined,
    choose: async () => 'here',
    detect: () => ({ path: '/usr/bin/tailscale', serve: true }),
    resetDetect: () => undefined,
    configureServe: () => 'https://host.tail-abc.ts.net',
    ...over,
  });

  it('never inspects Tailscale when the operator stays on this computer', async () => {
    let detected = false;
    const result = await runRemoteAccess(base({ choice: 'here', detect: () => { detected = true; return { path: undefined, serve: false }; } }));
    expect(detected).toBe(false);
    expect(result).toEqual({ access: 'localhost', endpoint: 'http://127.0.0.1:8137', summary: 'This computer' });
  });

  it('configures Serve only after a separate consent and returns the tailnet origin', async () => {
    const configured: string[] = [];
    const result = await runRemoteAccess(base({ choose: async () => 'configure', configureServe: (path) => { configured.push(path); return 'https://host.tail-abc.ts.net'; } }));
    expect(configured).toEqual(['/usr/bin/tailscale']);
    expect(result).toEqual({ access: 'tailscale', endpoint: 'https://host.tail-abc.ts.net', summary: 'Tailscale Serve' });
  });

  it('does not configure Serve when the operator declines the consent', async () => {
    let configured = false;
    const result = await runRemoteAccess(base({ choose: async () => 'here', configureServe: () => { configured = true; return 'x'; } }));
    expect(configured).toBe(false);
    expect(result.access).toBe('localhost');
  });

  it('offers retry then continue-local when Tailscale is missing', async () => {
    let resets = 0;
    let detectCount = 0;
    const result = await runRemoteAccess(base({
      detect: () => { detectCount += 1; return { path: undefined, serve: false }; },
      resetDetect: () => { resets += 1; },
      choose: scripted(['retry', 'here']),
    }));
    expect(detectCount).toBe(2);
    expect(resets).toBe(1);
    expect(result.access).toBe('localhost');
  });

  it('keeps a Serve failure onscreen and treats Continue as the single local decision', async () => {
    const shown: Menu[] = [];
    let attempts = 0;
    const result = await runRemoteAccess(base({
      configureServe: () => { attempts += 1; throw new Error('serve: not logged in'); },
      choose: scripted(['configure', 'here'], shown),
    }));
    // Serve was attempted once — it did not silently degrade or loop by itself.
    expect(attempts).toBe(1);
    // The failure screen carried the real error and the exact resolved serve command.
    const failureScreen = shown[1]!.message;
    expect(failureScreen).toContain('serve: not logged in');
    expect(failureScreen).toContain('/usr/bin/tailscale serve --bg http://127.0.0.1:8137');
    // Continue itself is the decision; setup does not ask the same question again.
    expect(shown).toHaveLength(2);
    expect(result).toEqual({ access: 'localhost', endpoint: 'http://127.0.0.1:8137', summary: 'This computer (remote access deferred)' });
  });

  it('classifies Richard\'s Linux permission error into one clear, deduplicated recovery path', async () => {
    const shown: Menu[] = [];
    const detail = [
      'Tailscale Serve command failed: Command failed: /usr/bin/tailscale serve --bg http://127.0.0.1:8137',
      'sending serve config: Access denied: serve config denied',
      '',
      "Use 'sudo tailscale serve --bg http://127.0.0.1:8137'.",
      "To not require root, use 'sudo tailscale set --operator=$USER' once.",
    ].join('\n');
    const result = await runRemoteAccess(base({
      configureServe: () => { throw new Error(detail); },
      choose: scripted(['configure', 'here'], shown),
    }));
    const failureScreen = shown[1]!.message;
    expect(failureScreen).toContain('Tailscale needs permission to configure Serve.');
    expect(failureScreen).toContain('sudo tailscale set --operator=$USER');
    expect(failureScreen).toContain('/usr/bin/tailscale serve --bg http://127.0.0.1:8137');
    expect(failureScreen).not.toContain("Use 'sudo tailscale serve");
    expect(failureScreen.match(/sending serve config: Access denied: serve config denied/g)).toHaveLength(1);
    expect(failureScreen.match(/sudo tailscale set --operator=\$USER/g)).toHaveLength(1);
    // The wizard waited on the operator's choice rather than degrading on its own.
    expect(shown[1]!.options.map((option) => option.id)).toEqual(['retry', 'here']);
    expect(result.access).toBe('localhost');
  });

  it('retries Serve after a simulated operator fix and succeeds', async () => {
    let attempts = 0;
    const logs: string[] = [];
    const result = await runRemoteAccess(base({
      configureServe: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('access denied; operator permission required');
        return 'https://host.tail-abc.ts.net';
      },
      log: (message) => logs.push(message),
      choose: scripted(['configure', 'retry']),
    }));
    expect(attempts).toBe(2);
    expect(logs).toContain('configuring Tailscale Serve');
    expect(logs).toContain('retrying Tailscale Serve');
    expect(result).toEqual({ access: 'tailscale', endpoint: 'https://host.tail-abc.ts.net', summary: 'Tailscale Serve' });
  });

  it('does not claim a sudo fix for an unrelated Serve error', async () => {
    const shown: Menu[] = [];
    const logs: string[] = [];
    await runRemoteAccess(base({
      configureServe: () => { throw new Error('Tailscale Serve did not report a private HTTPS origin'); },
      log: (message) => logs.push(message),
      choose: scripted(['configure', 'here'], shown),
    }));
    const failureScreen = shown[1]!.message;
    expect(failureScreen).toContain('Tailscale Serve did not report a private HTTPS origin');
    expect(failureScreen).toContain('/usr/bin/tailscale serve --bg http://127.0.0.1:8137');
    expect(failureScreen).not.toMatch(/\bsudo\b/);
    expect(failureScreen).not.toContain('operator');
    expect(logs.join('\n')).not.toMatch(/\bsudo\b/);
  });

  it('does not show the operator recovery on macOS', async () => {
    const shown: Menu[] = [];
    await runRemoteAccess(base({
      platform: 'darwin',
      configureServe: () => { throw new Error('access denied; operator permission required'); },
      choose: scripted(['configure', 'here'], shown),
    }));
    expect(shown[1]!.message).not.toMatch(/\bsudo\b/);
  });
});
// harn:end setup-recovers-remote-access-with-one-clear-decision
