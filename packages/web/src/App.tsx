import type { Message } from '@wireroom/protocol';
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
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <Header
        roomName={state.room?.name ?? ROOM}
        connected={state.connected}
        meter={state.meter}
        unread={unreadCount(state)}
        config={state.room?.config}
        connection={connection}
      />
      <HoldBanner held={heldDeliveries(state.inbox)} handleOf={handles} connection={connection} />
      <div className="flex min-h-0 flex-1">
        <MemberRail
          members={Object.values(state.members)}
          details={memberDetails}
          history={state.memberHistory}
          adapters={adapters}
          connection={connection}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          <form
            data-testid="message-search"
            className="flex min-h-12 items-center gap-2 border-b border-zinc-800 px-4 py-2"
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
              className="min-w-0 flex-1 border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100"
            />
            <button
              type="submit"
              disabled={searching || searchQuery.trim() === ''}
              className="min-w-20 bg-sky-700 px-3 py-1 text-sm text-white disabled:opacity-40"
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
                className="border border-zinc-700 px-3 py-1 text-sm text-zinc-300"
              >
                Clear
              </button>
            )}
          </form>
          {searched && (
            <div data-testid="search-results" className="max-h-48 overflow-y-auto border-b border-zinc-800 bg-zinc-900 px-4 py-2">
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
          <div
            ref={timeline}
            data-testid="timeline"
            onScroll={(event) => {
              const node = event.currentTarget;
              stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
              if (node.scrollTop < 80) void loadOlder();
            }}
            className="flex-1 space-y-3 overflow-y-auto p-4"
          >
            <div className="flex h-6 items-center justify-center">
              {hasOlder && (
                <button
                  type="button"
                  data-testid="load-history"
                  disabled={historyBusy}
                  onClick={() => void loadOlder()}
                  className="text-xs text-zinc-500 hover:text-sky-300 disabled:opacity-50"
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
          <Composer members={state.members} messages={state.messages} connection={connection} />
        </main>
      </div>
    </div>
  );
}
// harn:end permalink-ids-stable
