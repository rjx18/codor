import { useEffect, useState } from 'react';

import {
  EXTENDED_THRESHOLD_MS,
  SESSION_COPY,
  classifySession,
} from '../app/connection-state.js';
import { useNavigatorOnLine } from '../app/use-navigator-online.js';

const graceMs = (): number =>
  (typeof window !== 'undefined' && window.__CODOR_RECOVERY_GRACE_MS) || 6_000;
const extendedMs = (): number =>
  (typeof window !== 'undefined' && window.__CODOR_RECOVERY_EXTENDED_MS) || EXTENDED_THRESHOLD_MS;

/**
 * The bootstrap is running — resolving access and loading the channel list, which over
 * the blind relay can take a keepalive cycle while a stale host reconnects. This is the
 * LIVE "still trying" surface: it ticks from mount and classifies with the same honest
 * classifier the mid-session overlay uses, but from the bootstrap's own signals —
 * `navigator.onLine` + time-since-boot, with `connected:false` and `authRefused:false`
 * (there is no connector at boot, and absence/timeout NEVER declares a pairing dead;
 * a positive refusal can only be known once the bootstrap resolves, in main.tsx).
 *
 * Within the grace it shows the neutral "Connecting" copy so a normal fast boot never
 * flashes alarm; past the grace it escalates to the classified state's copy
 * (device-offline immediately, agent-offline → agent-offline-extended by time). It has
 * no terminal Retry/Re-pair — the bootstrap is actively resolving; the terminal card
 * with actions is rendered by main.tsx once the attempt fails.
 */
export function StartupConnecting() {
  const online = useNavigatorOnLine();
  const [downMs, setDownMs] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setDownMs(Date.now() - start), 1_000);
    return () => clearInterval(id);
  }, []);

  const state = classifySession({
    connected: false,
    navigatorOnLine: online,
    authRefused: false,
    downMs,
    extendedThresholdMs: extendedMs(),
  });
  // Hold the neutral connecting copy through the grace for the ambiguous agent-absent
  // case; device-offline is unambiguous and shows at once.
  const escalated = state !== 'online' && !(state === 'agent-offline' && downMs < graceMs());
  const copy = escalated
    ? SESSION_COPY[state]
    : {
        title: 'Reaching your channels…',
        body: 'Restoring the secure connection to your Codor and loading your channels. This can take a moment if the host is reconnecting.',
      };

  return (
    <main className="nx-upgrade" data-testid="startup-connecting" data-connecting-state={escalated ? state : 'connecting'}>
      <section className="nx-upgrade-card" aria-labelledby="startup-connecting-title" aria-busy="true">
        <p className="nx-eyebrow">{state === 'device-offline' ? 'Offline' : 'Connecting'}</p>
        <h1 id="startup-connecting-title">{copy.title}</h1>
        <p role="status">{copy.body}</p>
      </section>
    </main>
  );
}
