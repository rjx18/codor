import {
  CHANNEL_ACCENTS,
  deriveAssignableHandle,
  deriveRoomColor,
  deriveRoomId,
  type Member,
  type Message,
  type Policy,
  type Room,
  type ThinkingLevel,
  type WireEvent,
} from '@codor/protocol';
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

import { AgentControls } from './agent-controls.js';
import { Button, IconButton, SegmentedTabs } from './v5/primitives.js';

import {
  createRoom,
  fetchLocalDirectories,
  fetchRunEvents,
  type AdapterRegistration,
  type LocalDirectoryListing,
  type MemberDetail,
} from './api.js';
import {
  MemberRail,
  useAccentProjector,
  ACCENT_UNION_BACKGROUNDS,
} from './components.js';
import { useRoomPresentation } from './room-presentation.js';
import { formatRunDuration, mergeRunEvents, presentRunEvents, type RunRow } from './run-presenter.js';
import type { MemberStateObservation, RunEventBuffer } from './state.js';
import type { Connection } from './ws.js';

function roomHref(room: string): string {
  return `/?${new URLSearchParams({ room }).toString()}`;
}

// The accent palette is the protocol's single source of truth (imported, never duplicated);
// the human-facing labels stay here, aligned to CHANNEL_ACCENTS by index.
const ACCENT_LABELS = ['Green', 'Cyan', 'Violet', 'Amber', 'Coral', 'Blue'] as const;

// harn:assume channel-create-dialog-renders-an-accessible-accent ref=channel-create-dialog
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
        <Button variant="secondary" onClick={props.onClose}>Cancel</Button>
        <Button
          variant="primary"
          data-testid="folder-use"
          disabled={!listing}
          onClick={() => listing && props.onSelect(listing.path)}
        >
          Use this folder
        </Button>
      </div>
    </div>
  );
}
// harn:end channel-create-dialog-renders-an-accessible-accent

// harn:assume web-room-rail-creates-owner-room ref=room-rail-create-action
// harn:assume starting-agent-name-derives-one-valid-identity-v5 ref=starting-agent-name-control
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
  const [color, setColor] = useState<string>(CHANNEL_ACCENTS[0]);
  const [cwd, setCwd] = useState('');
  const projectAccentColor = useAccentProjector();
  const [pickingFolder, setPickingFolder] = useState(false);
  const [startingHarness, setStartingHarness] = useState<string>();
  const [startingName, setStartingName] = useState('codor');
  const [startingModel, setStartingModel] = useState('');
  const [startingThinking, setStartingThinking] = useState<ThinkingLevel | ''>('');
  const [startingPolicy, setStartingPolicy] = useState<Policy>('read-only');
  const [createError, setCreateError] = useState<string>();
  const [startingNameError, setStartingNameError] = useState<string>();
  const [createBusy, setCreateBusy] = useState(false);
  // The channel row stays framed at every width; it still adopts the presentation model.
  const rowPresentation = useRoomPresentation('channel-row');
  const firstCreateField = useRef<HTMLInputElement>(null);
  const createTrigger = useRef<HTMLButtonElement>(null);
  const createDialog = useRef<HTMLDivElement>(null);
  const selectedStartingHarness = startingHarness ?? props.adapters?.[0]?.id ?? '';
  const derivedStartingHandle = selectedStartingHarness === ''
    ? undefined
    : deriveAssignableHandle(startingName);

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
    <nav aria-label="Channels" className="wr-room-list">
      <div className="wr-rail-label">
        <span>Channels</span>
        {props.token && props.owner && (props.canCreateRoom ?? true) ? (
          <IconButton
            ref={createTrigger}
            icon={Plus}
            data-testid="create-room"
            label="Create channel"
            title="Create channel"
            onClick={() => {
              setCreateError(undefined);
              setStartingNameError(undefined);
              setStartingHarness(undefined);
              setCreating(true);
            }}
          />
        ) : <span>{props.rooms.length}</span>}
      </div>
      <ul>
        {props.rooms.map((room) => {
          const selected = room.id === props.currentRoom;
          // The rail dot renders the accessible projection of the channel's accent - the SAME
          // colour the header chip and the selected picker candidate show - never the raw
          // stored value, which stays untouched in room.config.color.
          const dotColor = projectAccentColor(
            room.config.color ?? deriveRoomColor(room.id),
            room.id,
            ACCENT_UNION_BACKGROUNDS,
          );
          return (
            <li key={room.id}>
              <a
                href={roomHref(room.id)}
                data-testid={`room-link-${room.id}`}
                aria-current={selected ? 'page' : undefined}
                data-presentation={rowPresentation}
                className="wr-room-link"
                onClick={props.onNavigate}
              >
                <span
                  data-testid={`room-color-${room.id}`}
                  className={`wr-room-dot ${selected && props.connected ? 'is-live' : ''}`}
                  style={{ backgroundColor: dotColor }}
                  aria-hidden="true"
                />
                <span className="wr-room-copy">
                  <strong title={room.name}>{room.name}</strong>
                  <small>
                    {selected ? (props.connected ? 'Live on this device' : 'Offline') : 'Channel'}
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
        <div className="wr-modal-backdrop">
          <button
            type="button"
            aria-label="Close create channel"
            className="wr-layer-scrim"
            onClick={() => setCreating(false)}
          />
          {/* ARIA does not allow role=dialog on a form. The dialog is this element, and it
              keeps the box the form owned - same classes, so the same width and placement.
              The form inside lays out as display:contents and draws nothing. */}
          <div
            ref={createDialog}
            role="dialog"
            aria-modal="true"
            aria-label="Create channel"
            data-testid="create-room-dialog"
            className="wr-channel-dialog wr-focused-glass"
          >
          <form
            className="wr-channel-form"
            onSubmit={(event) => {
              event.preventDefault();
              setCreateError(undefined);
              setStartingNameError(undefined);
              if (selectedStartingHarness !== '') {
                if (derivedStartingHandle === undefined) {
                  setStartingNameError('This name resolves to a reserved agent handle. Choose another name.');
                  return;
                }
                if (derivedStartingHandle === props.owner!.handle) {
                  setStartingNameError(
                    `@${derivedStartingHandle} is already in use by the channel owner.`,
                  );
                  return;
                }
              }
              setCreateBusy(true);
              void createRoom({
                name: roomName,
                owner: props.owner!,
                color,
                ...(cwd.trim() !== '' && { cwd: cwd.trim() }),
                ...(selectedStartingHarness !== '' && {
                  starting_agent: {
                    harness: selectedStartingHarness,
                    handle: derivedStartingHandle!,
                    display_name: startingName.trim() || 'Agent',
                    ...(startingModel.trim() !== '' && { model: startingModel.trim() }),
                    ...(startingThinking !== '' && { thinking: startingThinking }),
                    // F11: a channel-seeded agent used to spawn with NO policy at all.
                    policy: startingPolicy,
                  },
                }),
              }, { token: props.token! }).then(
                (room) => window.location.assign(roomHref(room.id)),
                (error: unknown) => {
                  const message = error instanceof Error ? error.message : String(error);
                  if (/starting agent|handle/i.test(message)) setStartingNameError(message);
                  else setCreateError(message);
                },
              ).finally(() => setCreateBusy(false));
            }}
          >
            <div className="wr-dialog-heading">
              <div>
                <h2>Create channel</h2>
                <p>A private channel on this device.</p>
              </div>
              <button type="button" aria-label="Close create channel" className="wr-icon-button" onClick={() => setCreating(false)}>
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
                className="wr-input"
              />
              <small data-testid="create-room-id">id: {deriveRoomId(roomName)}</small>
            </label>
            <fieldset className="wr-channel-colors">
              <legend>Color</legend>
              <div>
                {CHANNEL_ACCENTS.map((value, index) => {
                  const label = ACCENT_LABELS[index]!;
                  // The swatch shows the accessible PROJECTION so what the operator picks is
                  // what the rail and header render; the RAW value is what setColor persists.
                  const swatch = projectAccentColor(value, deriveRoomId(roomName), ACCENT_UNION_BACKGROUNDS);
                  return (
                    <button
                      key={value}
                      type="button"
                      data-testid={`channel-color-${label.toLowerCase()}`}
                      aria-label={`${label} channel color`}
                      aria-pressed={color === value}
                      title={label}
                      onClick={() => setColor(value)}
                    >
                      {/* The 30px swatch keeps its visual size; the button carries a 44x44 hit box
                          around it so the target clears the mobile minimum. */}
                      <span className="wr-swatch-fill" style={{ backgroundColor: swatch }} aria-hidden="true" />
                    </button>
                  );
                })}
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
                  className="wr-input"
                />
                <Button
                  variant="secondary"
                  data-testid="browse-folders"
                  onClick={() => setPickingFolder(true)}
                >
                  <Folder aria-hidden="true" size={16} /> Browse
                </Button>
              </span>
            </label>
            <div className="wr-starting-agent">
              <AgentControls
                adapters={props.adapters ?? []}
                idPrefix="create-room"
                allowNone
                value={{
                  harness: selectedStartingHarness,
                  model: startingModel,
                  thinking: startingThinking,
                  policy: startingPolicy,
                }}
                onChange={(next) => {
                  setStartingHarness(next.harness);
                  setStartingModel(next.model);
                  setStartingThinking(next.thinking);
                  setStartingPolicy(next.policy);
                }}
              />
              <label className="wr-field-label">
                Name
                <input
                  data-testid="create-room-agent-name"
                  value={startingName}
                  onChange={(event) => {
                    setStartingName(event.target.value);
                    setStartingNameError(undefined);
                  }}
                  disabled={selectedStartingHarness === ''}
                  className="wr-input"
                />
                {selectedStartingHarness !== '' && derivedStartingHandle !== undefined && (
                  <small data-testid="create-room-agent-handle">@{derivedStartingHandle}</small>
                )}
                {startingNameError && <small role="alert" className="wr-form-error">{startingNameError}</small>}
              </label>
            </div>
            {createError && <p role="alert" className="wr-form-error">{createError}</p>}
            <div className="wr-dialog-actions">
              <Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button>
              <Button variant="primary" type="submit" data-testid="create-room-submit" disabled={createBusy}>
                {createBusy ? 'Creating' : 'Create channel'}
              </Button>
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
        </div>
      )}
    </nav>
  );
}
// harn:end starting-agent-name-derives-one-valid-identity-v5
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
    <aside data-testid="room-rail" aria-label="Channels" className="wr-room-rail">
      <div className="wr-brand">
        <span className="wr-brand-copy">
          <strong>Codor</strong>
        </span>
      </div>
      <RoomList {...props} />
      <div className="wr-rail-footer">
        <span className={`wr-presence ${props.connected ? 'is-live' : ''}`} aria-hidden="true" />
        <span>
          <strong>{props.owner?.display_name ?? 'Signed out'}</strong>
          <small>{props.connected ? 'Connected' : 'Reconnecting…'}</small>
        </span>
        <a
          href={`/settings?${new URLSearchParams({ room: props.currentRoom }).toString()}`}
          aria-label="Open settings from channel rail"
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
    <section className="wr-run-context wr-fill-height" aria-label={`Run ${String(props.message.id)} context`}>
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
  return (
    <aside
      data-testid={props.testId ?? 'context-rail'}
      aria-label="Channel context"
      className={`wr-context-rail ${props.className ?? ''}`}
    >
      <div className="wr-context-tabs">
        <SegmentedTabs
          label="Channel context"
          selected={props.view}
          onSelect={props.onView}
          tabs={[
            {
              id: 'members',
              tabId: membersTabId,
              controls: membersPanelId,
              label: <><Users aria-hidden="true" size={16} /> Members</>,
            },
            {
              id: 'run',
              tabId: runTabId,
              controls: runPanelId,
              disabled: !props.selectedRun,
              label: <><Activity aria-hidden="true" size={16} /> Run</>,
            },
          ]}
        />
      </div>
      {props.view === 'members' || !props.selectedRun ? (
        <div id={membersPanelId} role="tabpanel" aria-labelledby={membersTabId} className="wr-context-panel">
          <MemberRail
            members={props.members}
            details={props.details}
            history={props.history}
            adapters={props.adapters}
            connection={props.connection}
            variant="context"
            className="wr-fill-height"
            canManageAgents={props.canManageAgents}
          />
        </div>
      ) : (
        <div id={runPanelId} role="tabpanel" aria-labelledby={runTabId} className="wr-context-panel wr-context-panel-run">
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
