import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { applyThemeChoice } from '@legacy/theme.js';

import { resolveAccessToken } from './app/session.js';
import { RoomPage } from './room/RoomPage.js';
import './styles/tokens.css';
import './styles/base.css';
import './styles/primitives.css';
import './styles/room.css';

applyThemeChoice();

const root = document.querySelector('#root');
if (!root) throw new Error('missing #root element');
const rootElement = root;

async function render(): Promise<void> {
  const token = await resolveAccessToken();
  const path = window.location.pathname;
  const returnTo = `${path}${window.location.search}${window.location.hash}`;
  const page = await (async () => {
    if (path === '/pair') {
      const { PairingPage } = await import('./surfaces/PairingPage.js');
      return <PairingPage />;
    }
    if (token === '') {
      const { PairingPage } = await import('./surfaces/PairingPage.js');
      return <PairingPage autoPair returnTo={returnTo} />;
    }
    if (path === '/settings') {
      const { SettingsPage } = await import('./surfaces/SettingsPage.js');
      return <SettingsPage token={token} refreshToken={resolveAccessToken} />;
    }
    if (path === '/ledger') {
      const { LedgerPage } = await import('./surfaces/LedgerPage.js');
      return <LedgerPage token={token} />;
    }
    return <RoomPage token={token} refreshToken={resolveAccessToken} />;
  })();
  createRoot(rootElement).render(<StrictMode>{page}</StrictMode>);
}

void render();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js', { scope: '/', type: 'module', updateViaCache: 'none' })
      .catch(() => undefined);
  });
}
