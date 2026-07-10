import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { PairingPage } from './pairing';
import { SettingsPage } from './SettingsPage';
import './styles.css';

const root = document.querySelector('#root');
if (!root) {
  throw new Error('missing #root element');
}

createRoot(root).render(
  <StrictMode>
    {window.location.pathname === '/pair'
      ? <PairingPage />
      : window.location.pathname === '/settings'
        ? <SettingsPage />
        : <App />}
  </StrictMode>,
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      type: 'module',
      updateViaCache: 'none',
    }).catch(() => undefined);
  });
}
