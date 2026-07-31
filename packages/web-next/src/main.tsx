import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { applyThemeChoice } from '@runtime/theme.js';
import { hasStoredBrowserAccess } from '@runtime/crypto.js';

import { pageParams, resolveAccessToken } from './app/session.js';
import { initRelayMode, relayActive } from '@runtime/relay-mode.js';
import {
  forgetRoom,
  rememberedRoom,
  rememberRoom,
  resolveAuthorizedRooms,
  resolveStartupRoom,
} from './app/startup.js';
import { checkBrowserCompatibility, CompatibilityGate } from './app/compatibility.js';
import { StartupConnecting } from './surfaces/StartupConnecting.js';
import { RecoveryCard } from './surfaces/RecoveryCard.js';
import { RoomPage } from './room/RoomPage.js';
import './styles/tokens.css';
import './styles/base.css';
import './styles/primitives.css';
import './styles/room.css';
import './styles/landing.css';
import './styles/onboarding.css';

applyThemeChoice();

const root = document.querySelector('#root');
if (!root) throw new Error('missing #root element');
const rootElement = root;


/** Bootstrap canonicalizes in place, keeping the pathname it was launched on,
 *  so Back never returns to a URL this launch invented. Operator switching
 *  still pushes history. */
function canonicalizeRoom(path: string, room: string): void {
  const canonical = new URL(window.location.href);
  if (canonical.searchParams.get('room') === room) return;
  canonical.searchParams.set('room', room);
  window.history.replaceState(null, '', `${path}${canonical.search}${canonical.hash}`);
}

async function surfaceFor(path: string, room: string, token: string) {
  const { RecoveryOverlay } = await import('./surfaces/RecoveryOverlay.js');
  // Wrap ONLY the surfaces that own a live connector (RoomPage, SettingsPage) —
  // LedgerPage is REST-only with no session, so the recovery state can't apply,
  // and landing/pairing/no-channels are their own terminal screens.
  if (path === '/settings') {
    const { SettingsPage } = await import('./surfaces/SettingsPage.js');
    return <RecoveryOverlay><SettingsPage room={room} token={token} refreshToken={resolveAccessToken} /></RecoveryOverlay>;
  }
  if (path === '/ledger') {
    const { LedgerPage } = await import('./surfaces/LedgerPage.js');
    return <LedgerPage room={room} token={token} />;
  }
  return (
    <RecoveryOverlay>
      <RoomPage
        room={room}
        token={token}
        refreshToken={resolveAccessToken}
        home={path === '/channels'}
      />
    </RecoveryOverlay>
  );
}

/**
 * Terminal boot-failure recovery state: `device-offline` if the device's own network is
 * down (never blame the pairing), else host-absent `agent-offline-extended` — which
 * offers re-pair in relay mode. The iron rule keeps `pairing-dead` OUT of boot: it needs
 * positive refusal evidence, which §4.3's KK silent-ignore denies at the tunnel layer.
 * (Ledgered: surfacing an app-level 403 as positive boot evidence.)
 */
const bootRecoveryState = (): 'agent-offline-extended' | 'device-offline' =>
  typeof navigator !== 'undefined' && !navigator.onLine ? 'device-offline' : 'agent-offline-extended';

async function render(): Promise<void> {
  // Paint a visible connecting state immediately so the root is never blank
  // during the bootstrap — the relay path can await a full keepalive cycle while
  // a stale host reconnects, and deferring the whole React render left a paired
  // browser staring at nothing for minutes.
  const reactRoot = createRoot(rootElement);
  reactRoot.render(<StrictMode><StartupConnecting /></StrictMode>);
  await initRelayMode(); // relay-paired browsers route transport through the tunnel
  const token = await resolveAccessToken();
  if (token !== '') await checkBrowserCompatibility(token);
  const path = window.location.pathname;
  const returnTo = `${path}${window.location.search}${window.location.hash}`;
  const page = await (async () => {
    if (path === '/pair') {
      const { PairingPage } = await import('./surfaces/PairingPage.js');
      return <PairingPage />;
    }
    if (token === '') {
      // A paired browser whose token resolution failed must NOT be shown the "never
      // paired" landing — that is the exact false-negative this phase kills. Relay
      // (tunnel built) short-circuits first; a DIRECT/operator pairing is detected by
      // a persisted access record for this origin (pure storage, no network). Render
      // the recovery card (host-absent by default; pairing-dead stays out without
      // positive evidence). Genuinely-unpaired browsers (no pairing at all) keep
      // Landing / auto-pair unchanged.
      if (relayActive() || await hasStoredBrowserAccess(window.location.origin)) {
        return <RecoveryCard presentation="fullscreen" state={bootRecoveryState()} />;
      }
      if (path === '/') {
        const { LandingPage } = await import('./surfaces/LandingPage.js');
        return <LandingPage />;
      }
      const { PairingPage } = await import('./surfaces/PairingPage.js');
      return <PairingPage autoPair returnTo={returnTo} />;
    }
    // Resolve a REAL room ONCE, before any authenticated surface exists. All
    // three build a connector or request a room-scoped endpoint, so returning
    // any of them early meant Settings opened `room: ""` and Ledger requested
    // /api/rooms//ledger — the same phantom-room class as `default`.
    const explicit = pageParams().room;
    // One bounded attempt, then the extended relay-only retry (a relay host can
    // take up to a keepalive cycle to notice a stale link and reconnect). The
    // direct path keeps its fast-fail, so an offline direct switchboard shows the
    // unavailable screen at once instead of a blank root for minutes.
    const authorized = await resolveAuthorizedRooms(token, {
      relayMode: relayActive(),
      explicit,
      remembered: rememberedRoom(),
    });

    // A failed lookup is UNKNOWN state, not an authorized empty set. Offline is
    // the installed shell's whole point, so fall back to what this device
    // already knows; with nothing known, say the startup is unavailable and
    // offer a retry rather than claiming the account has no channels.
    if (authorized === undefined) {
      const offlineRoom = explicit ?? rememberedRoom();
      if (offlineRoom === undefined) {
        // Paired, but the channel list couldn't load and there's no room to fall back
        // to. Render the same recovery card (with Retry + relay-mode Re-pair) instead
        // of the terse StartupUnavailable — one honest screen for every boot failure.
        return <RecoveryCard presentation="fullscreen" state={bootRecoveryState()} />;
      }
      rememberRoom(offlineRoom);
      if (path !== '/channels') canonicalizeRoom(path, offlineRoom);
      return surfaceFor(path, offlineRoom, token);
    }

    const startup = resolveStartupRoom(authorized, { explicit, remembered: rememberedRoom() });
    if (startup === undefined) {
      // A successful, genuinely empty authorization: say so, open nothing.
      if (rememberedRoom() !== undefined) forgetRoom();
      const { NoChannels } = await import('./surfaces/NoChannels.js');
      return <NoChannels token={token} />;
    }
    // A stale or invalid remembered id is discarded rather than carried.
    const remembered = rememberedRoom();
    if (remembered !== undefined && !authorized.some((room) => room.id === remembered)) {
      forgetRoom();
    }
    rememberRoom(startup);
    if (path !== '/channels') canonicalizeRoom(path, startup);
    return surfaceFor(path, startup, token);
  })();
  reactRoot.render(
    <StrictMode><CompatibilityGate>{page}</CompatibilityGate></StrictMode>,
  );
}

// The cache-buster has already done its navigation job by the time this bundle
// runs. Keep copied links and later reloads clean.
const loadedUrl = new URL(window.location.href);
if (loadedUrl.searchParams.has('_codor_update')) {
  loadedUrl.searchParams.delete('_codor_update');
  window.history.replaceState(null, '', `${loadedUrl.pathname}${loadedUrl.search}${loadedUrl.hash}`);
}

void render();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js', { scope: '/', type: 'module', updateViaCache: 'none' })
      .catch(() => undefined);
  });
}
