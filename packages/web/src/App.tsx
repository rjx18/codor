import { useEffect, useMemo, useRef } from 'react';

import {
  AskCardView,
  Composer,
  Header,
  HoldBanner,
  MessageRow,
  MemberRail,
  RunMessageView,
  handleLookup,
  isMe,
} from './components.js';
import { heldDeliveries, sortedMessages, unreadCount, useRoomStore } from './state.js';
import { connect, type Connection } from './ws.js';

function pageParams(): { room: string; token: string } {
  const params = new URLSearchParams(window.location.search);
  return { room: params.get('room') ?? 'default', token: params.get('token') ?? '' };
}

export function App() {
  const state = useRoomStore();
  const { room: ROOM, token: TOKEN } = useMemo(pageParams, []);
  const connectionRef = useRef<Connection | null>(null);
  if (connectionRef.current === null) {
    connectionRef.current = connect({ room: ROOM, token: TOKEN });
  }
  const connection = connectionRef.current;

  const messages = useMemo(() => sortedMessages(state.messages), [state.messages]);
  const handles = handleLookup(state.members);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, state.seq]);

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
      />
      <HoldBanner held={heldDeliveries(state.inbox)} handleOf={handles} connection={connection} />
      <div className="flex min-h-0 flex-1">
        <MemberRail members={Object.values(state.members)} />
        <main className="flex min-w-0 flex-1 flex-col">
          <div data-testid="timeline" className="flex-1 space-y-3 overflow-y-auto p-4">
            {messages.map((message) => {
              if (message.kind === 'run') {
                return (
                  <RunMessageView
                    key={message.id}
                    message={message}
                    authorHandle={handles(message.author)}
                    liveEventCount={state.runEvents[message.id]?.length ?? 0}
                    room={ROOM}
                    token={TOKEN}
                  />
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
            <div ref={bottom} />
          </div>
          <Composer members={state.members} messages={state.messages} connection={connection} />
        </main>
      </div>
    </div>
  );
}
