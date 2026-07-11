import type { Member, Message, Room, WireEvent } from '@wireroom/protocol';
import {
  Activity,
  ChevronRight,
  Clock3,
  ExternalLink,
  Plus,
  Settings,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { createRoom, fetchRunEvents, type AdapterRegistration, type MemberDetail } from './api.js';
import { MemberRail } from './components.js';
import type { MemberStateObservation } from './state.js';
import type { Connection } from './ws.js';

function roomHref(room: string): string {
  return `/?${new URLSearchParams({ room }).toString()}`;
}

// harn:assume web-room-rail-creates-owner-room ref=room-rail-create-action
export function RoomList(props: {
  rooms: Room[];
  currentRoom: string;
  currentUnread: number;
  currentHeld: number;
  connected: boolean;
  token?: string;
  owner?: { handle: string; display_name: string };
  onNavigate?: () => void;
  canCreateRoom?: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [roomId, setRoomId] = useState('');
  const [roomName, setRoomName] = useState('');
  const [createError, setCreateError] = useState<string>();
  const [createBusy, setCreateBusy] = useState(false);
  const firstCreateField = useRef<HTMLInputElement>(null);
  const createTrigger = useRef<HTMLButtonElement>(null);
  const createDialog = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!creating) return;
    requestAnimationFrame(() => firstCreateField.current?.focus());
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setCreating(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...(createDialog.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [])];
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
    document.addEventListener('keydown', close, true);
    return () => {
      document.removeEventListener('keydown', close, true);
      createTrigger.current?.focus();
    };
  }, [creating]);

  return (
    <nav aria-label="Rooms" className="wr-room-list">
      <div className="wr-rail-label">
        <span>Rooms</span>
        {props.token && props.owner && (props.canCreateRoom ?? true) ? (
          <button
            ref={createTrigger}
            type="button"
            data-testid="create-room"
            aria-label="Create room"
            title="Create room"
            className="wr-rail-action"
            onClick={() => {
              setCreateError(undefined);
              setCreating(true);
            }}
          >
            <Plus aria-hidden="true" size={16} />
          </button>
        ) : <span>{props.rooms.length}</span>}
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
                <span className={`wr-room-dot ${selected && props.connected ? 'is-live' : ''}`} aria-hidden="true" />
                <span className="wr-room-copy">
                  <strong title={room.name}>{room.name}</strong>
                  <small>
                    {selected ? (props.connected ? 'Live on this switchboard' : 'Offline') : 'Room'}
                  </small>
                </span>
                <span className="wr-room-marks">
                  {selected && props.currentHeld > 0 && (
                    <span className="wr-hold-mark" aria-label={`${String(props.currentHeld)} held`} title={`${String(props.currentHeld)} held`}>
                      {props.currentHeld}
                    </span>
                  )}
                  {selected && props.currentUnread > 0 ? (
                    <span className="wr-count" aria-label={`${String(props.currentUnread)} unread`}>
                      {props.currentUnread}
                    </span>
                  ) : (
                    <ChevronRight className="wr-room-chevron" aria-hidden="true" size={15} />
                  )}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
      {creating && props.token && props.owner && (props.canCreateRoom ?? true) && (
        <div className="wr-modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close create room"
            className="wr-layer-scrim"
            onClick={() => setCreating(false)}
          />
          <form
            ref={createDialog}
            role="dialog"
            aria-modal="true"
            aria-label="Create room"
            data-testid="create-room-dialog"
            className="wr-focused-glass relative z-10 w-full max-w-md p-5"
            onSubmit={(event) => {
              event.preventDefault();
              setCreateError(undefined);
              setCreateBusy(true);
              void createRoom({
                id: roomId,
                name: roomName,
                owner: props.owner!,
              }, { token: props.token! }).then(
                (room) => window.location.assign(roomHref(room.id)),
                () => setCreateError('Room could not be created. Check the id and try again.'),
              ).finally(() => setCreateBusy(false));
            }}
          >
            <div className="wr-dialog-heading">
              <div>
                <h2>Create room</h2>
                <p>A private room on this switchboard.</p>
              </div>
              <button type="button" aria-label="Close create room" className="wr-icon-button" onClick={() => setCreating(false)}>
                <X aria-hidden="true" size={18} />
              </button>
            </div>
            <label className="wr-field-label">
              Room id
              <input
                ref={firstCreateField}
                data-testid="create-room-id"
                value={roomId}
                onChange={(event) => setRoomId(event.target.value)}
                pattern="[a-z0-9][a-z0-9-]{0,62}"
                placeholder="release-train"
                required
                className="wr-input min-h-11 px-3"
              />
            </label>
            <label className="wr-field-label">
              Name
              <input
                data-testid="create-room-name"
                value={roomName}
                onChange={(event) => setRoomName(event.target.value)}
                placeholder="Release train"
                required
                className="wr-input min-h-11 px-3"
              />
            </label>
            {createError && <p role="alert" className="wr-form-error">{createError}</p>}
            <div className="wr-dialog-actions">
              <button type="button" className="wr-secondary-button min-h-11 px-4" onClick={() => setCreating(false)}>Cancel</button>
              <button type="submit" data-testid="create-room-submit" disabled={createBusy} className="wr-primary-button min-h-11 px-4">
                {createBusy ? 'Creating' : 'Create room'}
              </button>
            </div>
          </form>
        </div>
      )}
    </nav>
  );
}
// harn:end web-room-rail-creates-owner-room

// harn:assume web-shell-responsive-three-pane ref=responsive-room-shell
export function RoomRail(props: {
  rooms: Room[];
  currentRoom: string;
  currentUnread: number;
  currentHeld: number;
  connected: boolean;
  token: string;
  owner: { handle: string; display_name: string } | undefined;
  canCreateRoom?: boolean;
}) {
  return (
    <aside data-testid="room-rail" className="wr-room-rail">
      <div className="wr-brand">
        <span className="wr-brand-copy">
          <strong>Wireroom</strong>
        </span>
      </div>
      <RoomList {...props} />
      <div className="wr-rail-footer">
        <span className={`wr-presence ${props.connected ? 'is-live' : ''}`} aria-hidden="true" />
        <span>
          <strong>{props.owner?.display_name ?? 'Local switchboard'}</strong>
          <small>{props.connected ? 'Local switchboard · Connected' : 'Local switchboard · Reconnecting'}</small>
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

function eventDetail(event: WireEvent): string | undefined {
  if (event.type === 'extension.started') return event.description;
  if (event.type === 'extension.ended') return event.summary;
  if (event.type === 'run.completed') return event.final_text;
  if (event.type !== 'run.item') return undefined;
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null) {
    return typeof payload === 'string' || typeof payload === 'number' ? String(payload) : undefined;
  }
  const values = payload as Record<string, unknown>;
  for (const key of ['tool', 'command', 'path', 'change', 'summary', 'result']) {
    const value = values[key];
    if (typeof value === 'string' && value.trim() !== '') return value.slice(0, 96);
  }
  return undefined;
}

// harn:assume run-context-selects-and-follows-live-evidence ref=selected-live-run-context
function RunContext(props: {
  message: Message;
  authorHandle: string;
  room: string;
  token: string;
  liveEvents: WireEvent[];
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
  }, [props.message.id, props.room, props.token, run.status]);

  const tokenTotal = run.usage
    ? run.usage.input_tokens + run.usage.output_tokens
    : undefined;
  const evidence = props.liveEvents.length >= (events?.length ?? 0)
    ? props.liveEvents
    : events ?? [];

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
        <div className="wr-rail-label">
          <span>Recent evidence</span>
          <span data-testid="context-evidence-count">{evidence.length}</span>
        </div>
        {failed && evidence.length === 0 ? (
          <p role="status">Evidence unavailable</p>
        ) : events === undefined && props.liveEvents.length === 0 ? (
          <p role="status">Loading evidence</p>
        ) : evidence.length === 0 ? (
          <p>No journaled events</p>
        ) : (
          <ol>
            {evidence.slice(-6).reverse().map((event, index) => (
              <li key={`${event.type}-${String(index)}`}>
                <span aria-hidden="true" />
                <div>
                  <strong>{eventLabel(event)}</strong>
                  {eventDetail(event) && <small>{eventDetail(event)}</small>}
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
  selectedRun: Message | undefined;
  selectedRunAuthor: string;
  selectedRunLiveEvents: WireEvent[];
  view: 'members' | 'run';
  onView(view: 'members' | 'run'): void;
  room: string;
  token: string;
  testId?: string;
  className?: string;
  canManageAgents?: boolean;
}) {
  const idPrefix = props.testId ?? 'context-rail';
  const membersTabId = `${idPrefix}-members-tab`;
  const membersPanelId = `${idPrefix}-members-panel`;
  const runTabId = `${idPrefix}-run-tab`;
  const runPanelId = `${idPrefix}-run-panel`;
  const selectTab = (direction: -1 | 1): void => {
    if (!props.selectedRun) return;
    props.onView(props.view === 'members' ? 'run' : 'members');
    requestAnimationFrame(() => {
      const target = direction > 0 ? runTabId : membersTabId;
      document.getElementById(target)?.focus();
    });
  };
  return (
    <aside data-testid={props.testId ?? 'context-rail'} className={`wr-context-rail ${props.className ?? ''}`}>
      <div className="wr-context-tabs" role="tablist" aria-label="Room context">
        <button
          id={membersTabId}
          type="button"
          role="tab"
          aria-selected={props.view === 'members'}
          aria-controls={membersPanelId}
          tabIndex={props.view === 'members' ? 0 : -1}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') selectTab(1);
          }}
          onClick={() => props.onView('members')}
        >
          <Users aria-hidden="true" size={16} /> Members
        </button>
        <button
          id={runTabId}
          type="button"
          role="tab"
          aria-selected={props.view === 'run'}
          aria-controls={runPanelId}
          tabIndex={props.view === 'run' ? 0 : -1}
          disabled={!props.selectedRun}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') selectTab(-1);
          }}
          onClick={() => props.onView('run')}
        >
          <Activity aria-hidden="true" size={16} /> Run
        </button>
      </div>
      {props.view === 'members' || !props.selectedRun ? (
        <div id={membersPanelId} role="tabpanel" aria-labelledby={membersTabId} className="min-h-0 flex-1">
          <MemberRail
            members={props.members}
            details={props.details}
            history={props.history}
            adapters={props.adapters}
            connection={props.connection}
            variant="context"
            className="h-full min-h-0"
            canManageAgents={props.canManageAgents}
          />
        </div>
      ) : (
        <div id={runPanelId} role="tabpanel" aria-labelledby={runTabId} className="min-h-0 flex-1">
          <RunContext
            message={props.selectedRun}
            authorHandle={props.selectedRunAuthor}
            room={props.room}
            token={props.token}
            liveEvents={props.selectedRunLiveEvents}
          />
        </div>
      )}
    </aside>
  );
}
// harn:end run-context-selects-and-follows-live-evidence
// harn:end web-shell-responsive-three-pane
