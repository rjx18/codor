import { deriveRoomId, type Member, type Message, type Room, type WireEvent } from '@wireroom/protocol';
import {
  Activity,
  ArrowUp,
  ChevronRight,
  Clock3,
  ExternalLink,
  Folder,
  Plus,
  Settings,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  createRoom,
  fetchLocalDirectories,
  fetchRunEvents,
  type AdapterRegistration,
  type LocalDirectoryListing,
  type MemberDetail,
} from './api.js';
import { MemberRail } from './components.js';
import { formatRunDuration, mergeRunEvents, presentRunEvents, type RunRow } from './run-presenter.js';
import type { MemberStateObservation, RunEventBuffer } from './state.js';
import type { Connection } from './ws.js';

function roomHref(room: string): string {
  return `/?${new URLSearchParams({ room }).toString()}`;
}

const CHANNEL_ACCENTS = [
  ['#80c56d', 'Green'],
  ['#67b7c7', 'Cyan'],
  ['#8c86d7', 'Violet'],
  ['#d8b34d', 'Amber'],
  ['#d86a64', 'Coral'],
  ['#5f8fd3', 'Blue'],
] as const;

// harn:assume channel-create-dialog-uses-authoritative-result ref=channel-create-dialog
function FolderPicker(props: {
  token: string;
  onSelect(path: string): void;
  onClose(): void;
}) {
  const [listing, setListing] = useState<LocalDirectoryListing>();
  const [root, setRoot] = useState<string>();
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const load = (path: string | undefined, showHidden = hidden): void => {
    setBusy(true);
    setError(false);
    void fetchLocalDirectories(path, showHidden, { token: props.token })
      .then((next) => {
        setListing(next);
        setRoot((current) => current ?? next.path);
      })
      .catch(() => setError(true))
      .finally(() => setBusy(false));
  };

  useEffect(() => load(undefined), []);

  const crumbs = listing && root
    ? [
        { name: 'Home', path: root },
        ...listing.path.slice(root.length).split('/').filter(Boolean).map((name, index, parts) => ({
          name,
          path: `${root}/${parts.slice(0, index + 1).join('/')}`,
        })),
      ]
    : [];

  return (
    <div className="wr-folder-picker" data-testid="folder-picker">
      <div className="wr-folder-toolbar">
        <div className="wr-folder-breadcrumb" aria-label="Project folder breadcrumb">
          {crumbs.map((crumb, index) => (
            <span key={crumb.path}>
              {index > 0 && <ChevronRight aria-hidden="true" size={13} />}
              <button type="button" onClick={() => load(crumb.path)}>{crumb.name}</button>
            </span>
          ))}
        </div>
        <label className="wr-folder-hidden">
          <input
            type="checkbox"
            checked={hidden}
            onChange={(event) => {
              setHidden(event.target.checked);
              load(listing?.path, event.target.checked);
            }}
          />
          Hidden
        </label>
      </div>
      {listing?.parent && (
        <button type="button" className="wr-folder-row" onClick={() => load(listing.parent!)}>
          <ArrowUp aria-hidden="true" size={16} /> Parent
        </button>
      )}
      <div className="wr-folder-list" data-testid="folder-list">
        {listing?.dirs.map((dir) => (
          <button key={dir.path} type="button" className="wr-folder-row" onClick={() => load(dir.path)}>
            <Folder aria-hidden="true" size={16} />
            <span>{dir.name}</span>
            <ChevronRight aria-hidden="true" size={14} />
          </button>
        ))}
        {busy && <p role="status">Loading folders</p>}
        {error && <p role="alert">Folder list unavailable</p>}
        {!busy && !error && listing?.dirs.length === 0 && <p>No child folders</p>}
      </div>
      <div className="wr-dialog-actions">
        <button type="button" className="wr-secondary-button min-h-11 px-4" onClick={props.onClose}>Cancel</button>
        <button
          type="button"
          data-testid="folder-use"
          className="wr-primary-button min-h-11 px-4"
          disabled={!listing}
          onClick={() => listing && props.onSelect(listing.path)}
        >
          Use this folder
        </button>
      </div>
    </div>
  );
}
// harn:end channel-create-dialog-uses-authoritative-result

// harn:assume web-room-rail-creates-owner-room ref=room-rail-create-action
export function RoomList(props: {
  rooms: Room[];
  currentRoom: string;
  currentUnread: number;
  currentHeld: number;
  connected: boolean;
  token?: string;
  owner?: { handle: string; display_name: string };
  adapters?: AdapterRegistration[];
  onNavigate?: () => void;
  canCreateRoom?: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [color, setColor] = useState<(typeof CHANNEL_ACCENTS)[number][0]>(CHANNEL_ACCENTS[0][0]);
  const [cwd, setCwd] = useState('');
  const [pickingFolder, setPickingFolder] = useState(false);
  const [startingHarness, setStartingHarness] = useState<string>();
  const [startingHandle, setStartingHandle] = useState('codor');
  const [createError, setCreateError] = useState<string>();
  const [createBusy, setCreateBusy] = useState(false);
  const firstCreateField = useRef<HTMLInputElement>(null);
  const createTrigger = useRef<HTMLButtonElement>(null);
  const createDialog = useRef<HTMLFormElement>(null);
  const selectedStartingHarness = startingHarness ?? props.adapters?.[0]?.id ?? '';

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
              setStartingHarness(undefined);
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
                <span
                  data-testid={`room-color-${room.id}`}
                  className={`wr-room-dot ${selected && props.connected ? 'is-live' : ''}`}
                  style={room.config.color ? { backgroundColor: room.config.color } : undefined}
                  aria-hidden="true"
                />
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
            className="wr-channel-dialog wr-focused-glass relative z-10 w-full max-w-xl p-5"
            onSubmit={(event) => {
              event.preventDefault();
              setCreateError(undefined);
              setCreateBusy(true);
              void createRoom({
                name: roomName,
                owner: props.owner!,
                color,
                ...(cwd.trim() !== '' && { cwd: cwd.trim() }),
                ...(selectedStartingHarness !== '' && {
                  starting_agent: {
                    harness: selectedStartingHarness,
                    handle: startingHandle.trim() || 'codor',
                  },
                }),
              }, { token: props.token! }).then(
                (room) => window.location.assign(roomHref(room.id)),
                () => setCreateError('Channel could not be created. Check the folder and try again.'),
              ).finally(() => setCreateBusy(false));
            }}
          >
            <div className="wr-dialog-heading">
              <div>
                <h2>Create channel</h2>
                <p>A private channel on this switchboard.</p>
              </div>
              <button type="button" aria-label="Close create room" className="wr-icon-button" onClick={() => setCreating(false)}>
                <X aria-hidden="true" size={18} />
              </button>
            </div>
            <label className="wr-field-label">
              Name
              <input
                ref={firstCreateField}
                data-testid="create-room-name"
                value={roomName}
                onChange={(event) => setRoomName(event.target.value)}
                placeholder="Release train"
                required
                className="wr-input min-h-11 px-3"
              />
              <small data-testid="create-room-id">id: {deriveRoomId(roomName)}</small>
            </label>
            <fieldset className="wr-channel-colors">
              <legend>Color</legend>
              <div>
                {CHANNEL_ACCENTS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    data-testid={`channel-color-${label.toLowerCase()}`}
                    aria-label={`${label} channel color`}
                    aria-pressed={color === value}
                    title={label}
                    style={{ backgroundColor: value }}
                    onClick={() => setColor(value)}
                  />
                ))}
              </div>
            </fieldset>
            <label className="wr-field-label">
              Project folder
              <span className="wr-folder-field">
                <input
                  data-testid="create-room-cwd"
                  value={cwd}
                  onChange={(event) => setCwd(event.target.value)}
                  placeholder="~/git/demo"
                  className="wr-input min-h-11 px-3"
                />
                <button
                  type="button"
                  data-testid="browse-folders"
                  className="wr-secondary-button min-h-11 px-3"
                  onClick={() => setPickingFolder(true)}
                >
                  <Folder aria-hidden="true" size={16} /> Browse
                </button>
              </span>
            </label>
            <div className="wr-starting-agent">
              <label className="wr-field-label">
                Starting agent
                <select
                  data-testid="create-room-harness"
                  value={selectedStartingHarness}
                  onChange={(event) => setStartingHarness(event.target.value)}
                  className="wr-input min-h-11 px-3"
                >
                  <option value="">No starting agent</option>
                  {(props.adapters ?? []).map((adapter) => (
                    <option key={adapter.id} value={adapter.id}>{adapter.id}</option>
                  ))}
                </select>
              </label>
              <label className="wr-field-label">
                Name
                <input
                  data-testid="create-room-agent-name"
                  value={startingHandle}
                  onChange={(event) => setStartingHandle(event.target.value)}
                  disabled={selectedStartingHarness === ''}
                  className="wr-input min-h-11 px-3 disabled:opacity-50"
                />
              </label>
            </div>
            {createError && <p role="alert" className="wr-form-error">{createError}</p>}
            <div className="wr-dialog-actions">
              <button type="button" className="wr-secondary-button min-h-11 px-4" onClick={() => setCreating(false)}>Cancel</button>
              <button type="submit" data-testid="create-room-submit" disabled={createBusy} className="wr-primary-button min-h-11 px-4">
                {createBusy ? 'Creating' : 'Create channel'}
              </button>
            </div>
            {pickingFolder && (
              <FolderPicker
                token={props.token}
                onClose={() => setPickingFolder(false)}
                onSelect={(path) => {
                  setCwd(path);
                  setPickingFolder(false);
                }}
              />
            )}
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
  adapters?: AdapterRegistration[];
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

// harn:assume normalized-run-evidence-inspector ref=typed-evidence-renderers
function DiffEvidence(props: { row: RunRow }) {
  const diff = props.row.diff!;
  return (
    <div className="wr-inspector-diff" data-testid="inspector-diff">
      <div className="wr-inspector-evidence-heading">
        <strong>{diff.path}</strong>
        {props.row.detail && <span>{props.row.detail.split(' · ').at(-1)}</span>}
      </div>
      <pre>
        {diff.unified.split('\n').map((line, index) => {
          const tone = line.startsWith('+++') || line.startsWith('---')
            ? 'header'
            : line.startsWith('+')
              ? 'add'
              : line.startsWith('-')
                ? 'remove'
                : line.startsWith('@@')
                  ? 'hunk'
                  : 'context';
          return <span key={index} className={`wr-diff-line-${tone}`}>{line || ' '}{'\n'}</span>;
        })}
      </pre>
    </div>
  );
}

function SelectedEvidence(props: { row: RunRow }) {
  if (props.row.diff) return <DiffEvidence row={props.row} />;
  if (props.row.image) {
    return (
      <div className="wr-inspector-image" data-testid="inspector-image">
        <img
          src={`data:${props.row.image.media_type};base64,${props.row.image.data_b64}`}
          alt={`${props.row.title} result`}
        />
      </div>
    );
  }
  return (
    <pre className="wr-inspector-output" data-testid="inspector-output">
      {props.row.output_text ?? props.row.detail ?? 'No textual output reported.'}
    </pre>
  );
}
// harn:end normalized-run-evidence-inspector

// harn:assume run-context-selects-and-follows-live-evidence ref=selected-live-run-context
function RunContext(props: {
  message: Message;
  authorHandle: string;
  room: string;
  token: string;
  liveEvents: RunEventBuffer;
  selectedEventIndex?: number;
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
  const evidence = mergeRunEvents(events, props.liveEvents);
  const selectedRow = presentRunEvents(evidence)
    .find((row) => row.eventIndex === props.selectedEventIndex);

  return (
    <section className="wr-run-context h-full min-h-0 overflow-y-auto" aria-label={`Run ${String(props.message.id)} context`}>
      <div className="wr-context-heading">
        <span className="wr-run-symbol" aria-hidden="true"><Activity size={17} /></span>
        <div>
          <strong>{selectedRow ? selectedRow.title : `#${String(props.message.id)} @${props.authorHandle}`}</strong>
          <small>
            {selectedRow
              ? [selectedRow.detail, selectedRow.status, selectedRow.duration_ms === undefined
                  ? undefined
                  : formatRunDuration(selectedRow.duration_ms)].filter(Boolean).join(' · ')
              : run.status}
          </small>
        </div>
        <a href={`#${String(props.message.id)}`} className="wr-icon-button" aria-label={`Open run ${String(props.message.id)} in conversation`}>
          <ExternalLink aria-hidden="true" size={16} />
        </a>
      </div>
      <span className="sr-only" data-testid="context-evidence-count">{evidence.length}</span>
      {selectedRow ? (
        <div className="wr-inspector-evidence"><SelectedEvidence row={selectedRow} /></div>
      ) : (
        <dl className="wr-context-facts" data-testid="inspector-run-facts">
          <dt>Status</dt><dd>{run.status}</dd>
          <dt>Started</dt><dd><Clock3 aria-hidden="true" size={13} /> {new Date(run.started_ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</dd>
          <dt>Tokens</dt><dd>{tokenTotal === undefined ? '-' : tokenTotal.toLocaleString()}</dd>
          <dt>Spend</dt><dd>{run.usage?.cost_usd === undefined ? 'not reported' : `$${run.usage.cost_usd.toFixed(2)}`}</dd>
          <dt>Tools</dt><dd>{run.tool_calls}</dd>
        </dl>
      )}
      {failed && evidence.length === 0 && <p role="status">Evidence unavailable</p>}
      {events === undefined && props.liveEvents.events.length === 0 && <p role="status">Loading evidence</p>}
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
  selectedRunLiveEvents: RunEventBuffer;
  selectedEventIndex?: number;
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
        <div id={runPanelId} role="tabpanel" aria-labelledby={runTabId} className="h-full min-h-0 flex-1 overflow-hidden">
          <RunContext
            message={props.selectedRun}
            authorHandle={props.selectedRunAuthor}
            room={props.room}
            token={props.token}
            liveEvents={props.selectedRunLiveEvents}
            selectedEventIndex={props.selectedEventIndex}
          />
        </div>
      )}
    </aside>
  );
}
// harn:end run-context-selects-and-follows-live-evidence
// harn:end web-shell-responsive-three-pane
