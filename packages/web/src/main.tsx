import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { PairingPage } from './pairing';
import './styles.css';

const root = document.querySelector('#root');
if (!root) {
  throw new Error('missing #root element');
}

createRoot(root).render(
  <StrictMode>
    {window.location.pathname === '/pair' ? <PairingPage /> : <App />}
  </StrictMode>,
);
