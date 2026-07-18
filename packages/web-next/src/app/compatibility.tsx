import { LoaderCircle, RefreshCw } from 'lucide-react';
import { useState, useSyncExternalStore, type ReactNode } from 'react';

import { BROWSER_PROTOCOL_EPOCH, type ServerFrame } from '@codor/protocol';

export interface BrowserUpgrade {
  minimum: number;
  current: number;
}

let required: BrowserUpgrade | undefined;
const listeners = new Set<() => void>();

function publish(next: BrowserUpgrade): void {
  required = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const snapshot = (): BrowserUpgrade | undefined => required;

export function requireBrowserUpgrade(frame: Extract<ServerFrame, { type: 'upgrade_required' }>): void {
  publish({
    minimum: frame.minimum_browser_protocol,
    current: frame.current_browser_protocol,
  });
}

export async function checkBrowserCompatibility(token: string): Promise<void> {
  const query = new URLSearchParams({
    browser_protocol: String(BROWSER_PROTOCOL_EPOCH),
    client_kind: 'browser',
  });
  try {
    const response = await fetch(`/api/client-compatibility?${query.toString()}`, {
      cache: 'no-store',
      headers: { authorization: `Bearer ${token}` },
    });
    // The reader is intentionally deployed before the observer server. A 404
    // identifies that safe pre-epoch daemon; only an authoritative 426 gates.
    if (response.status !== 426) return;
    const body = await response.json() as {
      browser_protocol?: number;
      minimum_browser_protocol?: number;
    };
    publish({
      minimum: body.minimum_browser_protocol ?? BROWSER_PROTOCOL_EPOCH + 1,
      current: body.browser_protocol ?? BROWSER_PROTOCOL_EPOCH,
    });
  } catch {
    // Network/offline state is not evidence of incompatibility. The existing
    // connector owns reconnect UI and a later UpgradeRequired remains decisive.
  }
}

function controllerChanged(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      navigator.serviceWorker.removeEventListener('controllerchange', finish);
      resolve();
    };
    navigator.serviceWorker.addEventListener('controllerchange', finish);
    window.setTimeout(finish, 2_000);
  });
}

export async function refreshBrowserApp(): Promise<void> {
  if ('serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.getRegistration('/');
    if (registration !== undefined) {
      const changed = controllerChanged();
      await registration.update().catch(() => undefined);
      await changed;
    }
  }
  const target = new URL(window.location.href);
  target.searchParams.set('_codor_update', String(Date.now()));
  window.location.replace(target.toString());
}

export function CompatibilityGate(props: { children: ReactNode }) {
  const upgrade = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [refreshing, setRefreshing] = useState(false);
  if (upgrade === undefined) return props.children;
  return (
    <main className="nx-upgrade" data-testid="upgrade-required">
      <section className="nx-upgrade-card" aria-labelledby="upgrade-title" aria-describedby="upgrade-copy">
        <span className="nx-upgrade-mark" aria-hidden="true"><RefreshCw size={24} /></span>
        <p className="nx-eyebrow">Update required</p>
        <h1 id="upgrade-title">Codor has been updated</h1>
        <p id="upgrade-copy">
          This installed app is too old to read the current channel format safely.
          Refresh once to load the new version.
        </p>
        <button
          type="button"
          className="nx-btn is-primary nx-upgrade-action"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            void refreshBrowserApp().catch(() => setRefreshing(false));
          }}
        >
          {refreshing
            ? <><LoaderCircle className="nx-spin" size={16} aria-hidden="true" /> Updating…</>
            : <><RefreshCw size={16} aria-hidden="true" /> Refresh Codor</>}
        </button>
        <p className="nx-upgrade-version">
          App protocol {upgrade.current}; server requires {upgrade.minimum}.
        </p>
      </section>
    </main>
  );
}

export function clearBrowserUpgradeForTest(): void {
  required = undefined;
  for (const listener of listeners) listener();
}
