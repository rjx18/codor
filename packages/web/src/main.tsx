import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { PairingPage } from './pairing';
import { SettingsPage } from './SettingsPage';
import { LedgerGraphPage } from './LedgerGraph';
import {
  restoreBrowserAccess,
  setActiveBrowserAccessToken,
  storeBrowserAccess,
} from './crypto';
import { applyThemeChoice } from './theme';
import './styles.css';

applyThemeChoice();

const root = document.querySelector('#root');
if (!root) {
  throw new Error('missing #root element');
}
const rootElement = root;

// harn:assume pwa-cold-launch-restores-local-auth ref=paired-access-bootstrap
export async function resolveAccessToken(): Promise<string> {
  const url = new URL(window.location.href);
  const explicit = url.searchParams.get('token') ?? '';
  if (explicit !== '') {
    try {
      await storeBrowserAccess({
        origin: window.location.origin,
        authority: 'operator',
        token: explicit,
      });
      url.searchParams.delete('token');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // Keep the explicit URL token when persistent browser storage is unavailable.
    }
    return setActiveBrowserAccessToken(explicit);
  }
  try {
    return setActiveBrowserAccessToken(await restoreBrowserAccess(window.location.origin));
  } catch {
    return setActiveBrowserAccessToken('');
  }
}

async function render(): Promise<void> {
  const token = await resolveAccessToken();
  createRoot(rootElement).render(
    <StrictMode>
      {window.location.pathname === '/pair'
        ? <PairingPage />
        : window.location.pathname === '/ledger'
          ? <LedgerGraphPage token={token} />
        : window.location.pathname === '/settings'
          ? <SettingsPage token={token} refreshToken={resolveAccessToken} />
          : <App token={token} refreshToken={resolveAccessToken} />}
    </StrictMode>,
  );
}

void render();
// harn:end pwa-cold-launch-restores-local-auth

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      type: 'module',
      updateViaCache: 'none',
    }).catch(() => undefined);
  });
}
