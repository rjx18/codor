import { describe, expect, it } from 'vitest';

import { runRemoteAccess } from './setup.js';

// harn:assume setup-defers-remote-access-behind-consent ref=setup-remote-access-regression
describe('runRemoteAccess', () => {
  const base = (over: Partial<Parameters<typeof runRemoteAccess>[0]> = {}): Parameters<typeof runRemoteAccess>[0] => ({
    choice: 'remote',
    localEndpoint: 'http://127.0.0.1:8137',
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

  it('degrades to local with the exact copyable command when Serve fails', async () => {
    const logs: string[] = [];
    const result = await runRemoteAccess(base({
      choose: async () => 'configure',
      log: (message) => logs.push(message),
      configureServe: () => { throw new Error('serve: not logged in'); },
    }));
    expect(result).toEqual({ access: 'localhost', endpoint: 'http://127.0.0.1:8137', summary: 'This computer (remote access deferred)' });
    expect(logs.some((line) => line.includes('/usr/bin/tailscale serve --bg http://127.0.0.1:8137'))).toBe(true);
    expect(logs.some((line) => line.includes('serve: not logged in'))).toBe(true);
    expect(logs.join('\n')).not.toMatch(/\bsudo\b/);
  });

  it('offers retry then continue-local when Tailscale is missing', async () => {
    const answers = ['retry', 'here'];
    let resets = 0;
    let detectCount = 0;
    const result = await runRemoteAccess(base({
      detect: () => { detectCount += 1; return { path: undefined, serve: false }; },
      resetDetect: () => { resets += 1; },
      choose: async () => answers.shift()!,
    }));
    expect(detectCount).toBe(2);
    expect(resets).toBe(1);
    expect(result.access).toBe('localhost');
  });
});
// harn:end setup-defers-remote-access-behind-consent
