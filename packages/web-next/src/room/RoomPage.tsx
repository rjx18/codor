import { ChevronLeft, MoreVertical, Plus, Search, Settings, Share2, Users, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { Connection } from '@runtime/ws.js';

import { createConnector, type RoomConnector } from '../app/connector.js';
import { rememberRoom } from '../app/startup.js';
import { refreshMutableRunJournals } from './run-journals.js';
import {
  pageParams,
  roomUrl,
  useAccessToken,
  useIsMobile,
  useMinuteTick,
} from '../app/session.js';
import { relayConnectExtras } from '@runtime/relay-mode.js';
import { useRoomSummaries, type RoomSummary } from '../app/summary.js';
import { roleAtLeast, roomSlice, useClientStore } from '../app/store.js';
import {
  useWorktreeGroup,
  WorktreeChildDialog,
  WorktreeCreateDialog,
  WorktreeFindDialog,
  WorktreeGroupSection,
} from './WorktreeGroup.js';
import type { RegisteredWorktree } from '@codor/protocol';
import { ContextPanel } from './ContextPanel.js';
import { Chip, IconButton, Eyebrow, Modal, StatusPill } from '../primitives/primitives.js';
import { ComputerSwitcher } from './ComputerSwitcher.js';
import { compactCount, memberAccent, relativeTime } from '../primitives/identity.js';
import { Composer } from './Composer.js';
import { CreateChannelDialog } from './CreateChannel.js';
import { HoldBanner, InboxControl, SearchOverlay } from './panels.js';
import { Transcript } from './Transcript.js';
import { costProvenanceLabel } from './spend-label.js';
import { SettingsPage } from '../surfaces/SettingsPage.js';
import {
  computerSessions,
  type ActiveComputerSession,
  type ComputerSessionManager,
  type ComputerSessionsSnapshot,
} from '../app/computer-sessions.js';

const EMPTY_COMPUTER_SNAPSHOT: ComputerSessionsSnapshot = { computers: [] };
const noComputerSubscription = (): (() => void) => () => undefined;

export function RoomPage(props: {
  room: string;
  token: string;
  refreshToken?: () => Promise<string>;
}) {
  // harn:assume settings-navigation-reuses-live-session ref=mounted-settings-route
  const manager = computerSessions();
  useSyncExternalStore(
    manager?.subscribe ?? noComputerSubscription,
    manager?.getSnapshot ?? (() => EMPTY_COMPUTER_SNAPSHOT),
    () => EMPTY_COMPUTER_SNAPSHOT,
  );
  const managed = manager?.active();
  return (
    <MountedRoomPage
      key={managed?.id ?? 'direct'}
      {...props}
      manager={manager}
      managed={managed}
    />
  );
}

function MountedRoomPage(props: {
  room: string;
  token: string;
  refreshToken?: () => Promise<string>;
  manager: ComputerSessionManager | undefined;
  managed: ActiveComputerSession | undefined;
}) {
  const { manager, managed } = props;
  const activeToken = managed?.token ?? props.token;
  const token = useAccessToken(activeToken);
  // The public channel id stays the authorized ROOT; the selected conversation
  // may be one of its registered children. The URL never carries a child id.
  // The root is mutable state — top-level switches, history, reload, and
  // hosted-computer changes all move it — while a hidden child is only ever the
  // selected conversation, never the remembered root.
  const [root, setRoot] = useState(props.room);
  const [room, setRoom] = useState(props.room);
  const [selectedWorktree, setSelectedWorktree] = useState<string | undefined>(
    () => pageParams().worktree,
  );
  const connectorRef = useRef<RoomConnector | null>(null);
  if (!manager && connectorRef.current === null) {
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
      // Relay mode: route the app WebSocket through the tunnel (origin + a
      // socketFactory that opens a fresh app-WS mux stream per session). Empty
      // on the direct local/tailnet path, leaving the page-origin default.
      ...relayConnectExtras(),
    });
  }
  const connection = managed?.connector ?? connectorRef.current;
  if (!connection) throw new Error('RoomPage requires a room connector');
  const [pageSurface, setPageSurface] = useState<'room' | 'settings'>('room');

  // harn:assume registered-worktree-navigation-is-promotion-gated ref=worktree-group-navigation
  // The store-only group projection drives both the hidden-room observation set
  // and selection resolution. Main omits the worktree selector; a selector
  // whose secondary is no longer active falls back to main.
  const group = useWorktreeGroup(root, token);
  const activeChild = selectedWorktree === undefined
    ? undefined
    : group.registered.find((worktree) => !worktree.primary && worktree.id === selectedWorktree);

  useEffect(() => {
    // The public root rides the desired set with its children, so a reconnect
    // while a child is selected still observes main plus every active child.
    connection.setDesiredRooms([
      root,
      ...group.registered.filter((worktree) => !worktree.primary).map((worktree) => worktree.conversation_id),
    ]);
  }, [connection, root, group.registered]);

  useEffect(() => {
    if (!group.loaded) return;
    if (selectedWorktree !== undefined && activeChild === undefined) {
      // The selected secondary ceased to be active: resolve to main.
      setSelectedWorktree(undefined);
      window.history.replaceState(null, '', roomUrl(root));
      return;
    }
    // Main or a resolved child: the connector follows the selection, so Back
    // to a selector-less URL also returns the conversation to the root.
    const target = activeChild?.conversation_id ?? root;
    if (room !== target) {
      connection.switchRoom(target);
      setRoom(target);
    }
  }, [group.loaded, selectedWorktree, activeChild, connection, room, root]);

  const selectWorktree = (worktreeId: string | undefined): void => {
    // Read the FRESH set from the store: a post-create/adopt refresh lands
    // there before this render's `group` prop catches up.
    const fresh = useClientStore.getState().worktreeGroups[root]?.registered ?? group.registered;
    const target = worktreeId === undefined
      ? root
      : fresh.find((worktree) => !worktree.primary && worktree.id === worktreeId)?.conversation_id;
    if (target === undefined) return;
    setSelectedWorktree(worktreeId);
    if (target !== room) {
      connection.switchRoom(target);
      setRoom(target);
    }
    window.history.pushState(null, '', roomUrl(root, worktreeId));
  };
  // harn:end registered-worktree-navigation-is-promotion-gated

  // In-place channel switching: select the room's keyed slice, keep the shared
  // socket and every background subscription alive, and let the URL follow. A
  // top-level channel is always a public root — the worktree selector clears
  // and the public root itself moves.
  const switchRoom = (next: string): void => {
    setSelectedWorktree(undefined);
    if (next === room && next === root) return;
    connection.switchRoom(next);
    setRoot(next);
    setRoom(next);
    if (manager) manager.rememberActiveRoom(next);
    else rememberRoom(next);
    window.history.pushState(null, '', roomUrl(next));
  };

  const openSettings = (): void => {
    // Settings rides the live selected conversation; its history entry still
    // names the public root plus the optional stable child selector, so Back
    // restores exactly what the operator left.
    const params = new URLSearchParams({ room: root });
    if (selectedWorktree !== undefined) params.set('worktree', selectedWorktree);
    window.history.pushState(null, '', `/settings?${params.toString()}`);
    setPageSurface('settings');
  };

  const openRoom = (): void => {
    window.history.pushState(null, '', roomUrl(root, selectedWorktree));
    setPageSurface('room');
  };

  // The connector owns global listeners and a socket; unmounting without
  // disposing leaves both alive to act on a page that no longer exists.
  useEffect(() => () => { connectorRef.current?.dispose(); }, []);

  useEffect(() => {
    // Hosted-computer changes move the public root: the manager remembers only
    // each session's public root, never a hidden selected child, so this room
    // is always a safe top-level target for the warm connector.
    if (!managed || managed.room === root) return;
    setSelectedWorktree(undefined);
    connection.switchRoom(managed.room);
    setRoot(managed.room);
    setRoom(managed.room);
    const path = window.location.pathname === '/settings' ? '/settings' : '/';
    window.history.replaceState(null, '', `${path}?room=${encodeURIComponent(managed.room)}`);
  }, [managed, root, connection]);

  useEffect(() => {
    const onPop = (): void => {
      // Back/forward reaches rooms, worktree selections, and Settings entries
      // this session already opened — without rewriting history. A top-level
      // entry moves the public root; a same-root entry only resolves the
      // selector through the group effect.
      const params = pageParams();
      const next = params.room;
      if (next !== undefined && next !== root) {
        connection.switchRoom(next);
        setRoot(next);
        setRoom(next);
        if (manager) manager.rememberActiveRoom(next);
        else rememberRoom(next);
      }
      setSelectedWorktree(params.worktree);
      setPageSurface(window.location.pathname === '/settings' ? 'settings' : 'room');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, manager, root]);

  // Lifecycle dialogs: one at a time, drafts preserved inside each dialog.
  const [worktreeDialog, setWorktreeDialog] = useState<
    'create' | 'find' | { child: RegisteredWorktree } | undefined
  >();
  const selfRole = useClientStore((state) => {
    const slice = roomSlice(state, root);
    return slice.selfMemberId !== undefined
      ? slice.members[slice.selfMemberId]?.role
      : undefined;
  });
  const canManageWorktrees = roleAtLeast(selfRole, 'admin');

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

  const worktreeDialogs = (
    <>
      {worktreeDialog === 'create' && (
        <WorktreeCreateDialog
          root={root}
          token={token}
          onClose={() => setWorktreeDialog(undefined)}
          onCreated={(worktree) => {
            setWorktreeDialog(undefined);
            void group.refresh().then(() => selectWorktree(worktree.id));
          }}
        />
      )}
      {worktreeDialog === 'find' && (
        <WorktreeFindDialog
          root={root}
          token={token}
          onClose={() => setWorktreeDialog(undefined)}
          onAdopted={(worktree) => {
            setWorktreeDialog(undefined);
            void group.refresh().then(() => selectWorktree(worktree.id));
          }}
        />
      )}
      {typeof worktreeDialog === 'object' && worktreeDialog !== undefined && (
        <WorktreeChildDialog
          root={root}
          token={token}
          child={worktreeDialog.child}
          onClose={() => setWorktreeDialog(undefined)}
          onChanged={() => void group.refresh()}
          onRemoved={() => {
            if (selectedWorktree === worktreeDialog.child.id) selectWorktree(undefined);
            void group.refresh();
          }}
        />
      )}
    </>
  );

  if (pageSurface === 'settings') {
    return (
      <SettingsPage
        room={room}
        token={activeToken}
        refreshToken={props.refreshToken}
        connection={connection}
        onBack={openRoom}
      />
    );
  }

  if (isMobile) {
    return (
      <div className="nx-app is-mobile" data-testid="app" data-surface={surface}>
        {surface === 'channels' ? (
          <ChannelRail
            activeRoom={root}
            token={token}
            onSwitch={(next) => {
              switchRoom(next);
              setSurface('room');
            }}
            onSettings={openSettings}
            group={{ root, view: group, selectedWorktree, canManage: canManageWorktrees }}
            readiness={(conversation) => connection.roomReadiness(conversation)}
            onSelectWorktree={(worktreeId) => {
              selectWorktree(worktreeId);
              setSurface('room');
            }}
            onOpenWorktreeDialog={setWorktreeDialog}
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
        {worktreeDialogs}
        {mobileContext && surface === 'room' && (
          <div className="nx-mobile-context" data-testid="mobile-context">
            <button className="nx-mobile-context-close nx-btn" onClick={() => setMobileContext(false)}>
              Close
            </button>
            <ContextPanel room={room} token={token} connection={connection} onOpenWorktreeDialog={setWorktreeDialog} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="nx-app" data-testid="app">
      <ChannelRail
        activeRoom={root}
        token={token}
        onSwitch={switchRoom}
        onSettings={openSettings}
        group={{ root, view: group, selectedWorktree, canManage: canManageWorktrees }}
        readiness={(conversation) => connection.roomReadiness(conversation)}
        onSelectWorktree={selectWorktree}
        onOpenWorktreeDialog={setWorktreeDialog}
      />
      <ChatPanel
        room={room}
        connection={connection}
        token={token}
        onContext={() => setResponsiveContext(true)}
      />
      <ContextPanel room={room} token={token} connection={connection} onOpenWorktreeDialog={setWorktreeDialog} />
      {worktreeDialogs}
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
  // harn:end settings-navigation-reuses-live-session
}

// ── Channel rail ─────────────────────────────────────────────────────────

function ChannelRail(props: {
  activeRoom: string;
  token: () => string;
  onSwitch: (room: string) => void;
  onSettings: () => void;
  group?: {
    root: string;
    view: ReturnType<typeof useWorktreeGroup>;
    selectedWorktree: string | undefined;
    canManage: boolean;
  };
  readiness?: (conversation: string) => 'connecting' | 'connected' | 'offline' | 'unsubscribed';
  onSelectWorktree?: (worktreeId: string | undefined) => void;
  onOpenWorktreeDialog?: (dialog: 'create' | 'find' | { child: RegisteredWorktree }) => void;
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
          // Main and a selected child never both claim the current page: while
          // one of this root's secondaries is selected, the child row alone
          // exposes aria-current and the root row stays a plain link.
          const childSelected = props.group?.root === entry.id
            && props.group.selectedWorktree !== undefined;
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
                aria-current={active && !childSelected ? 'page' : undefined}
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
              {props.group !== undefined
                && props.group.root === entry.id
                && props.onSelectWorktree !== undefined
                && props.onOpenWorktreeDialog !== undefined
                && props.readiness !== undefined && (
                <WorktreeGroupSection
                  root={entry.id}
                  token={props.token}
                  group={props.group.view}
                  selectedWorktree={props.group.selectedWorktree}
                  readiness={props.readiness}
                  canManage={props.group.canManage}
                  onSelect={props.onSelectWorktree}
                  onOpenDialog={props.onOpenWorktreeDialog}
                />
              )}
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
          <ComputerSwitcher />
        </span>
        <IconButton icon={Settings} label="Settings" variant="quiet" onClick={props.onSettings} />
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
