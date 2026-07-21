import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { applyThemeChoice } from '@runtime/theme.js';

import { pageParams, resolveAccessToken } from './app/session.js';
import {
  fetchAuthorizedRooms,
  forgetRoom,
  rememberedRoom,
  rememberRoom,
  resolveStartupRoom,
} from './app/startup.js';
import { checkBrowserCompatibility, CompatibilityGate } from './app/compatibility.js';
import { RoomPage } from './room/RoomPage.js';
import './styles/tokens.css';
import './styles/base.css';
import './styles/primitives.css';
import './styles/room.css';
import './styles/landing.css';

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
  if (path === '/settings') {
    const { SettingsPage } = await import('./surfaces/SettingsPage.js');
    return <SettingsPage room={room} token={token} refreshToken={resolveAccessToken} />;
  }
  if (path === '/ledger') {
    const { LedgerPage } = await import('./surfaces/LedgerPage.js');
    return <LedgerPage room={room} token={token} />;
  }
  return <RoomPage room={room} token={token} refreshToken={resolveAccessToken} />;
}

async function render(): Promise<void> {
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
    const authorized = await fetchAuthorizedRooms(token).catch(() => undefined);

    // A failed lookup is UNKNOWN state, not an authorized empty set. Offline is
    // the installed shell's whole point, so fall back to what this device
    // already knows; with nothing known, say the startup is unavailable and
    // offer a retry rather than claiming the account has no channels.
    if (authorized === undefined) {
      const offlineRoom = explicit ?? rememberedRoom();
      if (offlineRoom === undefined) {
        const { StartupUnavailable } = await import('./surfaces/StartupUnavailable.js');
        return <StartupUnavailable />;
      }
      rememberRoom(offlineRoom);
      canonicalizeRoom(path, offlineRoom);
      return surfaceFor(path, offlineRoom, token);
    }

    const startup = resolveStartupRoom(authorized, { explicit, remembered: rememberedRoom() });
    if (startup === undefined) {
      // A successful, genuinely empty authorization: say so, open nothing.
      if (rememberedRoom() !== undefined) forgetRoom();
      const { NoChannels } = await import('./surfaces/NoChannels.js');
      return <NoChannels />;
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
  createRoot(rootElement).render(
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
