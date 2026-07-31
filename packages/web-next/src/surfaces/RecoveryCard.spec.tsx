// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { SESSION_COPY, SESSION_REPAIR_HINT, SESSION_TERMINAL_COPY } from '../app/connection-state.js';

// relayActive drives whether re-pair is offered; mock it so both branches are pinnable.
const relay = vi.hoisted(() => ({ active: false }));
vi.mock('../runtime/relay-mode.js', () => ({ relayActive: () => relay.active }));

const { RecoveryCard } = await import('./RecoveryCard.js');

// The copy is single-sourced but forks by presentation: the overlay keeps the auto-retry
// framing (a connector retries beneath it), the fullscreen boot card points at the manual
// Retry. (renderToStaticMarkup runs no effects, so the device-offline online-reload is
// pinned by the room35 e2e, not here.)
describe('RecoveryCard copy fork by presentation', () => {
  it('overlay renders the auto-retry SESSION_COPY body', () => {
    relay.active = false;
    const html = renderToStaticMarkup(<RecoveryCard state="agent-offline-extended" presentation="overlay" />);
    expect(html).toContain(SESSION_COPY['agent-offline-extended'].body);
    expect(html).not.toContain(SESSION_TERMINAL_COPY['agent-offline-extended'].body);
    expect(html).toContain('nx-recovery-overlay');
  });

  it('fullscreen renders the manual-framing SESSION_TERMINAL_COPY body', () => {
    relay.active = false;
    const html = renderToStaticMarkup(<RecoveryCard state="agent-offline-extended" presentation="fullscreen" />);
    expect(html).toContain(SESSION_TERMINAL_COPY['agent-offline-extended'].body);
    expect(html).not.toContain(SESSION_COPY['agent-offline-extended'].body);
    expect(html).toContain('data-recovery-state="agent-offline-extended"');
    expect(html).toContain('class="nx-upgrade"'); // fullscreen wrapper, not the overlay
  });
});

// The re-pair hint and the re-pair button are driven by the same `offerRepair`, so they
// can never disagree — on any path, in any presentation.
describe('RecoveryCard re-pair hint matches the offered action', () => {
  it('omits the re-pair hint AND button when re-pair is not offered (relay inactive)', () => {
    relay.active = false;
    for (const presentation of ['overlay', 'fullscreen'] as const) {
      const html = renderToStaticMarkup(<RecoveryCard state="agent-offline-extended" presentation={presentation} />);
      expect(html).not.toContain(SESSION_REPAIR_HINT);
      expect(html).not.toContain('recovery-repair');
    }
  });

  it('includes the re-pair hint AND button when re-pair is offered (relay active)', () => {
    relay.active = true;
    for (const presentation of ['overlay', 'fullscreen'] as const) {
      const html = renderToStaticMarkup(<RecoveryCard state="agent-offline-extended" presentation={presentation} />);
      expect(html).toContain(SESSION_REPAIR_HINT);
      expect(html).toContain('recovery-repair');
    }
  });
});
