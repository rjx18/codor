import type { Member, Message, Room, WireEvent } from '@wireroom/protocol';
import {
  Activity,
  Cable,
  ChevronRight,
  Clock3,
  ExternalLink,
  Hash,
  Settings,
  Users,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { fetchRunEvents, type AdapterRegistration, type MemberDetail } from './api.js';
import { MemberRail } from './components.js';
import type { MemberStateObservation } from './state.js';
import type { Connection } from './ws.js';

function roomHref(room: string): string {
  return `/?${new URLSearchParams({ room }).toString()}`;
}

export function RoomList(props: {
  rooms: Room[];
  currentRoom: string;
  currentUnread: number;
  connected: boolean;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Rooms" className="wr-room-list">
      <div className="wr-rail-label">
        <span>Rooms</span>
        <span>{props.rooms.length}</span>
      </div>
      <ul>
        {props.rooms.map((room) => {
          const selected = room.id === props.currentRoom;
          return (
            <li key={room.id}>
              <a
                href={roomHref(room.id)}
                data-testid={`room-link-${room.id}`}
                aria-current={selected ? 'page' : undefined}
                className="wr-room-link"
                onClick={props.onNavigate}
              >
                <span className="wr-room-glyph" aria-hidden="true">
                  <Hash size={18} strokeWidth={1.8} />
                </span>
                <span className="wr-room-copy">
                  <strong title={room.name}>{room.name}</strong>
                  <small>
                    {selected ? (props.connected ? 'Live on this switchboard' : 'Offline') : 'Room'}
                  </small>
                </span>
                {selected && props.currentUnread > 0 ? (
                  <span className="wr-count" aria-label={`${String(props.currentUnread)} unread`}>
                    {props.currentUnread}
                  </span>
                ) : (
                  <ChevronRight className="wr-room-chevron" aria-hidden="true" size={15} />
                )}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// harn:assume web-shell-responsive-three-pane ref=responsive-room-shell
export function RoomRail(props: {
  rooms: Room[];
  currentRoom: string;
  currentUnread: number;
  connected: boolean;
}) {
  return (
    <aside data-testid="room-rail" className="wr-room-rail">
      <div className="wr-brand">
        <span className="wr-brand-mark" aria-hidden="true"><Cable size={21} /></span>
        <strong>Wireroom</strong>
        <kbd>⌘K</kbd>
      </div>
      <RoomList {...props} />
      <div className="wr-rail-footer">
        <span className={`wr-presence ${props.connected ? 'is-live' : ''}`} aria-hidden="true" />
        <span>
          <strong>Local switchboard</strong>
          <small>{props.connected ? 'Connected' : 'Reconnecting'}</small>
        </span>
        <a
          href={`/settings?${new URLSearchParams({ room: props.currentRoom }).toString()}`}
          aria-label="Open settings from room rail"
          title="Settings"
          className="wr-icon-button"
        >
          <Settings aria-hidden="true" size={18} />
        </a>
      </div>
    </aside>
  );
}

function eventLabel(event: WireEvent): string {
  if (event.type === 'run.item') return event.item_type.replaceAll('_', ' ');
  if (event.type === 'extension.started') return 'extension started';
  if (event.type === 'extension.ended') return 'extension finished';
  return event.type.replaceAll('.', ' ');
}

function RunContext(props: {
  message: Message;
  authorHandle: string;
  room: string;
  token: string;
}) {
  const [events, setEvents] = useState<WireEvent[]>();
  const [failed, setFailed] = useState(false);
  const run = props.message.run!;

  useEffect(() => {
    let current = true;
    setEvents(undefined);
    setFailed(false);
    void fetchRunEvents(props.room, props.message.id, { token: props.token })
      .then((items) => {
        if (current) setEvents(items);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [props.message.id, props.room, props.token]);

  const tokenTotal = run.usage
    ? run.usage.input_tokens + run.usage.output_tokens
    : undefined;

  return (
    <section className="wr-run-context" aria-label={`Run ${String(props.message.id)} context`}>
      <div className="wr-context-heading">
        <span className="wr-run-symbol" aria-hidden="true"><Activity size={17} /></span>
        <div>
          <strong>#{props.message.id} @{props.authorHandle}</strong>
          <small>{run.status}</small>
        </div>
        <a href={`#${String(props.message.id)}`} className="wr-icon-button" aria-label={`Open run ${String(props.message.id)} in conversation`}>
          <ExternalLink aria-hidden="true" size={16} />
        </a>
      </div>
      <dl className="wr-context-facts">
        <dt>Status</dt><dd>{run.status}</dd>
        <dt>Started</dt><dd><Clock3 aria-hidden="true" size={13} /> {new Date(run.started_ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</dd>
        <dt>Tokens</dt><dd>{tokenTotal === undefined ? '-' : tokenTotal.toLocaleString()}</dd>
        <dt>Spend</dt><dd>{run.usage?.cost_usd === undefined ? 'not reported' : `$${run.usage.cost_usd.toFixed(2)}`}</dd>
        <dt>Tools</dt><dd>{run.tool_calls}</dd>
      </dl>
      <div className="wr-context-events">
        <div className="wr-rail-label"><span>Recent evidence</span><span>{events?.length ?? 0}</span></div>
        {failed ? (
          <p role="status">Evidence unavailable</p>
        ) : events === undefined ? (
          <p role="status">Loading evidence</p>
        ) : events.length === 0 ? (
          <p>No journaled events</p>
        ) : (
          <ol>
            {events.slice(-6).reverse().map((event, index) => (
              <li key={`${event.type}-${String(index)}`}>
                <span aria-hidden="true" />
                <div>
                  <strong>{eventLabel(event)}</strong>
                  {event.type === 'run.item' && <small>{JSON.stringify(event.payload).slice(0, 96)}</small>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

export function ContextRail(props: {
  members: Member[];
  details: Record<string, MemberDetail>;
  history: Record<string, MemberStateObservation[]>;
  adapters: AdapterRegistration[];
  connection: Connection;
  latestRun: Message | undefined;
  latestRunAuthor: string;
  room: string;
  token: string;
  testId?: string;
  className?: string;
}) {
  const [view, setView] = useState<'members' | 'run'>('members');
  return (
    <aside data-testid={props.testId ?? 'context-rail'} className={`wr-context-rail ${props.className ?? ''}`}>
      <div className="wr-context-tabs" role="tablist" aria-label="Room context">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'members'}
          onClick={() => setView('members')}
        >
          <Users aria-hidden="true" size={16} /> Members
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'run'}
          disabled={!props.latestRun}
          onClick={() => setView('run')}
        >
          <Activity aria-hidden="true" size={16} /> Run
        </button>
      </div>
      {view === 'members' || !props.latestRun ? (
        <MemberRail
          members={props.members}
          details={props.details}
          history={props.history}
          adapters={props.adapters}
          connection={props.connection}
          variant="context"
          className="min-h-0 flex-1"
        />
      ) : (
        <RunContext
          message={props.latestRun}
          authorHandle={props.latestRunAuthor}
          room={props.room}
          token={props.token}
        />
      )}
    </aside>
  );
}
// harn:end web-shell-responsive-three-pane
