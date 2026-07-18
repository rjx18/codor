import type { Member, Message } from '@codor/protocol';
import { ChevronLeft, MoreVertical, Plus, Search, Settings, Share2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { sortedMessages, unreadCount, useRoomStore } from '@legacy/state.js';
import type { Connection } from '@legacy/ws.js';

import { createConnector, type RoomConnector } from '../app/connector.js';
import {
  pageParams,
  useAccessToken,
  useIsMobile,
  useMinuteTick,
} from '../app/session.js';
import { useRoomSummaries, type RoomSummary } from '../app/summary.js';
import { ContextPanel } from './ContextPanel.js';
import { Chip, IconButton, Eyebrow, StatusPill } from '../primitives/primitives.js';
import { compactCount, memberAccent, relativeTime, usd } from '../primitives/identity.js';
import { Composer } from './Composer.js';
import { CreateChannelDialog } from './CreateChannel.js';
import { HoldBanner, InboxControl, SearchOverlay } from './panels.js';
import { Transcript } from './Transcript.js';

export function RoomPage(props: { token: string; refreshToken?: () => Promise<string> }) {
  const page = useMemo(pageParams, []);
  const token = useAccessToken(props.token);
  const [room, setRoom] = useState(page.room);
  const connectorRef = useRef<RoomConnector | null>(null);
  if (connectorRef.current === null) {
    connectorRef.current = createConnector({
      room: page.room,
      token: props.token,
      refreshToken: props.refreshToken,
    });
  }
  const connection = connectorRef.current;

  // In-place channel switching: socket resubscribes, store resets, URL follows.
  const switchRoom = (next: string): void => {
    if (next === room) return;
    connection.switchRoom(next);
    setRoom(next);
    window.history.pushState(null, '', `/?room=${encodeURIComponent(next)}`);
  };

  useEffect(() => {
    const onPop = (): void => {
      const next = pageParams().room;
      connection.switchRoom(next);
      setRoom(next);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mobile is a two-surface stack (channels ⇄ room), never a drawer.
  const isMobile = useIsMobile();
  const [surface, setSurface] = useState<'channels' | 'room'>('room');
  const [mobileContext, setMobileContext] = useState(false);

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
      <ChatPanel room={room} connection={connection} token={token} />
      <ContextPanel room={room} token={token} connection={connection} />
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
  const summaries = useRoomSummaries(props.activeRoom, props.token);
  const connected = useRoomStore((s) => s.connected);
  const room = useRoomStore((s) => s.room);
  const members = useRoomStore((s) => s.members);
  const selfId = useRoomStore((s) => s.selfMemberId);
  const liveUnread = useRoomStore((s) => unreadCount(s));
  const messages = useRoomStore((s) => s.messages);
  useMinuteTick();

  const self = selfId !== undefined ? members[selfId] : undefined;
  const latest = useMemo(() => sortedMessages(messages).at(-1), [messages]);
  const working = useMemo(() => {
    const workingMember = Object.values(members).find((m) => m.kind === 'agent' && (m.state === 'running' || m.state === 'queued'));
    return workingMember;
  }, [members]);

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
      const aWorking = a.id === props.activeRoom ? working !== undefined : a.working;
      const bWorking = b.id === props.activeRoom ? working !== undefined : b.working;
      if (aWorking !== bWorking) return aWorking ? -1 : 1;
      return lastActivity(b) - lastActivity(a);
    });
  }, [summaries, room, props.activeRoom, working]);

  return (
    <nav className="nx-rail" aria-label="Channels">
      <div className="nx-brand">
        <span className="nx-brand-tile" aria-hidden="true">C</span>
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
          const isWorking = active ? working !== undefined : entry.working;
          const unread = active ? liveUnread : entry.unread;
          const lastTs = active ? latest?.ts ?? entry.latest?.ts : entry.latest?.ts;
          const preview = active && latest
            ? livePreview(latest, members, selfId)
            : summaryPreview(entry);
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
                      <span className="nx-row-working">
                        <span className="nx-typing" aria-hidden="true"><span /><span /><span /></span>
                        {active && working ? `@${working.handle} is working…` : 'working…'}
                      </span>
                    ) : entry.attention ? (
                      <span className="nx-row-preview is-error">agent needs attention</span>
                    ) : (
                      <span className="nx-row-preview">{preview}</span>
                    )}
                    {unread > 0 && (
                      <span className="nx-unread" data-testid={active ? 'rail-unread' : undefined}>
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

function livePreview(message: Message, members: Record<string, Member>, selfId: string | undefined): string {
  const author = members[message.author];
  const name = message.author === selfId ? 'You' : `@${author?.handle ?? '…'}`;
  const body = message.body.length > 0
    ? message.body.split('\n', 1)[0] ?? ''
    : message.kind === 'run' ? 'run in progress' : '…';
  return `${name}: ${body}`;
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
  mobile?: { onBack: () => void; onContext: () => void };
}) {
  const room = useRoomStore((s) => s.room);
  const meter = useRoomStore((s) => s.meter);
  const connected = useRoomStore((s) => s.connected);
  const memberCount = useRoomStore((s) =>
    // Extensions stay out of the count, mirroring the Members tab roster.
    Object.values(s.members).filter((m) => m.removed_ts === undefined && m.kind !== 'extension').length,
  );
  const workingAgent = useRoomStore((s) =>
    Object.values(s.members).find((m) => m.kind === 'agent' && (m.state === 'running' || m.state === 'queued'))?.handle,
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
        <HoldBanner connection={props.connection} />
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
          <p className="nx-chat-stats" data-testid="meter">
            {memberCount} members · {meter?.turns ?? 0} turns · {compactCount((meter?.input_tokens ?? 0) + (meter?.output_tokens ?? 0))} tokens · {usd(meter?.cost_usd ?? 0)} today
          </p>
        </div>
        <div className="nx-chat-actions">
          <IconButton icon={Search} label="Search messages" data-testid="toggle-message-search" onClick={() => setSearching(true)} />
          <InboxControl room={props.room} connection={props.connection} token={props.token} />
          <IconButton icon={Share2} label="Open ledger graph" onClick={() => { window.location.href = `/ledger?room=${props.room}`; }} />
          <IconButton icon={Settings} label="Channel settings" data-testid="room-settings" onClick={() => { window.location.href = `/settings?room=${props.room}`; }} />
        </div>
      </header>
      <HoldBanner connection={props.connection} />
      <Transcript room={props.room} token={props.token} connection={props.connection} />
      <Composer room={props.room} token={props.token} connection={props.connection} />
      {searching && <SearchOverlay room={props.room} token={props.token} onClose={() => setSearching(false)} />}
    </main>
  );
}
