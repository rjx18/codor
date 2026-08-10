import { StrictMode, useEffect, useSyncExternalStore } from 'react';
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
import { RecoveryOverlay } from './surfaces/RecoveryOverlay.js';
import { SettingsPage } from './surfaces/SettingsPage.js';
import { LedgerPage } from './surfaces/LedgerPage.js';
import { NoChannels } from './surfaces/NoChannels.js';
import { RoomPage } from './room/RoomPage.js';
import { computerSessions } from './app/computer-sessions.js';
import { primeRoomSummaries } from './app/summary.js';
import { useClientStore } from './app/store.js';
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

function surfaceFor(path: string, room: string, token: string) {
  // Wrap ONLY the surfaces that own a live connector (RoomPage, SettingsPage) —
  // LedgerPage is REST-only with no session, so the recovery state can't apply,
  // and landing/pairing/no-channels are their own terminal screens.
  if (path === '/settings') {
    const managed = computerSessions()?.active();
    return (
      <RecoveryOverlay>
        <SettingsPage
          room={managed?.room ?? room}
          token={managed?.token ?? token}
          refreshToken={resolveAccessToken}
          connection={managed?.connector}
        />
      </RecoveryOverlay>
    );
  }
  if (path === '/ledger') {
    return <LedgerPage room={room} token={token} />;
  }
  return <RecoveryOverlay><RoomPage room={room} token={token} refreshToken={resolveAccessToken} /></RecoveryOverlay>;
}

// harn:assume hosted-managed-bootstrap-reacts-to-late-readiness ref=reactive-managed-bootstrap
function ManagedBootstrap({ path }: { path: string }) {
  const manager = computerSessions()!;
  useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  const session = path === '/ledger' || path === '/settings'
    ? manager.active()
    : manager.renderableActive();
  useEffect(() => {
    if (session) canonicalizeRoom(path, session.room);
  }, [path, session]);
  if (session) {
    // The mounted rail reads the same manager-owned cold summaries. Prime the
    // legacy direct hook so it never issues a second hosted summary request;
    // live addressed support remains the fresher authority after mount.
    primeRoomSummaries(useClientStore.getState().roomSummaries);
    return <CompatibilityGate>{surfaceFor(path, session.room, session.token)}</CompatibilityGate>;
  }
  if (manager.activeHasNoRooms()) return <NoChannels token={manager.activeToken()} />;
  return (
    <RecoveryCard
      presentation="fullscreen"
      state={bootRecoveryState()}
      onComputerSwitch={async () => undefined}
    />
  );
}
// harn:end hosted-managed-bootstrap-reacts-to-late-readiness

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
  const managedSessions = computerSessions();
  const path = window.location.pathname;
  const returnTo = `${path}${window.location.search}${window.location.hash}`;
  if (managedSessions !== undefined && path !== '/pair') {
    reactRoot.render(<StrictMode><ManagedBootstrap path={path} /></StrictMode>);
    return;
  }
  const token = await resolveAccessToken();
  if (token !== '') await checkBrowserCompatibility(token);
  const openWarmComputer = async (): Promise<void> => {
    const active = computerSessions()?.active();
    if (!active) return;
    await checkBrowserCompatibility(active.token);
    canonicalizeRoom(path, active.room);
    const recovered = surfaceFor(path, active.room, active.token);
    reactRoot.render(<StrictMode><CompatibilityGate>{recovered}</CompatibilityGate></StrictMode>);
  };
  const managedColdSurfaceNotReady = (): boolean =>
    managedSessions !== undefined
    && managedSessions.active() === undefined
    && (path === '/' || path === '/settings');
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
        return <RecoveryCard presentation="fullscreen" state={bootRecoveryState()} onComputerSwitch={openWarmComputer} />;
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
      multipleComputers: (managedSessions?.getSnapshot().computers.length ?? 0) > 1,
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
        return <RecoveryCard presentation="fullscreen" state={bootRecoveryState()} onComputerSwitch={openWarmComputer} />;
      }
      if (managedColdSurfaceNotReady()) {
        return <RecoveryCard presentation="fullscreen" state={bootRecoveryState()} onComputerSwitch={openWarmComputer} />;
      }
      rememberRoom(offlineRoom);
      canonicalizeRoom(path, offlineRoom);
      return surfaceFor(path, offlineRoom, token);
    }

    const startup = resolveStartupRoom(authorized, { explicit, remembered: rememberedRoom() });
    if (startup === undefined) {
      // A successful, genuinely empty authorization: say so, open nothing.
      if (rememberedRoom() !== undefined) forgetRoom();
      return <NoChannels token={token} />;
    }
    // A managed token can arrive before its room-list retry has produced the
    // connector. Never let cold Room or Settings own a second connector (or
    // throw); the subscribed recovery card exposes any already-warm alternative.
    if (managedColdSurfaceNotReady()) {
      return <RecoveryCard presentation="fullscreen" state={bootRecoveryState()} onComputerSwitch={openWarmComputer} />;
    }
    // A stale or invalid remembered id is discarded rather than carried.
    const remembered = rememberedRoom();
    if (remembered !== undefined && !authorized.some((room) => room.id === remembered)) {
      forgetRoom();
    }
    rememberRoom(startup);
    canonicalizeRoom(path, startup);
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
