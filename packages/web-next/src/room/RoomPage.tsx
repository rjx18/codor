import { ChevronLeft, MoreVertical, Plus, Search, Settings, Share2, Users, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { Connection } from '@legacy/ws.js';

import { createConnector, type RoomConnector } from '../app/connector.js';
import { rememberRoom } from '../app/startup.js';
import { refreshMutableRunJournals } from './run-journals.js';
import {
  pageParams,
  useAccessToken,
  useIsMobile,
  useMinuteTick,
} from '../app/session.js';
import { useRoomSummaries, type RoomSummary } from '../app/summary.js';
import { roomSlice, useClientStore } from '../app/store.js';
import { ContextPanel } from './ContextPanel.js';
import { Chip, IconButton, Eyebrow, Modal, StatusPill } from '../primitives/primitives.js';
import { compactCount, memberAccent, relativeTime } from '../primitives/identity.js';
import { Composer } from './Composer.js';
import { CreateChannelDialog } from './CreateChannel.js';
import { HoldBanner, InboxControl, SearchOverlay } from './panels.js';
import { Transcript } from './Transcript.js';
import { costProvenanceLabel } from './spend-label.js';

export function RoomPage(props: {
  room: string;
  token: string;
  refreshToken?: () => Promise<string>;
}) {
  const token = useAccessToken(props.token);
  // The room is resolved and validated before this component exists, so the
  // connector never opens on a speculative id.
  const [room, setRoom] = useState(props.room);
  const connectorRef = useRef<RoomConnector | null>(null);
  if (connectorRef.current === null) {
    connectorRef.current = createConnector({
      room: props.room,
      token: props.token,
      refreshToken: props.refreshToken,
      // Every legal resume — lifecycle OR watchdog — re-reads the active room's
      // still-mutable evidence. Listening for lifecycle events separately would
      // miss the watchdog, which emits none of them.
      // The LIVE token, not the one this page was constructed with: after a
      // 4401 refresh the original is stale, and journal recovery would go out
      // with a credential the server has already replaced.
      onResume: (room) => { refreshMutableRunJournals(room, token); },
    });
  }
  const connection = connectorRef.current;

  // In-place channel switching: select the room's keyed slice, keep the shared
  // socket and every background subscription alive, and let the URL follow.
  const switchRoom = (next: string): void => {
    if (next === room) return;
    connection.switchRoom(next);
    setRoom(next);
    rememberRoom(next);
    window.history.pushState(null, '', `/?room=${encodeURIComponent(next)}`);
  };

  // The connector owns global listeners and a socket; unmounting without
  // disposing leaves both alive to act on a page that no longer exists.
  useEffect(() => () => { connectorRef.current?.dispose(); }, []);

  useEffect(() => {
    const onPop = (): void => {
      // Back/forward only ever reaches rooms this session already opened.
      const next = pageParams().room;
      if (next === undefined) return;
      connection.switchRoom(next);
      setRoom(next);
      rememberRoom(next);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mobile is a two-surface stack (channels ⇄ room), never a drawer.
  const isMobile = useIsMobile();
  const [surface, setSurface] = useState<'channels' | 'room'>('room');
  const [mobileContext, setMobileContext] = useState(false);
  const [responsiveContext, setResponsiveContext] = useState(false);

  // The inline context island collapses only at laptop/tablet widths. If an
  // open dialog crosses into either full desktop or mobile, close it so the
  // composition appropriate to that viewport owns the context surface.
  useEffect(() => {
    if (!responsiveContext) return;
    const query = window.matchMedia('(min-width: 720px) and (max-width: 1360px)');
    const onChange = (): void => {
      if (!query.matches) setResponsiveContext(false);
    };
    query.addEventListener('change', onChange);
    onChange();
    return () => query.removeEventListener('change', onChange);
  }, [responsiveContext]);

  if (isMobile) {
    return (
      <div className="nx-app is-mobile" data-testid="app" data-surface={surface}>
        {surface === 'channels' ? (
          <ChannelRail
            activeRoom={room}
            token={token}
            onSwitch={(next) => {
              switchRoom(next);
              setSurface('room');
            }}
          />
        ) : (
          <ChatPanel
            room={room}
            connection={connection}
            token={token}
            mobile={{
              onBack: () => setSurface('channels'),
              onContext: () => setMobileContext(true),
            }}
          />
        )}
        {mobileContext && surface === 'room' && (
          <div className="nx-mobile-context" data-testid="mobile-context">
            <button className="nx-mobile-context-close nx-btn" onClick={() => setMobileContext(false)}>
              Close
            </button>
            <ContextPanel room={room} token={token} connection={connection} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="nx-app" data-testid="app">
      <ChannelRail activeRoom={room} token={token} onSwitch={switchRoom} />
      <ChatPanel
        room={room}
        connection={connection}
        token={token}
        onContext={() => setResponsiveContext(true)}
      />
      <ContextPanel room={room} token={token} connection={connection} />
      {responsiveContext && (
        <Modal
          label="Channel context"
          testid="responsive-context"
          onClose={() => setResponsiveContext(false)}
        >
          <div className="nx-responsive-context-shell">
            <header className="nx-responsive-context-head">
              <h2>Channel context</h2>
              <IconButton
                icon={X}
                label="Close channel context"
                variant="quiet"
                onClick={() => setResponsiveContext(false)}
              />
            </header>
            <ContextPanel room={room} token={token} connection={connection} />
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Channel rail ─────────────────────────────────────────────────────────

function ChannelRail(props: {
  activeRoom: string;
  token: () => string;
  onSwitch: (room: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const summaries = useRoomSummaries(props.token);
  const connected = useClientStore((state) => state.connected);
  const roomStates = useClientStore((state) => state.rooms);
  const active = useClientStore((state) => roomSlice(state, props.activeRoom));
  const room = active.room;
  const members = active.members;
  const selfId = active.selfMemberId;
  useMinuteTick();

  const self = selfId !== undefined ? members[selfId] : undefined;
  const workingByRoom = useMemo(() => Object.fromEntries(
    Object.entries(roomStates).map(([roomId, slice]) => [
      roomId,
      Object.values(slice.members)
        .filter((member) => member.kind === 'agent' && (member.state === 'running' || member.state === 'queued'))
        .sort((left, right) => left.handle.localeCompare(right.handle)),
    ]),
  ), [roomStates]);

  // Server summaries drive the rail; the active room's row is overlaid with the
  // fresher socket truth. Working rooms sort first, then most recent activity.
  const entries = useMemo(() => {
    const list: RoomSummary[] = summaries.length > 0
      ? [...summaries]
      : room !== undefined
        ? [{ id: room.id, name: room.name, created_ts: room.created_ts, working: false, attention: false, unread: 0 }]
        : [];
    const lastActivity = (entry: RoomSummary): number =>
      Date.parse(entry.latest?.ts ?? entry.created_ts) || 0;
    return list.sort((a, b) => {
      const aWorking = (workingByRoom[a.id]?.length ?? 0) > 0 || a.working;
      const bWorking = (workingByRoom[b.id]?.length ?? 0) > 0 || b.working;
      if (aWorking !== bWorking) return aWorking ? -1 : 1;
      return lastActivity(b) - lastActivity(a);
    });
  }, [summaries, room, workingByRoom]);

  return (
    <nav className="nx-rail" aria-label="Channels">
      <div className="nx-brand">
        <span className="nx-brand-tile" aria-hidden="true" />
        <strong>Codor</strong>
      </div>
      <div className="nx-rail-search">
        <Search size={15} aria-hidden="true" />
        <input type="search" placeholder="Search" aria-label="Search channels" />
      </div>
      <div className="nx-rail-label">
        <Eyebrow>Channels</Eyebrow>
        <IconButton
          icon={Plus}
          label="Create channel"
          size="sm"
          variant="quiet"
          data-testid="create-room"
          onClick={() => setCreating(true)}
        />
      </div>
      <ul className="nx-rail-list">
        {entries.map((entry) => {
          const active = entry.id === props.activeRoom;
          const workingAgents = workingByRoom[entry.id] ?? [];
          const isWorking = workingAgents.length > 0 || entry.working;
          const workingLabel = workingAgents.length === 1
            ? `@${workingAgents[0]!.handle} is working…`
            : workingAgents.length > 1
              ? `${String(workingAgents.length)} agents are working…`
              : 'working…';
          const unread = entry.unread;
          const lastTs = entry.latest?.ts;
          const preview = summaryPreview(entry);
          return (
            <li key={entry.id}>
              <a
                className={`nx-row ${active ? 'is-active' : ''}`}
                href={`/?room=${encodeURIComponent(entry.id)}`}
                aria-current={active ? 'page' : undefined}
                data-testid={`room-link-${entry.id}`}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                  event.preventDefault();
                  props.onSwitch(entry.id);
                }}
              >
                <Chip
                  name={entry.name}
                  accent="indigo"
                  size={38}
                  presence={entry.attention ? 'error' : isWorking ? 'live' : active && !connected ? 'error' : 'idle'}
                  surface={active ? 'raised' : 'surface'}
                />
                <span className="nx-row-main">
                  <span className="nx-row-top">
                    <span className="nx-row-name">{entry.name}</span>
                    {lastTs !== undefined && <time className="nx-row-time">{relativeTime(lastTs)}</time>}
                  </span>
                  <span className="nx-row-bottom">
                    {isWorking ? (
                      <span className="nx-row-working" data-testid={`room-working-${entry.id}`}>
                        <span className="nx-typing" aria-hidden="true"><span /><span /><span /></span>
                        {workingLabel}
                      </span>
                    ) : entry.attention ? (
                      <span className="nx-row-preview is-error">agent needs attention</span>
                    ) : (
                      <span className="nx-row-preview">{preview}</span>
                    )}
                    {unread > 0 && (
                      <span className="nx-unread" data-testid={`rail-unread-${entry.id}`}>
                        {unread > 99 ? '99+' : unread}
                      </span>
                    )}
                  </span>
                </span>
              </a>
            </li>
          );
        })}
      </ul>
      <footer className="nx-rail-footer">
        <Chip name={self?.display_name ?? self?.handle ?? 'You'} accent="user" size={32} />
        <span className="nx-rail-id">
          <strong>{self?.display_name ?? self?.handle ?? '—'}</strong>
          <span className={`nx-conn ${connected ? 'is-live' : 'is-error'}`} data-testid="connection" title={connected ? 'connected' : 'reconnecting'}>
            <span className="nx-conn-dot" aria-hidden="true" />
            {connected ? 'Connected' : 'Reconnecting…'}
          </span>
        </span>
        <IconButton icon={Settings} label="Settings" variant="quiet" onClick={() => { window.location.href = `/settings?room=${props.activeRoom}`; }} />
      </footer>
      {creating && (
        <CreateChannelDialog
          token={props.token}
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            props.onSwitch(created.id);
          }}
        />
      )}
    </nav>
  );
}

function summaryPreview(entry: RoomSummary): string {
  if (!entry.latest) return 'No messages yet';
  const name = entry.latest.author_handle === '' ? '…' : `@${entry.latest.author_handle}`;
  const body = entry.latest.preview !== ''
    ? entry.latest.preview
    : entry.latest.kind === 'run' ? 'run in progress' : '…';
  return `${name}: ${body}`;
}

// ── Chat panel ───────────────────────────────────────────────────────────

function ChatPanel(props: {
  room: string;
  connection: Connection;
  token: () => string;
  onContext?: () => void;
  mobile?: { onBack: () => void; onContext: () => void };
}) {
  const room = useClientStore((state) => roomSlice(state, props.room).room);
  const meter = useClientStore((state) => roomSlice(state, props.room).meter);
  const connected = useClientStore((state) => state.connected);
  const memberCount = useClientStore((state) =>
    // Extensions stay out of the count, mirroring the Members tab roster.
    Object.values(roomSlice(state, props.room).members)
      .filter((member) => member.removed_ts === undefined && member.kind !== 'extension').length,
  );
  const workingAgent = useClientStore((state) =>
    Object.values(roomSlice(state, props.room).members)
      .find((member) => member.kind === 'agent' && (member.state === 'running' || member.state === 'queued'))?.handle,
  );
  const [searching, setSearching] = useState(false);

  if (props.mobile) {
    return (
      <main className="nx-chat" data-testid="room-view">
        <header className="nx-mobile-head">
          <IconButton icon={ChevronLeft} label="Back to channels" data-testid="mobile-back" onClick={props.mobile.onBack} />
          <div className="nx-mobile-title">
            <h1>{room?.name ?? props.room}</h1>
            <span className="nx-mobile-sub">
              {workingAgent !== undefined ? `@${workingAgent} is working…` : connected ? 'live' : 'reconnecting…'}
            </span>
          </div>
          <IconButton icon={MoreVertical} label="Channel details" data-testid="mobile-kebab" onClick={props.mobile.onContext} />
        </header>
        <HoldBanner room={props.room} connection={props.connection} />
        <Transcript room={props.room} token={props.token} connection={props.connection} />
        <Composer room={props.room} token={props.token} connection={props.connection} />
      </main>
    );
  }

  return (
    <main className="nx-chat" data-testid="room-view">
      <header className="nx-chat-header">
        <div className="nx-chat-id">
          <div className="nx-chat-title">
            <h1>{room?.name ?? props.room}</h1>
            <StatusPill tone={connected ? 'live' : 'error'}>{connected ? 'Live' : 'Offline'}</StatusPill>
          </div>
          {/* harn:assume estimated-cost-is-advisory-not-spend-brake-input ref=room-advisory-cost-surface */}
          <p className="nx-chat-stats" data-testid="meter">
            {memberCount} members · {meter?.turns ?? 0} turns · {compactCount((meter?.input_tokens ?? 0) + (meter?.output_tokens ?? 0))} tokens · {costProvenanceLabel(meter ?? { cost_usd: 0 })} today
          </p>
          {/* harn:end estimated-cost-is-advisory-not-spend-brake-input */}
        </div>
        <div className="nx-chat-actions">
          <IconButton
            icon={Users}
            label="Open members and context"
            data-testid="responsive-context-trigger"
            className="nx-context-trigger"
            onClick={props.onContext}
          />
          <IconButton icon={Search} label="Search messages" data-testid="toggle-message-search" onClick={() => setSearching(true)} />
          <InboxControl room={props.room} connection={props.connection} token={props.token} />
          <IconButton icon={Share2} label="Open ledger graph" onClick={() => { window.location.href = `/ledger?room=${props.room}`; }} />
          <IconButton icon={Settings} label="Channel settings" data-testid="room-settings" onClick={() => { window.location.href = `/settings?room=${props.room}`; }} />
        </div>
      </header>
      <HoldBanner room={props.room} connection={props.connection} />
      <Transcript room={props.room} token={props.token} connection={props.connection} />
      <Composer room={props.room} token={props.token} connection={props.connection} />
      {searching && <SearchOverlay room={props.room} token={props.token} onClose={() => setSearching(false)} />}
    </main>
  );
}
