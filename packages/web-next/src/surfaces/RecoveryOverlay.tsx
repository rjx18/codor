import { useEffect, useRef, type ReactNode } from 'react';

import type { SessionConnectionState } from '../app/connection-state.js';
import { useConnectionState } from '../app/use-connection-state.js';
import { RecoveryCard, type RecoveryState } from './RecoveryCard.js';
import { roomSlice, useClientStore } from '../app/store.js';
import { computerSessions } from '../app/computer-sessions.js';

// Brief drops keep the in-room "Reconnecting…" pill; the full recovery screen only
// takes over after the session has been down long enough to be worth explaining.
// Overridable via window for e2e (same pattern as __CODOR_RELAY_URL).
const graceMs = (): number =>
  (typeof window !== 'undefined' && window.__CODOR_RECOVERY_GRACE_MS) || 6_000;

export type LoadingPillState = 'reconnecting' | 'channel' | 'syncing' | 'older';

export interface LoadingPillInputs {
  connectionState: SessionConnectionState;
  connected: boolean;
  readableReconnect: boolean;
  roomHydrated: boolean;
  roomReady: boolean;
  loadingHead: boolean;
  loadingCursor: string | undefined;
}

// harn:assume prioritized-room-loading-pill-uses-existing-readiness ref=loading-pill-state-projection
/** Select one status from the existing connection/readiness/history signals.
 * Lower-priority work must never replace a more urgent state or introduce a
 * second loading owner. */
export function loadingPillState(inputs: LoadingPillInputs): LoadingPillState | undefined {
  if (inputs.connectionState !== 'online' || !inputs.connected) {
    return inputs.readableReconnect ? 'reconnecting' : undefined;
  }
  if (!inputs.roomHydrated || !inputs.roomReady) return 'channel';
  if (inputs.loadingHead) return 'syncing';
  if (inputs.loadingCursor !== undefined) return 'older';
  return undefined;
}

// harn:end prioritized-room-loading-pill-uses-existing-readiness

const LOADING_PILL_LABEL: Record<LoadingPillState, string> = {
  reconnecting: 'Reconnecting',
  channel: 'Loading channel',
  syncing: 'Syncing messages',
  older: 'Loading older messages',
};

/** Read-only controls that do not alter room/server state while the app socket
 * is reconnecting. Everything else button-shaped is disabled until a current
 * server frame restores readiness. */
const READ_ONLY_CONTROL = [
  '[data-testid="toggle-message-search"]',
  '[data-testid^="search-hit-"]',
  '[data-testid="inbox-toggle"]',
  '[data-testid^="pinned-"]',
  '[data-testid="transcript-history-retry"]',
  '[data-testid$="-copy"]',
  '[data-testid^="attachment-"]',
  '[data-testid="preview-thumb"]',
  '[data-testid="preview-lightbox-close"]',
  '[data-testid="computer-current"]',
  '[data-computer-choice="true"]',
  '[data-testid^="worktree-link-"]',
  '[data-testid^="context-tab-"]',
  '[data-testid="responsive-context-trigger"]',
  '[data-testid="mobile-back"]',
  '[data-testid="mobile-kebab"]',
  '[data-testid="diff-refresh"]',
  '[data-testid="git-history-toggle"]',
  '[data-testid="git-history-commit"]',
  '[data-testid="git-history-more"]',
  '[data-testid="worktree-find-retry"]',
  '[data-testid="worktree-preview-retry"]',
  '[aria-label^="Close "]',
  '[aria-label="Settings"]',
  '.nx-jump',
  '.nx-diff-files button',
].join(',');

/**
 * A true OVERLAY: the app (and its connector/tunnel) stay mounted at all times —
 * the recovery card renders ON TOP when the session is unreachable long enough to
 * warrant it, with the app beneath marked aria-hidden. Never unmounting the app is
 * what keeps the reconnect machinery alive (its backoff is the auto-retry) and the
 * down-clock running (so the escalation to the re-pair state is reachable). A live
 * session (or a brief drop within the grace) shows no overlay, so direct/tailnet
 * flows are visually unchanged unless they too go genuinely unreachable.
 */
export function RecoveryOverlay({ children }: { children: ReactNode }): ReactNode {
  const { state, downMs } = useConnectionState();
  const connected = useClientStore((store) => store.connected);
  const activeRoom = useClientStore((store) => store.activeRoom);
  const activeRoomState = useClientStore((store) => store.rooms[activeRoom]);
  const roomReady = useClientStore((store) => activeRoom !== '' && store.roomLive[activeRoom] === true);
  const renderable = useClientStore((store) => {
    const slice = roomSlice(store, store.activeRoom);
    return Object.keys(slice.messages).length > 0 || slice.transcriptHistory.units.length > 0;
  });
  // harn:assume readable-reconnecting-room-never-admits-mutation ref=nonmodal-reconnecting-surface
  const readableReconnect = computerSessions() !== undefined
    && renderable
    && state !== 'online'
    && state !== 'pairing-dead';
  const show = !readableReconnect
    && state !== 'online'
    && !(state === 'agent-offline' && downMs < graceMs());
  const loadingState = loadingPillState({
    connectionState: state,
    connected,
    readableReconnect,
    roomHydrated: activeRoomState?.hydrated === true,
    roomReady,
    loadingHead: activeRoomState?.transcriptHistory.loadingHead === true,
    loadingCursor: activeRoomState?.transcriptHistory.loadingCursor,
  });
  const beneathRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = beneathRef.current;
    if (!el) return;
    // `inert` (attribute-set for cross-version safety) makes the app truly
    // non-focusable beneath the modal — aria-hidden alone leaves it in tab order.
    if (show) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }, [show]);
  useEffect(() => {
    if (!readableReconnect) return undefined;
    const root = document.body;
    const disableMutations = (): void => {
      for (const control of root.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
        'button, input[type="button"], input[type="submit"]',
      )) {
        if (control.matches(READ_ONLY_CONTROL) || control.disabled) continue;
        control.disabled = true;
        control.dataset.reconnectDisabled = 'true';
      }
    };
    disableMutations();
    const observer = new MutationObserver(disableMutations);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
    return () => {
      observer.disconnect();
      for (const control of root.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
        '[data-reconnect-disabled="true"]',
      )) {
        control.disabled = false;
        delete control.dataset.reconnectDisabled;
      }
    };
  }, [readableReconnect]);
  return (
    <>
      <div className="nx-recovery-shell">
        <div
          ref={beneathRef}
          aria-hidden={show || undefined}
          data-reconnecting-readonly={readableReconnect ? 'true' : undefined}
          onSubmitCapture={readableReconnect ? (event) => event.preventDefault() : undefined}
        >
          {children}
        </div>
        {/* harn:assume floating-room-loading-pill-uses-existing-priority ref=floating-pill-render */}
        {loadingState !== undefined ? (
          <div
            className="nx-loading-pill"
            role="status"
            aria-live="polite"
            data-testid="reconnecting-pill"
            data-loading-state={loadingState}
          >
            <span className="nx-loading-pill-spinner" data-testid="loading-pill-spinner" aria-hidden="true" />
            <span>{LOADING_PILL_LABEL[loadingState]}</span>
          </div>
        ) : null}
        {/* harn:end floating-room-loading-pill-uses-existing-priority */}
      </div>
      {show ? <RecoveryCard state={state as RecoveryState} presentation="overlay" /> : null}
    </>
  );
}
// harn:end readable-reconnecting-room-never-admits-mutation
