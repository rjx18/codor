import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BROWSER_PROTOCOL_EPOCH } from '@codor/protocol';

import {
  checkBrowserCompatibility,
  clearBrowserUpgradeForTest,
  CompatibilityGate,
  refreshBrowserApp,
  requireBrowserUpgrade,
} from './compatibility.js';

afterEach(() => {
  clearBrowserUpgradeForTest();
  vi.unstubAllGlobals();
});

describe('browser compatibility gate', () => {
  it('leaves the app untouched until an authoritative incompatibility arrives', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"not found"}', { status: 404 })));
    await checkBrowserCompatibility('token');
    expect(renderToStaticMarkup(
      <CompatibilityGate><div data-testid="room">room</div></CompatibilityGate>,
    )).toContain('data-testid="room"');
  });

  it('turns REST 426 into the same full-screen refresh surface as the socket frame', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      browser_protocol: BROWSER_PROTOCOL_EPOCH,
      minimum_browser_protocol: BROWSER_PROTOCOL_EPOCH + 1,
    }), { status: 426, headers: { 'content-type': 'application/json' } })));
    await checkBrowserCompatibility('token');
    let markup = renderToStaticMarkup(
      <CompatibilityGate><div>room must not render</div></CompatibilityGate>,
    );
    expect(markup).toContain('data-testid="upgrade-required"');
    expect(markup).toContain('Codor has been updated');
    expect(markup).not.toContain('room must not render');

    clearBrowserUpgradeForTest();
    requireBrowserUpgrade({
      type: 'upgrade_required',
      current_browser_protocol: BROWSER_PROTOCOL_EPOCH,
      minimum_browser_protocol: BROWSER_PROTOCOL_EPOCH + 2,
    });
    markup = renderToStaticMarkup(
      <CompatibilityGate><div>socket room must not render</div></CompatibilityGate>,
    );
    expect(markup).toContain(`server requires ${String(BROWSER_PROTOCOL_EPOCH + 2)}`);
    expect(markup).not.toContain('socket room must not render');
  });

  describe('service worker refresh', () => {
    const stubEnvironment = (registration: unknown) => {
      const listeners = new Map<string, () => void>();
      const cleared: number[] = [];
      let timerSeq = 0;
      vi.stubGlobal('navigator', {
        serviceWorker: {
          getRegistration: async () => await Promise.resolve(registration),
          addEventListener: (type: string, handler: () => void) => listeners.set(type, handler),
          removeEventListener: (type: string) => listeners.delete(type),
        },
      });
      const replaced: string[] = [];
      vi.stubGlobal('window', {
        location: { href: 'https://codor.test/?room=eng', replace: (url: string) => replaced.push(url) },
        setTimeout: () => { timerSeq += 1; return timerSeq; },
        clearTimeout: (id: number) => cleared.push(id),
      });
      return { listeners, cleared, replaced };
    };

    it('releases its listener and timer when the controller changes first', async () => {
      // The timeout is a floor, not the expected path. Leaving it armed after a
      // controllerchange kept a callback alive against a screen already
      // navigating away — bounded cleanup means whichever wins takes both.
      const env = stubEnvironment({ update: async () => await Promise.resolve() });
      const refreshing = refreshBrowserApp();
      await Promise.resolve();
      await Promise.resolve();
      env.listeners.get('controllerchange')?.();
      await refreshing;

      expect(env.listeners.has('controllerchange')).toBe(false); // listener released
      expect(env.cleared).toHaveLength(1); // and the timer with it
      expect(env.replaced).toHaveLength(1);
      expect(env.replaced[0]).toContain('_codor_update=');
    });

    it('rejects when the refresh cannot proceed, so the button can come back', async () => {
      // The gate restores an actionable Refresh on rejection. That only works if
      // a genuine failure propagates instead of resolving into a dead screen.
      stubEnvironment(undefined);
      vi.stubGlobal('navigator', {
        serviceWorker: {
          getRegistration: async () => { await Promise.resolve(); throw new Error('registration unavailable'); },
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        },
      });
      await expect(refreshBrowserApp()).rejects.toThrow(/registration unavailable/);
    });
  });
});
