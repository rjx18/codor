import type { Member, Room } from '@codor/protocol';
import { Archive, ArchiveRestore, ChevronDown, ChevronLeft, MoreVertical, Plus, Search, Settings, Share2, Square, Users, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { Connection } from '@runtime/ws.js';
import { archiveRoom, fetchArchivedRooms, restoreRoom } from '@runtime/api.js';

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
import { ArchiveChannelDialog, ContextPanel } from './ContextPanel.js';
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
  home?: boolean;
}) {
  const token = useAccessToken(props.token);
  // The room is resolved and validated before this component exists, so the
  // connector never opens on a speculative id.
  const [room, setRoom] = useState(props.room);
  const [home, setHome] = useState(props.home === true);
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
    if (next !== room) {
      connection.switchRoom(next);
      setRoom(next);
      rememberRoom(next);
    }
    setHome(false);
    window.history.pushState(null, '', `/?room=${encodeURIComponent(next)}`);
  };
  const openHome = (): void => {
    setHome(true);
    window.history.pushState(null, '', '/channels');
  };

  // The connector owns global listeners and a socket; unmounting without
  // disposing leaves both alive to act on a page that no longer exists.
  useEffect(() => () => { connectorRef.current?.dispose(); }, []);

  useEffect(() => {
    const onPop = (): void => {
      if (window.location.pathname === '/channels') {
        setHome(true);
        return;
      }
      // Back/forward only ever reaches rooms this session already opened.
      const next = pageParams().room;
      if (next === undefined) return;
      setHome(false);
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
  const [surface, setSurface] = useState<'channels' | 'room'>(home ? 'channels' : 'room');
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
            home={home}
            onHome={openHome}
            onStopAgents={(targetRoom, members) => {
              for (const member of members) {
                connection.actInRoom(targetRoom, { act: 'interrupt', member_id: member.id });
              }
            }}
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
    <div className={`nx-app ${home ? 'is-home' : ''}`} data-testid="app">
      <ChannelRail
        activeRoom={room}
        token={token}
        home={home}
        onHome={openHome}
        onSwitch={switchRoom}
        onStopAgents={(targetRoom, members) => {
          for (const member of members) {
            connection.actInRoom(targetRoom, { act: 'interrupt', member_id: member.id });
          }
        }}
      />
      {home ? (
        <ChannelsHome
          token={token}
          onSwitch={switchRoom}
          onStopAgents={(targetRoom, members) => {
            for (const member of members) {
              connection.actInRoom(targetRoom, { act: 'interrupt', member_id: member.id });
            }
          }}
        />
      ) : (
        <>
          <ChatPanel
            room={room}
            connection={connection}
            token={token}
            onContext={() => setResponsiveContext(true)}
          />
          <ContextPanel room={room} token={token} connection={connection} />
        </>
      )}
      {responsiveContext && !home && (
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
  home: boolean;
  onHome: () => void;
  onSwitch: (room: string) => void;
  onStopAgents: (room: string, members: Member[]) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [archivedRooms, setArchivedRooms] = useState<Room[]>([]);
  const [archivedError, setArchivedError] = useState<string>();
  const [restoringRoom, setRestoringRoom] = useState<string>();
  const summaries = useRoomSummaries(props.token);
  const connected = useClientStore((state) => state.connected);
  const roomStates = useClientStore((state) => state.rooms);
  const active = useClientStore((state) => roomSlice(state, props.activeRoom));
  const room = active.room;
  const members = active.members;
  const selfId = active.selfMemberId;
  useMinuteTick();

  const self = selfId !== undefined ? members[selfId] : undefined;
  useEffect(() => {
    let cancelled = false;
    void fetchArchivedRooms({ token: props.token() }).then(
      (rooms) => {
        if (!cancelled) setArchivedRooms(rooms);
      },
      (failure: unknown) => {
        if (!cancelled) {
          setArchivedError(failure instanceof Error ? failure.message : String(failure));
        }
      },
    );
    return () => { cancelled = true; };
  }, [props.token]);
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
      const aHydrated = roomStates[a.id]?.room !== undefined;
      const bHydrated = roomStates[b.id]?.room !== undefined;
      const aWorking = (workingByRoom[a.id]?.length ?? 0) > 0 || (!aHydrated && a.working);
      const bWorking = (workingByRoom[b.id]?.length ?? 0) > 0 || (!bHydrated && b.working);
      if (aWorking !== bWorking) return aWorking ? -1 : 1;
      return lastActivity(b) - lastActivity(a);
    });
  }, [summaries, room, workingByRoom, roomStates]);
  const visibleEntries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (needle === '') return entries;
    return entries.filter((entry) =>
      [entry.name, entry.id, summaryPreview(entry)]
        .some((value) => value.toLocaleLowerCase().includes(needle)));
  }, [entries, query]);

  return (
    <nav className="nx-rail" aria-label="Channels">
      <a
        className="nx-brand"
        href="/channels"
        aria-current={props.home ? 'page' : undefined}
        data-testid="channels-home-link"
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          props.onHome();
        }}
      >
        <span className="nx-brand-tile" aria-hidden="true" />
        <strong>Codor</strong>
      </a>
      <div className="nx-rail-search">
        <Search size={15} aria-hidden="true" />
        <input
          type="search"
          placeholder="Search"
          aria-label="Search channels"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
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
        {visibleEntries.map((entry) => {
          const active = entry.id === props.activeRoom;
          const workingAgents = workingByRoom[entry.id] ?? [];
          const fallbackWorking = roomStates[entry.id]?.room === undefined && entry.working;
          const isWorking = workingAgents.length > 0 || fallbackWorking;
          const workingLabel = activityLabel(workingAgents, fallbackWorking);
          const unread = entry.unread;
          const lastTs = entry.latest?.ts;
          const preview = summaryPreview(entry);
          return (
            <li className="nx-row-shell" key={entry.id}>
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
                      <span className="nx-row-working-summary">
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
              {isWorking && (
                <ChannelWorkControl
                  room={entry.id}
                  roomName={entry.name}
                  agents={workingAgents}
                  fallbackWorking={fallbackWorking}
                  onStop={props.onStopAgents}
                />
              )}
              <ChannelActionsMenu
                room={entry.id}
                roomName={entry.name}
                token={props.token}
                working={isWorking}
                onArchived={() => { window.location.assign('/channels'); }}
              />
            </li>
          );
        })}
      </ul>
      {archivedRooms.length > 0 && (
        <div className="nx-archived-rooms">
          <button
            type="button"
            className="nx-archived-toggle"
            aria-expanded={showArchived}
            data-testid="archived-rooms-toggle"
            onClick={() => setShowArchived((shown) => !shown)}
          >
            <ChevronDown size={14} aria-hidden="true" />
            Archived
            <span>{archivedRooms.length}</span>
          </button>
          {showArchived && (
            <ul className="nx-archived-list">
              {archivedRooms.map((archived) => (
                <li className="nx-archived-row" key={archived.id} data-testid={`archived-room-${archived.id}`}>
                  <span>{archived.name}</span>
                  <button
                    type="button"
                    disabled={restoringRoom !== undefined}
                    data-testid={`restore-room-${archived.id}`}
                    onClick={() => {
                      setRestoringRoom(archived.id);
                      setArchivedError(undefined);
                      void restoreRoom(archived.id, { token: props.token() }).then(
                        (restored) => {
                          window.location.assign(`/?room=${encodeURIComponent(restored.id)}`);
                        },
                        (failure: unknown) => {
                          setArchivedError(failure instanceof Error ? failure.message : String(failure));
                          setRestoringRoom(undefined);
                        },
                      );
                    }}
                  >
                    <ArchiveRestore size={13} aria-hidden="true" />
                    {restoringRoom === archived.id ? 'Restoring…' : 'Restore'}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {archivedError !== undefined && (
            <p className="nx-archived-error" role="alert">{archivedError}</p>
          )}
        </div>
      )}
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

function activityLabel(agents: Member[], fallbackWorking: boolean): string {
  const running = agents.filter((member) => member.state === 'running');
  const queued = agents.filter((member) => member.state === 'queued');
  if (running.length > 0 && queued.length > 0) {
    return `${String(running.length)} working · ${String(queued.length)} queued`;
  }
  if (queued.length === 1) return `@${queued[0]!.handle} is queued`;
  if (queued.length > 1) return `${String(queued.length)} agents queued`;
  if (running.length === 1) return `@${running[0]!.handle} is working`;
  if (running.length > 1) return `${String(running.length)} agents are working`;
  return fallbackWorking ? 'Activity is syncing' : 'Idle';
}

function ChannelWorkControl(props: {
  room: string;
  roomName: string;
  agents: Member[];
  fallbackWorking: boolean;
  onStop: (room: string, agents: Member[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const label = activityLabel(props.agents, props.fallbackWorking);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="nx-row-work-control" ref={ref}>
      <button
        type="button"
        className="nx-row-working"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Manage agent activity in ${props.roomName}: ${label}`}
        data-testid={`room-working-${props.room}`}
        onClick={() => setOpen((shown) => !shown)}
      >
        <span className="nx-typing" aria-hidden="true"><span /><span /><span /></span>
        {label}
      </button>
      {open && (
        <div className="nx-menu nx-work-menu" role="menu" aria-label={`Agent activity in ${props.roomName}`}>
          <strong>Agent activity</strong>
          {props.agents.length === 0 ? (
            <p>Status is syncing. Open this channel to see its members.</p>
          ) : (
            <>
              {props.agents.map((agent) => (
                <button
                  type="button"
                  role="menuitem"
                  key={agent.id}
                  data-testid={`rail-stop-${agent.handle}`}
                  onClick={() => {
                    props.onStop(props.room, [agent]);
                    setOpen(false);
                  }}
                >
                  <span>@{agent.handle}</span>
                  <span>{agent.state === 'queued' ? 'Cancel queued work' : 'Stop run'}</span>
                </button>
              ))}
              {props.agents.length > 1 && (
                <button
                  type="button"
                  role="menuitem"
                  className="is-danger"
                  data-testid={`rail-stop-all-${props.room}`}
                  onClick={() => {
                    props.onStop(props.room, props.agents);
                    setOpen(false);
                  }}
                >
                  <Square size={12} aria-hidden="true" />
                  Stop all agent work
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ChannelActionsMenu(props: {
  room: string;
  roomName: string;
  token: () => string;
  working: boolean;
  onArchived: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string>();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <div className="nx-row-actions" ref={ref}>
        <IconButton
          icon={MoreVertical}
          label={`Actions for ${props.roomName}`}
          size="sm"
          variant="quiet"
          data-testid={`room-actions-${props.room}`}
          onClick={() => setOpen((shown) => !shown)}
        />
        {open && (
          <div className="nx-menu" role="menu" aria-label={`${props.roomName} actions`}>
            <button
              type="button"
              role="menuitem"
              disabled={props.working}
              title={props.working ? 'Stop or cancel the active agents before archiving.' : undefined}
              onClick={() => {
                setOpen(false);
                setArchiveError(undefined);
                setArchiving(true);
              }}
            >
              <Archive size={13} aria-hidden="true" />
              {props.working ? 'Archive after agents stop' : 'Archive channel…'}
            </button>
          </div>
        )}
      </div>
      {archiving && (
        <ArchiveChannelDialog
          roomName={props.roomName}
          busy={archiveBusy}
          error={archiveError}
          onClose={() => {
            if (!archiveBusy) setArchiving(false);
          }}
          onArchive={() => {
            setArchiveBusy(true);
            setArchiveError(undefined);
            void archiveRoom(props.room, { token: props.token() }).then(
              props.onArchived,
              (failure: unknown) => {
                setArchiveError(failure instanceof Error ? failure.message : String(failure));
                setArchiveBusy(false);
              },
            );
          }}
        />
      )}
    </>
  );
}

function ChannelsHome(props: {
  token: () => string;
  onSwitch: (room: string) => void;
  onStopAgents: (room: string, members: Member[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [archivedRooms, setArchivedRooms] = useState<Room[]>([]);
  const [restoringRoom, setRestoringRoom] = useState<string>();
  const [error, setError] = useState<string>();
  const summaries = useRoomSummaries(props.token);
  const roomStates = useClientStore((state) => state.rooms);
  const workingByRoom = useMemo(() => Object.fromEntries(
    Object.entries(roomStates).map(([roomId, slice]) => [
      roomId,
      Object.values(slice.members)
        .filter((member) => member.kind === 'agent' && (member.state === 'running' || member.state === 'queued'))
        .sort((left, right) => left.handle.localeCompare(right.handle)),
    ]),
  ), [roomStates]);

  useEffect(() => {
    let cancelled = false;
    void fetchArchivedRooms({ token: props.token() }).then(
      (rooms) => {
        if (!cancelled) setArchivedRooms(rooms);
      },
      (failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    return () => { cancelled = true; };
  }, [props.token]);

  const needle = query.trim().toLocaleLowerCase();
  const visible = summaries.filter((entry) =>
    needle === '' ||
    [entry.name, entry.id, summaryPreview(entry)]
      .some((value) => value.toLocaleLowerCase().includes(needle)));
  const visibleArchived = archivedRooms.filter((room) =>
    needle === '' ||
    [room.name, room.id].some((value) => value.toLocaleLowerCase().includes(needle)));

  return (
    <main className="nx-channel-home" data-testid="channels-home">
      <header className="nx-channel-home-head">
        <div>
          <Eyebrow>Home</Eyebrow>
          <h1>Channels</h1>
          <p>Open a workspace, manage its agents, or archive finished work.</p>
        </div>
        <button type="button" className="nx-btn is-primary" data-testid="home-create-room" onClick={() => setCreating(true)}>
          <Plus size={15} aria-hidden="true" />
          New channel
        </button>
      </header>
      <label className="nx-channel-home-search">
        <Search size={17} aria-hidden="true" />
        <span className="sr-only">Search channels</span>
        <input
          type="search"
          placeholder="Search channels"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />
      </label>
      {error !== undefined && <p className="nx-archived-error" role="alert">{error}</p>}
      <section className="nx-channel-home-section" aria-labelledby="active-channels-title">
        <div className="nx-channel-home-label">
          <h2 id="active-channels-title">Active</h2>
          <span>{visible.length}</span>
        </div>
        <ul className="nx-channel-grid">
          {visible.map((entry) => {
            const agents = workingByRoom[entry.id] ?? [];
            const fallbackWorking = roomStates[entry.id]?.room === undefined && entry.working;
            const working = agents.length > 0 || fallbackWorking;
            return (
              <li className="nx-channel-card" key={entry.id}>
                <a
                  href={`/?room=${encodeURIComponent(entry.id)}`}
                  data-testid={`home-room-${entry.id}`}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                    event.preventDefault();
                    props.onSwitch(entry.id);
                  }}
                >
                  <Chip name={entry.name} accent="indigo" size={42} presence={working ? 'live' : 'idle'} />
                  <span>
                    <strong>{entry.name}</strong>
                    <small>{working ? activityLabel(agents, fallbackWorking) : summaryPreview(entry)}</small>
                  </span>
                </a>
                {working && (
                  <ChannelWorkControl
                    room={entry.id}
                    roomName={entry.name}
                    agents={agents}
                    fallbackWorking={fallbackWorking}
                    onStop={props.onStopAgents}
                  />
                )}
                <ChannelActionsMenu
                  room={entry.id}
                  roomName={entry.name}
                  token={props.token}
                  working={working}
                  onArchived={() => { window.location.reload(); }}
                />
              </li>
            );
          })}
        </ul>
        {visible.length === 0 && <p className="nx-channel-home-empty">No active channels match that search.</p>}
      </section>
      {(visibleArchived.length > 0 || archivedRooms.length > 0) && (
        <section className="nx-channel-home-section" aria-labelledby="archived-channels-title">
          <div className="nx-channel-home-label">
            <h2 id="archived-channels-title">Archived</h2>
            <span>{visibleArchived.length}</span>
          </div>
          <ul className="nx-channel-grid is-archived">
            {visibleArchived.map((room) => (
              <li className="nx-channel-card" key={room.id}>
                <span className="nx-channel-card-archived">
                  <Chip name={room.name} accent="violet" size={42} />
                  <span><strong>{room.name}</strong><small>Messages and participants preserved</small></span>
                </span>
                <button
                  type="button"
                  className="nx-btn is-quiet"
                  disabled={restoringRoom !== undefined}
                  data-testid={`home-restore-room-${room.id}`}
                  onClick={() => {
                    setRestoringRoom(room.id);
                    setError(undefined);
                    void restoreRoom(room.id, { token: props.token() }).then(
                      (restored) => props.onSwitch(restored.id),
                      (failure: unknown) => {
                        setError(failure instanceof Error ? failure.message : String(failure));
                        setRestoringRoom(undefined);
                      },
                    );
                  }}
                >
                  <ArchiveRestore size={13} aria-hidden="true" />
                  {restoringRoom === room.id ? 'Restoring…' : 'Restore'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
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
    </main>
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
    // Match the Members tab exactly: the structural system member and transient
    // extensions are routing machinery, not visible people or agents.
    Object.values(roomSlice(state, props.room).members)
      .filter((member) => member.removed_ts === undefined
        && (member.kind === 'human' || member.kind === 'agent')).length,
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
        </div>
      </header>
      <HoldBanner room={props.room} connection={props.connection} />
      <Transcript room={props.room} token={props.token} connection={props.connection} />
      <Composer room={props.room} token={props.token} connection={props.connection} />
      {searching && <SearchOverlay room={props.room} token={props.token} onClose={() => setSearching(false)} />}
    </main>
  );
}
