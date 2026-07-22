// Session wiring — thin composition over the standalone client machinery.
// Everything protocol-shaped (auth restore, socket sync, store) is imported as-is.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
  fetchAdapters,
  refreshAdapters,
  fetchMemberDetails,
  fetchRooms,
  type AdapterRegistration,
  type MemberDetail,
} from '@runtime/api.js';
import {
  currentBrowserAccessToken,
  restoreBrowserAccess,
  setActiveBrowserAccessToken,
  storeBrowserAccess,
} from '@runtime/crypto.js';
import { connect, type Connection } from '@runtime/ws.js';
import type { Room } from '@codor/protocol';

import { useClientStore } from './store.js';

/**
 * The room named in the URL, or nothing. Never a placeholder: `'default'` was
 * a room no account owns, so a bare `/` launch subscribed to a phantom channel
 * and reconnect logic then restored it faithfully.
 */
export function pageParams(): { room?: string } {
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room');
  return room === null || room === '' ? {} : { room };
}

/** Same access-token contract as the legacy client: an explicit ?token= is persisted for
 *  PWA cold launches and stripped from the URL; otherwise paired-browser access restores
 *  from encrypted storage; empty string means unpaired. */
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
      // Keep the explicit URL token when persistent storage is unavailable.
    }
    return setActiveBrowserAccessToken(explicit);
  }
  try {
    return setActiveBrowserAccessToken(await restoreBrowserAccess(window.location.origin));
  } catch {
    return setActiveBrowserAccessToken('');
  }
}

export function useConnection(room: string, token: string, refreshToken?: () => Promise<string>): Connection {
  const ref = useRef<Connection | null>(null);
  if (ref.current === null) {
    ref.current = connect({ room, token, refreshToken });
  }
  return ref.current;
}

export const useAccessToken = (fallback: string): (() => string) =>
  useCallback(() => currentBrowserAccessToken(fallback), [fallback]);

export function useConnected(): boolean {
  return useClientStore((state) => state.connected);
}

/** Adapter catalog with the adapter retry contract: discovery is asynchronous, so keep
 *  asking (bounded) until the catalog stops reporting `discovering`. */
export interface AdapterCatalog {
  /** Every catalog entry — used by Configure to derive a locked selector. */
  registered: AdapterRegistration[];
  /** Primary unlocked choices only: installed natives + detected, unshadowed named providers. */
  installed: AdapterRegistration[];
  /** The generic custom ACP transport, shown only behind an Advanced disclosure. */
  advanced: AdapterRegistration[];
  refreshing: boolean;
  refreshError?: string;
  refresh: () => void;
}

// harn:assume agent-selection-shows-detected-acp-and-advanced-custom ref=detected-acp-catalog-client
export function useAdapterCatalog(token: () => string): AdapterCatalog {
  const [adapters, setAdapters] = useState<AdapterRegistration[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  const active = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const attemptsLeft = useRef(10);

  const poll = useCallback((listing: { adapters: AdapterRegistration[]; discovering: boolean }): void => {
    if (!active.current) return;
    setAdapters(listing.adapters);
    if (!listing.discovering || attemptsLeft.current <= 0) return;
    attemptsLeft.current -= 1;
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void fetchAdapters({ token: token() }).then(poll).catch(() => undefined);
    }, 500);
  }, [token]);

  useEffect(() => {
    active.current = true;
    attemptsLeft.current = 10;
    void fetchAdapters({ token: token() }).then(poll).catch(() => undefined);
    return () => {
      active.current = false;
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
  }, [poll, token]);

  const refresh = useCallback((): void => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(undefined);
    attemptsLeft.current = 10;
    void refreshAdapters({ token: token() }).then(
      (listing) => poll(listing),
      (error: unknown) => {
        if (active.current) setRefreshError(error instanceof Error ? error.message : String(error));
      },
    ).finally(() => { if (active.current) setRefreshing(false); });
  }, [poll, refreshing, token]);

  return {
    registered: adapters,
    // harn:assume adapter-catalog-distinguishes-installed-and-configurable ref=configurable-adapter-client
    // Primary selection excludes the generic custom ACP tile (configurable) and any named
    // provider shadowed by an installed native adapter; named providers appear only when
    // actually detected on the daemon host.
    installed: adapters.filter((adapter) =>
      adapter.installed !== false
      && adapter.configurable !== true
      && adapter.shadowed_by_native === undefined),
    advanced: adapters.filter((adapter) => adapter.configurable === true),
    // harn:end adapter-catalog-distinguishes-installed-and-configurable
    refreshing,
    ...(refreshError !== undefined && { refreshError }),
    refresh,
  };
}
// harn:end agent-selection-shows-detected-acp-and-advanced-custom

export function useRooms(token: () => string): Room[] {
  const connected = useConnected();
  const [rooms, setRooms] = useState<Room[]>([]);
  useEffect(() => {
    if (!connected) return;
    let current = true;
    void fetchRooms({ token: token() })
      .then((items) => { if (current) setRooms(items); })
      .catch(() => undefined);
    return () => { current = false; };
  }, [connected, token]);
  return rooms;
}

export function useMemberDetails(room: string, token: () => string): Record<string, MemberDetail> {
  const connected = useConnected();
  const [details, setDetails] = useState<Record<string, MemberDetail>>({});
  useEffect(() => {
    if (!connected) return;
    let current = true;
    void fetchMemberDetails(room, { token: token() })
      .then((items) => {
        if (current) setDetails(Object.fromEntries(items.map((d) => [d.member.id, d])));
      })
      .catch(() => undefined);
    return () => { current = false; };
  }, [connected, room, token]);
  return details;
}

/** Mobile is a re-composition, not a squeeze: one surface at a time under 720. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia('(max-width: 719px)');
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => window.matchMedia('(max-width: 719px)').matches,
    () => false,
  );
}

/** 60s tick for relative timestamps (rail rows re-render on the shared beat). */
export function useMinuteTick(): number {
  return useSyncExternalStore(
    (onChange) => {
      const timer = setInterval(onChange, 60_000);
      return () => clearInterval(timer);
    },
    () => Math.floor(Date.now() / 60_000),
    () => 0,
  );
}
