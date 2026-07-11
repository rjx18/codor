import type { Message, Room } from '@wireroom/protocol';
import { Search, Settings, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  AskCardView,
  BridgedRoomBanner,
  Composer,
  Header,
  HoldBanner,
  MessageRow,
  RunMessageView,
  RunStallBadge,
  handleLookup,
  isMe,
} from './components.js';
import {
  fetchAdapters,
  fetchMessageHistory,
  fetchMemberDetails,
  fetchRooms,
  searchMessages,
  type AdapterRegistration,
  type MemberDetail,
} from './api.js';
import {
  heldDeliveries,
  HISTORY_PAGE_SIZE,
  me,
  roleAtLeast,
  sortedMessages,
  unreadCount,
  useRoomStore,
} from './state.js';
import { connect, type Connection } from './ws.js';
import { ContextRail, RoomList, RoomRail } from './shell.js';
import { currentBrowserAccessToken } from './crypto.js';
import type { RunRow } from './run-presenter.js';
function pageParams(): { room: string; token: string } {
  const params = new URLSearchParams(window.location.search);
  return { room: params.get('room') ?? 'default', token: params.get('token') ?? '' };
}

function fragmentMessageId(): number | undefined {
  const id = Number(window.location.hash.slice(1));
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

// harn:assume permalink-ids-stable ref=message-history-surface
export function App(props: {
  token?: string;
  refreshToken?: () => Promise<string>;
} = {}) {
  const state = useRoomStore();
  const page = useMemo(pageParams, []);
  const ROOM = page.room;
  const TOKEN = props.token ?? page.token;
  const accessToken = useCallback(() => currentBrowserAccessToken(TOKEN), [TOKEN]);
  const connectionRef = useRef<Connection | null>(null);
  if (connectionRef.current === null) {
    connectionRef.current = connect({
      room: ROOM,
      token: accessToken(),
      refreshToken: props.refreshToken,
    });
  }
  const connection = connectionRef.current;
  const [adapters, setAdapters] = useState<AdapterRegistration[]>([]);
  const [memberDetails, setMemberDetails] = useState<Record<string, MemberDetail>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Message[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [hasOlder, setHasOlder] = useState(true);
  const [historyError, setHistoryError] = useState(false);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextView, setContextView] = useState<'members' | 'run'>('members');
  const [selectedRunId, setSelectedRunId] = useState<number>();
  const [selectedRunEventIndex, setSelectedRunEventIndex] = useState<number>();
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const contextCloseRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!state.connected) return;
    let current = true;
    void fetchAdapters({ token: accessToken() })
      .then((items) => {
        if (current) setAdapters(items);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [accessToken, state.connected]);

  useEffect(() => {
    if (!state.connected) return;
    let current = true;
    void fetchRooms({ token: accessToken() })
      .then((items) => {
        if (current) setRooms(items);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [accessToken, state.connected]);

  useEffect(() => {
    if (!state.connected) return;
    let current = true;
    void fetchMemberDetails(ROOM, { token: accessToken() })
      .then((items) => {
        if (current) setMemberDetails(Object.fromEntries(items.map((item) => [item.member.id, item])));
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [ROOM, accessToken, state.connected, state.seq]);

  const messages = useMemo(() => sortedMessages(state.messages), [state.messages]);
  const handles = handleLookup(state.members);
  const timeline = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const historyBusyRef = useRef(false);
  const historyReady = useRef(false);
  const restoreScroll = useRef<{ height: number; top: number } | undefined>(undefined);
  const previousLastId = useRef(0);
  const handledHash = useRef('');
  const handledNotificationAction = useRef(false);

  useEffect(() => {
    if (!state.connected || state.seq === 0 || handledNotificationAction.current) return;
    const params = new URLSearchParams(window.location.search);
    const action = params.get('notification_action');
    const messageId = Number(params.get('msg_id'));
    if (
      (action !== 'mark_read' && action !== 'release_hold') ||
      !Number.isSafeInteger(messageId) ||
      messageId < 1
    ) {
      return;
    }
    const deliveryId = params.get('delivery_id');
    const delivery = (deliveryId ? state.inbox[deliveryId] : undefined) ??
      Object.values(state.inbox).find((candidate) =>
      candidate.message_id === messageId &&
      (action === 'release_hold'
        ? candidate.state === 'held'
        : candidate.state === 'consumed' && candidate.read_ts === undefined));
    handledNotificationAction.current = true;
    params.delete('notification_action');
    params.delete('msg_id');
    params.delete('delivery_id');
    const query = params.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
    );
    if (!delivery) return;
    const actionable = delivery.message_id === messageId && (
      action === 'release_hold'
        ? delivery.state === 'held'
        : delivery.state === 'consumed' && delivery.read_ts === undefined
    );
    if (!actionable) return;
    connection.act(action === 'release_hold'
      ? { act: 'release_hold', delivery_id: delivery.id }
      : { act: 'mark_read', delivery_id: delivery.id });
  }, [connection, state.connected, state.inbox, state.seq]);

  const loadOlder = useCallback(async () => {
    const first = messages[0];
    if (state.seq === 0 || historyBusyRef.current || !hasOlder || first === undefined) return;
    if (first.id <= 1) {
      setHasOlder(false);
      return;
    }
    historyBusyRef.current = true;
    setHistoryBusy(true);
    setHistoryError(false);
    const node = timeline.current;
    if (node) restoreScroll.current = { height: node.scrollHeight, top: node.scrollTop };
    try {
      const page = await fetchMessageHistory(
        ROOM,
        { before: first.id, limit: HISTORY_PAGE_SIZE },
        { token: accessToken() },
      );
      state.mergeHistory(page.messages);
      setHasOlder(page.has_more);
    } catch {
      restoreScroll.current = undefined;
      setHistoryError(true);
    } finally {
      historyBusyRef.current = false;
      setHistoryBusy(false);
    }
  }, [ROOM, accessToken, hasOlder, messages, state.mergeHistory, state.seq]);

  const revealMessage = useCallback(async (id: number) => {
    let found = state.messages[id] !== undefined;
    let before = messages[0]?.id ?? Number.MAX_SAFE_INTEGER;
    try {
      while (!found && before > id) {
        const page = await fetchMessageHistory(
          ROOM,
          { before, limit: HISTORY_PAGE_SIZE },
          { token: accessToken() },
        );
        if (page.messages.length === 0) break;
        state.mergeHistory(page.messages);
        found = page.messages.some((message) => message.id === id);
        const nextBefore = page.messages[0]!.id;
        setHasOlder(page.has_more);
        if (!page.has_more || nextBefore >= before) break;
        before = nextBefore;
      }
    } catch {
      setHistoryError(true);
      return;
    }
    if (!found) return;
    handledHash.current = String(id);
    if (window.location.hash !== `#${String(id)}`) window.location.hash = String(id);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.getElementById(String(id))?.scrollIntoView({ block: 'center' });
      });
    });
  }, [ROOM, accessToken, messages, state.messages, state.mergeHistory]);

  useLayoutEffect(() => {
    const node = timeline.current;
    if (!node) return;
    if (restoreScroll.current) {
      const prior = restoreScroll.current;
      restoreScroll.current = undefined;
      node.scrollTop = prior.top + node.scrollHeight - prior.height;
    } else {
      const lastId = messages.at(-1)?.id ?? 0;
      if (previousLastId.current === 0 || (lastId > previousLastId.current && stickToBottom.current)) {
        node.scrollTop = node.scrollHeight;
      }
      previousLastId.current = lastId;
    }
  }, [messages]);

  useEffect(() => {
    const node = timeline.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!stickToBottom.current || restoreScroll.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        node.scrollTop = node.scrollHeight;
      });
    });
    observer.observe(node);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (state.seq === 0) return;
    if (!historyReady.current) {
      historyReady.current = true;
      setHasOlder((messages[0]?.id ?? 1) > 1);
    }
    const node = timeline.current;
    if (hasOlder && node && node.scrollHeight <= node.clientHeight + 24) void loadOlder();
  }, [hasOlder, loadOlder, messages, state.seq]);

  useEffect(() => {
    const followHash = (): void => {
      if (state.seq === 0) return;
      const id = fragmentMessageId();
      if (id === undefined || handledHash.current === String(id)) return;
      handledHash.current = String(id);
      void revealMessage(id);
    };
    followHash();
    window.addEventListener('hashchange', followHash);
    return () => window.removeEventListener('hashchange', followHash);
  }, [revealMessage, state.seq]);

  const answeredCards = useMemo(() => {
    const answered = new Set<number>();
    for (const message of messages) {
      if (message.reply_to !== undefined) answered.add(message.reply_to);
    }
    return answered;
  }, [messages]);

  const roomItems = useMemo(
    () => rooms.length > 0 ? rooms : state.room ? [state.room] : [],
    [rooms, state.room],
  );
  const latestRun = useMemo(
    () => [...messages].reverse().find((message) => message.kind === 'run'),
    [messages],
  );
  const selectedRun = messages.find((message) => message.id === selectedRunId) ?? latestRun;
  const selectedRunLiveEvents = selectedRun
    ? state.runEvents[selectedRun.id] ?? { events: [], dropped_count: 0 }
    : { events: [], dropped_count: 0 };
  const selectedEventIndex = selectedRun?.id === selectedRunId
    ? selectedRunEventIndex
    : undefined;
  // harn:assume normalized-run-evidence-inspector ref=inspector-selection-state
  const inspectRun = (messageId: number, eventIndex?: number): void => {
    setSelectedRunId(messageId);
    setSelectedRunEventIndex(eventIndex);
    setContextView('run');
    if (!window.matchMedia('(min-width: 1360px)').matches) setContextOpen(true);
  };
  // harn:end normalized-run-evidence-inspector
  const owner = Object.values(state.members).find(
    (member) => member.kind === 'human' && member.role === 'owner',
  );
  // harn:assume roles-gate-human-acts-not-agents ref=role-aware-web-controls
  const self = me(state.members, state.selfMemberId);
  const canPost = roleAtLeast(self?.role, 'member');
  const canManageAgents = roleAtLeast(self?.role, 'admin');
  const canManageRooms = roleAtLeast(self?.role, 'owner');
  const held = heldDeliveries(state.inbox);

  useEffect(() => {
    if (!drawerOpen && !contextOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const target = drawerOpen ? drawerCloseRef.current : contextCloseRef.current;
    requestAnimationFrame(() => target?.focus());
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (document.querySelector('[data-testid="spawn-dialog"]')) return;
        setDrawerOpen(false);
        setContextOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const layer = drawerOpen
        ? document.querySelector<HTMLElement>('[data-testid="room-drawer"]')
        : document.querySelector<HTMLElement>('.wr-context-sheet');
      const focusable = [...(layer?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [])].filter((node) => node.offsetParent !== null);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', dismiss);
    return () => {
      window.removeEventListener('keydown', dismiss);
      previous?.focus();
    };
  }, [contextOpen, drawerOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    const close = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setSearchOpen(false);
      setSearchQuery('');
      setSearchResults([]);
      setSearched(false);
      requestAnimationFrame(() => document.getElementById('room-search-toggle')?.focus());
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [searchOpen]);

  // harn:assume web-room-visual-hierarchy-matches-restrained-reference ref=restrained-room-visual-hierarchy
  return (
    <div className="wr-canvas">
      <div className="wr-app-grid">
        <RoomRail
          rooms={roomItems}
          currentRoom={ROOM}
          currentUnread={unreadCount(state)}
          currentHeld={held.length}
          connected={state.connected}
          token={accessToken()}
          adapters={adapters}
          owner={owner ? { handle: owner.handle, display_name: owner.display_name } : undefined}
          canCreateRoom={canManageRooms}
        />
        <main data-testid="room-view" className="wr-room-main">
          <Header
            roomName={state.room?.name ?? ROOM}
            roomId={ROOM}
            roomColor={state.room?.config.color}
            token={accessToken()}
            connected={state.connected}
            meter={state.meter}
            unread={unreadCount(state)}
            memberCount={Object.values(state.members).filter((member) => member.kind !== 'system').length}
            searchOpen={searchOpen}
            onToggleSearch={() => {
              setSearchOpen((open) => !open);
              if (searchOpen) {
                setSearchQuery('');
                setSearchResults([]);
                setSearched(false);
              }
            }}
            onOpenNavigation={() => setDrawerOpen(true)}
            onOpenContext={() => {
              setContextView('members');
              setContextOpen(true);
            }}
          />
          {state.room?.config.bridged && <BridgedRoomBanner />}
          {!state.connected && (
            <div role="status" data-testid="offline-banner" className="wr-offline-banner">
              Offline · room history stays on your switchboard
            </div>
          )}
          <HoldBanner
            held={held}
            handleOf={handles}
            connection={connection}
            canRelease={canPost}
            canRedeliver={canManageAgents}
          />
          {searchOpen && (
            <form
              id="room-message-search"
              data-testid="message-search"
              className="wr-search"
              onSubmit={(event) => {
                event.preventDefault();
                const query = searchQuery.trim();
                if (query === '') return;
                setSearching(true);
                setSearched(true);
                void searchMessages(ROOM, query, { token: accessToken() })
                  .then(setSearchResults)
                  .catch(() => setSearchResults([]))
                  .finally(() => setSearching(false));
              }}
            >
              <Search aria-hidden="true" size={17} />
              <label htmlFor="room-search" className="sr-only">Search messages</label>
              <input
                id="room-search"
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search room history"
                className="wr-search-input"
                autoFocus
              />
              <button
                type="submit"
                aria-label="Search"
                title="Search"
                disabled={searching || searchQuery.trim() === ''}
                className="wr-icon-button"
              >
                <Search aria-hidden="true" size={16} />
                <span className="sr-only">{searching ? 'Searching' : 'Search'}</span>
              </button>
              <button
                type="button"
                aria-label="Close message search"
                title="Close search"
                onClick={() => {
                  setSearchOpen(false);
                  setSearchQuery('');
                  setSearchResults([]);
                  setSearched(false);
                  requestAnimationFrame(() => document.getElementById('room-search-toggle')?.focus());
                }}
                className="wr-icon-button"
              >
                <X aria-hidden="true" size={16} />
              </button>
            </form>
          )}
          {searched && (
            <div data-testid="search-results" className="wr-search-results">
              <p>{searchResults.length} matches</p>
              <ol>
                {searchResults.map((message) => (
                  <li key={message.id}>
                    <a
                      href={`#${message.id}`}
                      onClick={(event) => {
                        event.preventDefault();
                        void revealMessage(message.id);
                      }}
                    >
                      #{message.id}
                    </a>
                    <span>@{handles(message.author)}</span>
                    <span>{message.body || `(${message.kind})`}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {/* harn:assume sw-caches-shell-only-no-message-data ref=page-memory-message-cache */}
          <div
            ref={timeline}
            data-testid="timeline"
            aria-label="Room conversation"
            tabIndex={0}
            onScroll={(event) => {
              const node = event.currentTarget;
              if (node.scrollHeight - node.scrollTop - node.clientHeight < 80) {
                stickToBottom.current = true;
              }
              if (node.scrollTop < 80) void loadOlder();
            }}
            onWheel={(event) => {
              if (event.deltaY < 0) stickToBottom.current = false;
            }}
            onTouchMove={() => {
              stickToBottom.current = false;
            }}
            onPointerDown={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              if (event.clientX >= bounds.right - 18) stickToBottom.current = false;
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
                stickToBottom.current = false;
              }
            }}
            className="wr-timeline"
          >
            <div className="wr-history-control">
              {hasOlder && (
                <button
                  type="button"
                  data-testid="load-history"
                  disabled={historyBusy}
                  onClick={() => void loadOlder()}
                  className="wr-secondary-button min-h-11 px-3 text-xs disabled:opacity-50"
                >
                  {historyBusy ? 'Loading' : 'Load earlier'}
                </button>
              )}
              {historyError && <span role="status">History unavailable</span>}
            </div>
            {messages.map((message) => {
              if (message.kind === 'run') {
                return (
                  <div key={message.id} className="wr-timeline-run">
                    <RunStallBadge message={message} />
                    <RunMessageView
                      message={message}
                      authorHandle={handles(message.author)}
                      liveEvents={state.runEvents[message.id] ?? { events: [], dropped_count: 0 }}
                      room={ROOM}
                      token={accessToken()}
                      selectedEventIndex={selectedRunId === message.id ? selectedRunEventIndex : undefined}
                      onInspect={() => inspectRun(message.id)}
                      onInspectRow={(row: RunRow) => inspectRun(message.id, row.eventIndex)}
                    />
                  </div>
                );
              }
              if (message.kind === 'ask' || message.kind === 'approval') {
                return (
                  <AskCardView
                    key={message.id}
                    message={message}
                    authorHandle={handles(message.author)}
                    answered={answeredCards.has(message.id)}
                    connection={connection}
                    canAnswer={canPost && self !== undefined && Object.values(state.inbox).some(
                      (delivery) => delivery.message_id === message.id && delivery.recipient === self.id,
                    )}
                  />
                );
              }
              return (
                <MessageRow
                  key={message.id}
                  message={message}
                  authorHandle={handles(message.author)}
                  mine={isMe(state.members, message.author, state.selfMemberId)}
                  token={accessToken()}
                />
              );
            })}
          </div>
          {/* harn:end sw-caches-shell-only-no-message-data */}
          {canPost ? (
            <Composer
              members={state.members}
              messages={state.messages}
              defaultRecipientId={state.latestFinalizedAgentId}
              connection={connection}
            />
          ) : (
            <div data-testid="read-only-room" className="wr-read-only-room">
              Observer access · room commands are read-only
            </div>
          )}
        </main>
        <ContextRail
          members={Object.values(state.members)}
          details={memberDetails}
          history={state.memberHistory}
          adapters={adapters}
          connection={connection}
          selectedRun={selectedRun}
          selectedRunAuthor={selectedRun ? handles(selectedRun.author) : ''}
          selectedRunLiveEvents={selectedRunLiveEvents}
          selectedEventIndex={selectedEventIndex}
          view={contextView}
          onView={setContextView}
          room={ROOM}
          token={accessToken()}
          className="wr-context-desktop"
          canManageAgents={canManageAgents}
        />
      </div>

      {drawerOpen && (
        <div className="wr-drawer-layer">
          <button
            type="button"
            aria-label="Close rooms"
            className="wr-layer-scrim"
            onClick={() => setDrawerOpen(false)}
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Rooms"
            data-testid="room-drawer"
            className="wr-mobile-drawer"
          >
            <div className="wr-drawer-header">
              <strong>Rooms</strong>
              <button
                ref={drawerCloseRef}
                type="button"
                aria-label="Close rooms"
                title="Close"
                onClick={() => setDrawerOpen(false)}
                className="wr-icon-button"
              >
                <X aria-hidden="true" size={20} />
              </button>
            </div>
            <RoomList
              rooms={roomItems}
              currentRoom={ROOM}
              currentUnread={unreadCount(state)}
              currentHeld={held.length}
              connected={state.connected}
              token={accessToken()}
              adapters={adapters}
              owner={owner ? { handle: owner.handle, display_name: owner.display_name } : undefined}
              canCreateRoom={canManageRooms}
              onNavigate={() => setDrawerOpen(false)}
            />
            <div className="wr-drawer-footer">
              <span className={`wr-presence ${state.connected ? 'is-live' : ''}`} aria-hidden="true" />
              <span>
                <strong>{owner?.display_name ?? 'Local switchboard'}</strong>
                <small>{state.connected ? 'Local switchboard · Connected' : 'Local switchboard · Reconnecting'}</small>
              </span>
              <a
                href={`/settings?${new URLSearchParams({ room: ROOM }).toString()}`}
                aria-label="Open settings"
                title="Settings"
                className="wr-icon-button"
              >
                <Settings aria-hidden="true" size={18} />
              </a>
            </div>
          </aside>
        </div>
      )}

      {contextOpen && (
        <div className="wr-context-layer">
          <button
            type="button"
            aria-label="Close room context"
            className="wr-layer-scrim"
            onClick={() => setContextOpen(false)}
          />
          <section role="dialog" aria-modal="true" aria-label="Room context" className="wr-context-sheet">
            <div className="wr-drawer-header">
              <strong>Room context</strong>
              <button
                ref={contextCloseRef}
                type="button"
                aria-label="Close room context"
                title="Close"
                onClick={() => setContextOpen(false)}
                className="wr-icon-button"
              >
                <X aria-hidden="true" size={20} />
              </button>
            </div>
            <ContextRail
              members={Object.values(state.members)}
              details={memberDetails}
              history={state.memberHistory}
              adapters={adapters}
              connection={connection}
              selectedRun={selectedRun}
              selectedRunAuthor={selectedRun ? handles(selectedRun.author) : ''}
              selectedRunLiveEvents={selectedRunLiveEvents}
              selectedEventIndex={selectedEventIndex}
              view={contextView}
              onView={setContextView}
              room={ROOM}
              token={accessToken()}
              testId="context-sheet"
              className="min-h-0 flex-1"
              canManageAgents={canManageAgents}
            />
          </section>
        </div>
      )}
    </div>
  );
  // harn:end web-room-visual-hierarchy-matches-restrained-reference
  // harn:end roles-gate-human-acts-not-agents
}
// harn:end permalink-ids-stable
