import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BROWSER_PROTOCOL_EPOCH } from '@codor/protocol';

import {
  checkBrowserCompatibility,
  clearBrowserUpgradeForTest,
  CompatibilityGate,
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
});
