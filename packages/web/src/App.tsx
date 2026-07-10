import type { Message, Room } from '@wireroom/protocol';
import { X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  AskCardView,
  Composer,
  Header,
  HoldBanner,
  MessageRow,
  MemberRail,
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
  sortedMessages,
  unreadCount,
  useRoomStore,
} from './state.js';
import { connect, type Connection } from './ws.js';

function pageParams(): { room: string; token: string } {
  const params = new URLSearchParams(window.location.search);
  return { room: params.get('room') ?? 'default', token: params.get('token') ?? '' };
}

function fragmentMessageId(): number | undefined {
  const id = Number(window.location.hash.slice(1));
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

// harn:assume permalink-ids-stable ref=message-history-surface
export function App() {
  const state = useRoomStore();
  const { room: ROOM, token: TOKEN } = useMemo(pageParams, []);
  const connectionRef = useRef<Connection | null>(null);
  if (connectionRef.current === null) {
    connectionRef.current = connect({ room: ROOM, token: TOKEN });
  }
  const connection = connectionRef.current;
  const [adapters, setAdapters] = useState<AdapterRegistration[]>([]);
  const [memberDetails, setMemberDetails] = useState<Record<string, MemberDetail>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Message[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [hasOlder, setHasOlder] = useState(true);
  const [historyError, setHistoryError] = useState(false);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    let current = true;
    void fetchAdapters({ token: TOKEN })
      .then((items) => {
        if (current) setAdapters(items);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [TOKEN]);

  useEffect(() => {
    let current = true;
    void fetchRooms({ token: TOKEN })
      .then((items) => {
        if (current) setRooms(items);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [TOKEN]);

  useEffect(() => {
    if (!state.connected) return;
    let current = true;
    void fetchMemberDetails(ROOM, { token: TOKEN })
      .then((items) => {
        if (current) setMemberDetails(Object.fromEntries(items.map((item) => [item.member.id, item])));
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [ROOM, TOKEN, state.connected, state.seq]);

  const messages = useMemo(() => sortedMessages(state.messages), [state.messages]);
  const handles = handleLookup(state.members);
  const timeline = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const historyBusyRef = useRef(false);
  const historyReady = useRef(false);
  const restoreScroll = useRef<{ height: number; top: number } | undefined>(undefined);
  const previousLastId = useRef(0);
  const handledHash = useRef('');

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
        { token: TOKEN },
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
  }, [ROOM, TOKEN, hasOlder, messages, state.mergeHistory, state.seq]);

  const revealMessage = useCallback(async (id: number) => {
    let found = state.messages[id] !== undefined;
    let before = messages[0]?.id ?? Number.MAX_SAFE_INTEGER;
    try {
      while (!found && before > id) {
        const page = await fetchMessageHistory(
          ROOM,
          { before, limit: HISTORY_PAGE_SIZE },
          { token: TOKEN },
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
  }, [ROOM, TOKEN, messages, state.messages, state.mergeHistory]);

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

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <Header
        roomName={state.room?.name ?? ROOM}
        connected={state.connected}
        meter={state.meter}
        unread={unreadCount(state)}
        config={state.room?.config}
        connection={connection}
        onOpenNavigation={() => setDrawerOpen(true)}
      />
      {!state.connected && (
        <div
          role="status"
          data-testid="offline-banner"
          className="border-b border-zinc-700 bg-zinc-900 px-3 py-2 text-center text-xs text-zinc-300"
        >
          Offline · room history stays on your switchboard
        </div>
      )}
      <HoldBanner held={heldDeliveries(state.inbox)} handleOf={handles} connection={connection} />
      <div className="flex min-h-0 flex-1">
        <div className="hidden min-h-0 lg:block">
          <MemberRail
            members={Object.values(state.members)}
            details={memberDetails}
            history={state.memberHistory}
            adapters={adapters}
            connection={connection}
            className="h-full"
          />
        </div>
        <main data-testid="room-view" className="flex min-w-0 flex-1 flex-col bg-zinc-950">
          <form
            data-testid="message-search"
            className="mx-auto flex min-h-14 w-full max-w-4xl items-center gap-2 border-b border-zinc-800 px-3 py-2 sm:px-4"
            onSubmit={(event) => {
              event.preventDefault();
              const query = searchQuery.trim();
              if (query === '') return;
              setSearching(true);
              setSearched(true);
              void searchMessages(ROOM, query, { token: TOKEN })
                .then(setSearchResults)
                .catch(() => setSearchResults([]))
                .finally(() => setSearching(false));
            }}
          >
            <label htmlFor="room-search" className="sr-only">Search messages</label>
            <input
              id="room-search"
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search messages"
              className="min-h-11 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-base text-zinc-100 outline-none focus:border-sky-600 sm:text-sm"
            />
            <button
              type="submit"
              disabled={searching || searchQuery.trim() === ''}
              className="min-h-11 min-w-20 rounded-md bg-sky-700 px-3 text-sm text-white disabled:opacity-40"
            >
              {searching ? 'Searching' : 'Search'}
            </button>
            {searched && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setSearchResults([]);
                  setSearched(false);
                }}
                className="min-h-11 rounded-md border border-zinc-700 px-3 text-sm text-zinc-300"
              >
                Clear
              </button>
            )}
          </form>
          {searched && (
            <div data-testid="search-results" className="mx-auto max-h-48 w-full max-w-4xl overflow-y-auto border-b border-zinc-800 bg-zinc-900 px-4 py-2">
              <p className="mb-1 text-xs text-zinc-500">{searchResults.length} matches</p>
              <ol className="space-y-1">
                {searchResults.map((message) => (
                  <li key={message.id} className="flex min-w-0 gap-2 text-xs">
                    <a
                      href={`#${message.id}`}
                      onClick={(event) => {
                        event.preventDefault();
                        void revealMessage(message.id);
                      }}
                      className="shrink-0 text-sky-300 hover:text-sky-200"
                    >
                      #{message.id}
                    </a>
                    <span className="shrink-0 text-zinc-400">@{handles(message.author)}</span>
                    <span className="truncate text-zinc-200">{message.body || `(${message.kind})`}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {/* harn:assume sw-caches-shell-only-no-message-data ref=page-memory-message-cache */}
          <div
            ref={timeline}
            data-testid="timeline"
            onScroll={(event) => {
              const node = event.currentTarget;
              stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
              if (node.scrollTop < 80) void loadOlder();
            }}
            className="mx-auto w-full max-w-4xl flex-1 space-y-2 overflow-y-auto px-3 py-4 sm:space-y-3 sm:px-5"
          >
            <div className="flex h-6 items-center justify-center">
              {hasOlder && (
                <button
                  type="button"
                  data-testid="load-history"
                  disabled={historyBusy}
                  onClick={() => void loadOlder()}
                  className="min-h-11 px-3 text-xs text-zinc-500 hover:text-sky-300 disabled:opacity-50"
                >
                  {historyBusy ? 'Loading' : 'Load earlier'}
                </button>
              )}
              {historyError && <span className="text-xs text-red-400">History unavailable</span>}
            </div>
            {messages.map((message) => {
              if (message.kind === 'run') {
                return (
                  <div key={message.id}>
                    <RunStallBadge message={message} />
                    <RunMessageView
                      message={message}
                      authorHandle={handles(message.author)}
                      liveEventCount={state.runEvents[message.id]?.length ?? 0}
                      room={ROOM}
                      token={TOKEN}
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
                  />
                );
              }
              return (
                <MessageRow
                  key={message.id}
                  message={message}
                  authorHandle={handles(message.author)}
                  mine={isMe(state.members, message.author)}
                />
              );
            })}
          </div>
          {/* harn:end sw-caches-shell-only-no-message-data */}
          <Composer members={state.members} messages={state.messages} connection={connection} />
        </main>
      </div>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close rooms and members"
            className="absolute inset-0 h-full w-full bg-black/75"
            onClick={() => setDrawerOpen(false)}
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Rooms and members"
            data-testid="room-drawer"
            className="relative flex h-full w-[min(88vw,24rem)] flex-col border-r border-zinc-700 bg-zinc-950 shadow-2xl"
          >
            <div className="flex min-h-16 items-center border-b border-zinc-800 px-4">
              <strong className="text-lg font-semibold text-zinc-100">Wireroom</strong>
              <button
                type="button"
                aria-label="Close rooms and members"
                title="Close"
                onClick={() => setDrawerOpen(false)}
                className="ml-auto inline-flex h-11 w-11 items-center justify-center text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              >
                <X aria-hidden="true" size={22} />
              </button>
            </div>
            <nav aria-label="Rooms" className="border-b border-zinc-800 p-3">
              <p className="px-2 pb-2 text-[11px] font-medium uppercase text-zinc-500">Rooms</p>
              <ul className="space-y-1">
                {(rooms.length > 0 ? rooms : state.room ? [state.room] : []).map((room) => {
                  const selected = room.id === ROOM;
                  const query = new URLSearchParams({ room: room.id });
                  if (TOKEN !== '') query.set('token', TOKEN);
                  return (
                    <li key={room.id}>
                      <a
                        href={`/?${query.toString()}`}
                        data-testid={`room-link-${room.id}`}
                        aria-current={selected ? 'page' : undefined}
                        className={`flex min-h-14 items-center border-l-2 px-3 text-sm ${
                          selected
                            ? 'border-sky-400 bg-zinc-900 text-zinc-100'
                            : 'border-transparent text-zinc-300 hover:bg-zinc-900'
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate font-medium">{room.name}</span>
                        {selected && unreadCount(state) > 0 && (
                          <span className="ml-3 text-xs font-semibold text-sky-300">{unreadCount(state)}</span>
                        )}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </nav>
            <MemberRail
              members={Object.values(state.members)}
              details={memberDetails}
              history={state.memberHistory}
              adapters={adapters}
              connection={connection}
              className="min-h-0 w-full flex-1 border-r-0 pb-[max(1rem,env(safe-area-inset-bottom))]"
            />
          </aside>
        </div>
      )}
    </div>
  );
}
// harn:end permalink-ids-stable
