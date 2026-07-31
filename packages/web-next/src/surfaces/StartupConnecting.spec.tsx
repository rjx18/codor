// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import { StartupConnecting } from './StartupConnecting.js';

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });
}
afterEach(() => setOnline(true));

// Initial render only (no effects under renderToStaticMarkup → downMs stays 0): this
// pins the two honest-state properties that matter at t=0. The timed escalation to
// agent-offline / -extended is covered by the room35 boot e2e.
describe('StartupConnecting boot honest-state', () => {
  it('shows the neutral connecting copy on a fresh online boot — never flashes an alarm', () => {
    setOnline(true);
    const html = renderToStaticMarkup(<StartupConnecting />);
    expect(html).toContain('Reaching your channels');
    expect(html).toContain('data-connecting-state="connecting"');
    expect(html).not.toContain('agent'); // no "agent looks offline" within the grace
  });

  it('shows device-offline immediately when the device network is down', () => {
    setOnline(false);
    const html = renderToStaticMarkup(<StartupConnecting />);
    expect(html).toContain('You appear to be offline');
    expect(html).toContain('data-connecting-state="device-offline"');
  });
});
