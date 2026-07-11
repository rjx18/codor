import {
  parseBody,
  type Delivery,
  type Member,
  type Message,
  type RoomMeter,
  type WireEvent,
} from '@wireroom/protocol';
import {
  Activity,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  CircleDollarSign,
  CircleX,
  Clock3,
  FileCode2,
  FileText,
  Gauge,
  GitCommitHorizontal,
  Inbox,
  Menu,
  PanelRight,
  PauseCircle,
  Play,
  Plus,
  RotateCcw,
  Search,
  Send,
  Settings,
  ShieldAlert,
  UserRound,
  Wrench,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { fetchLedgerNote, fetchRunEvents } from './api.js';
import type { AdapterRegistration, LedgerNote, MemberDetail } from './api.js';
import { storedBrowserAccess } from './crypto.js';
import { latestFinalizedAgentAuthor, me, type MemberStateObservation } from './state.js';
import type { Connection } from './ws.js';

const stateDot: Record<string, string> = {
  idle: 'wr-state-idle',
  running: 'wr-state-running',
  queued: 'wr-state-attention',
  awaiting_input: 'wr-state-attention',
  paused: 'wr-state-muted',
  dead: 'wr-state-danger',
  unreachable: 'wr-state-muted',
  custody_uncertain: 'wr-state-attention',
};

// harn:assume permalink-ids-stable ref=message-permalink-rendering
function MessagePermalink(props: { id: number }) {
  return (
    <a
      href={`#${props.id}`}
      aria-label={`Permalink to message ${String(props.id)}`}
      className="wr-permalink"
    >
      #{props.id}
    </a>
  );
}

export type LedgerTextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'ledger'; name: string; text: string };

export function ledgerTextSegments(body: string): LedgerTextSegment[] {
  const segments: LedgerTextSegment[] = [];
  const pattern = /\[\[([a-z0-9][a-z0-9-]{0,62})\]\]/g;
  let cursor = 0;
  for (const match of body.matchAll(pattern)) {
    const start = match.index;
    if (start > cursor) segments.push({ kind: 'text', text: body.slice(cursor, start) });
    segments.push({ kind: 'ledger', name: match[1]!, text: match[0] });
    cursor = start + match[0].length;
  }
  if (cursor < body.length) segments.push({ kind: 'text', text: body.slice(cursor) });
  return segments;
}
// harn:end permalink-ids-stable

// harn:assume spend-meter-always-on ref=meter-settings-surface
export function Header(props: {
  roomName: string;
  roomId: string;
  token: string;
  connected: boolean;
  meter: RoomMeter | undefined;
  unread: number;
  memberCount?: number;
  searchOpen?: boolean;
  onOpenNavigation?: () => void;
  onOpenContext?: () => void;
  onToggleSearch?: () => void;
}) {
  const meter = {
    turns: props.meter?.turns ?? 0,
    costUsd: props.meter?.cost_usd ?? 0,
    tokens: (props.meter?.input_tokens ?? 0) + (props.meter?.output_tokens ?? 0),
    uncostedTokens: props.meter?.uncosted_tokens ?? 0,
  };
  return (
    <header className="wr-room-header">
      <div className="wr-header-identity">
        {props.onOpenNavigation && (
          <button
            type="button"
            data-testid="open-room-drawer"
            aria-label="Open rooms and members"
            title="Rooms and members"
            onClick={props.onOpenNavigation}
            className="wr-icon-button wr-mobile-trigger"
          >
            <Menu aria-hidden="true" size={20} />
          </button>
        )}
        <span className="wr-room-glyph wr-header-glyph" aria-hidden="true">#</span>
        <div className="wr-room-title">
          <h1 title={props.roomName}>{props.roomName}</h1>
          <span>
            <i
              data-testid="connection"
              className={`wr-presence ${props.connected ? 'is-live' : 'is-offline'}`}
              title={props.connected ? 'connected' : 'disconnected'}
            />
            {props.connected ? 'Live' : 'Reconnecting'}
            {props.memberCount !== undefined && <> · {props.memberCount} members</>}
          </span>
        </div>
      </div>
      <div
        data-testid="meter"
        className="wr-meter"
        tabIndex={0}
        aria-label="Room usage today"
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            event.currentTarget.scrollBy({
              left: event.key === 'ArrowLeft' ? -120 : 120,
              behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
            });
          }
        }}
        title={`${String(meter.turns)} turns, ${String(meter.tokens)} tokens, $${meter.costUsd.toFixed(2)} today`}
      >
        <span><Gauge aria-hidden="true" size={14} /> {meter.turns} turns</span>
        <span><Activity aria-hidden="true" size={14} /> {meter.tokens.toLocaleString()} tokens</span>
        <span><CircleDollarSign aria-hidden="true" size={14} /> ${meter.costUsd.toFixed(2)} today</span>
        {meter.uncostedTokens > 0 && (
          <em>{meter.uncostedTokens} tokens uncosted</em>
        )}
      </div>
      <div className="wr-header-actions">
        {props.onToggleSearch && (
          <button
            id="room-search-toggle"
            type="button"
            data-testid="toggle-message-search"
            aria-label={props.searchOpen ? 'Close message search' : 'Search messages'}
            aria-expanded={props.searchOpen}
            aria-controls="room-message-search"
            aria-pressed={props.searchOpen}
            title={props.searchOpen ? 'Close search' : 'Search messages'}
            onClick={props.onToggleSearch}
            className="wr-icon-button"
          >
            <Search aria-hidden="true" size={18} />
          </button>
        )}
        {props.onOpenContext && (
          <button
            type="button"
            aria-label="Open room context"
            title="Members and run context"
            onClick={props.onOpenContext}
            className="wr-icon-button wr-context-trigger"
          >
            <PanelRight aria-hidden="true" size={18} />
          </button>
        )}
        <a
          href={`/settings?${new URLSearchParams({ room: props.roomId }).toString()}`}
          data-testid="room-settings"
          aria-label="Settings"
          title="Settings"
          className="wr-icon-button"
        >
          <Settings aria-hidden="true" size={18} />
        </a>
        <span data-testid="inbox-badge" className="wr-inbox" title={`${String(props.unread)} unread`}>
          <Inbox aria-hidden="true" size={16} />
          <span className="sr-only">inbox&nbsp;</span>
          {props.unread > 0 ? <strong>{props.unread}</strong> : 0}
        </span>
      </div>
    </header>
  );
}
// harn:end spend-meter-always-on

export function SpawnAgentDialog(props: {
  adapters: AdapterRegistration[];
  connection: Connection;
}) {
  const [open, setOpen] = useState(false);
  const [harness, setHarness] = useState('');
  const [handle, setHandle] = useState('');
  const [cwd, setCwd] = useState('.');
  const [policy, setPolicy] = useState('read-only');
  const handleField = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (harness === '' && props.adapters[0]) setHarness(props.adapters[0].id);
  }, [harness, props.adapters]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => handleField.current?.focus());
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>(
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
    document.addEventListener('keydown', dismiss, true);
    return () => {
      document.removeEventListener('keydown', dismiss, true);
      trigger.current?.focus();
    };
  }, [open]);

  const submit = (): void => {
    if (!harness || !handle || !cwd) return;
    props.connection.act({ act: 'spawn', harness, handle, cwd, policy });
    setHandle('');
    setOpen(false);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-testid="spawn-agent"
        aria-label="Spawn agent"
        title="Spawn agent"
        onClick={() => setOpen(true)}
        className="wr-spawn-button"
      >
        <Plus aria-hidden="true" size={17} />
        <span className="sr-only">Spawn agent</span>
      </button>
      {open && (
        <div className="wr-modal-backdrop fixed inset-0 z-20 flex items-center justify-center p-4">
          <form
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-label="Spawn agent"
            data-testid="spawn-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
            className="wr-focused-glass w-full max-w-md p-5"
          >
            <div className="wr-dialog-heading">
              <div>
                <h2>Spawn agent</h2>
                <p>Start a harness-backed member in this room.</p>
              </div>
              <button type="button" aria-label="Close spawn agent" className="wr-icon-button" onClick={() => setOpen(false)}>
                <X aria-hidden="true" size={18} />
              </button>
            </div>
            <label className="wr-field-label">
              Harness
              <select
                data-testid="spawn-harness"
                value={harness}
                onChange={(event) => setHarness(event.target.value)}
                className="wr-input min-h-11 w-full px-3 text-sm"
              >
                {props.adapters.map((adapter) => (
                  <option key={adapter.id} value={adapter.id}>
                    {adapter.id} {adapter.capabilities.resume ? '' : '(ephemeral)'}
                  </option>
                ))}
              </select>
            </label>
            <label className="wr-field-label">
              Handle
              <input
                ref={handleField}
                data-testid="spawn-handle"
                value={handle}
                onChange={(event) => setHandle(event.target.value)}
                pattern="[a-z0-9][a-z0-9-]{1,30}"
                required
                className="wr-input min-h-11 w-full px-3 text-sm"
              />
            </label>
            <label className="wr-field-label">
              Working directory
              <input
                data-testid="spawn-cwd"
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                required
                className="wr-input min-h-11 w-full px-3 text-sm"
              />
            </label>
            <label className="wr-field-label">
              Policy
              <select
                data-testid="spawn-policy"
                value={policy}
                onChange={(event) => setPolicy(event.target.value)}
                className="wr-input min-h-11 w-full px-3 text-sm"
              >
                <option value="read-only">read-only</option>
                <option value="workspace-write">workspace-write</option>
                <option value="full-access">full-access</option>
              </select>
            </label>
            <div className="wr-dialog-actions">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="wr-secondary-button min-h-11 px-4 text-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                data-testid="spawn-submit"
                disabled={props.adapters.length === 0}
                className="wr-primary-button min-h-11 px-4 text-sm disabled:opacity-40"
              >
                Spawn
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

export function MemberCard(props: {
  member: Member;
  detail: MemberDetail | undefined;
  history: MemberStateObservation[];
  connection: Connection;
  expanded?: boolean;
  onToggle?: () => void;
  canManage?: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const [handle, setHandle] = useState(props.member.handle);
  const [displayName, setDisplayName] = useState(props.member.display_name);
  const state = props.member.state ?? 'idle';
  const tokens =
    (props.detail?.spend.input_tokens ?? 0) + (props.detail?.spend.output_tokens ?? 0);
  const expanded = props.expanded ?? true;
  const canManage = props.canManage ?? true;

  useEffect(() => {
    setHandle(props.member.handle);
    setDisplayName(props.member.display_name);
  }, [props.member.display_name, props.member.handle]);

  if (props.member.kind !== 'agent') {
    return (
      <li data-testid={`member-${props.member.handle}`} className="wr-member wr-member-human">
        {props.member.state ? (
          <span className="wr-human-state" data-state={props.member.state}>
            <i aria-hidden="true" /> {props.member.state.replaceAll('_', ' ')}
          </span>
        ) : <UserRound aria-hidden="true" size={17} />}
        <span className="min-w-0 truncate text-zinc-200">@{props.member.handle}</span>
        <span className="ml-auto text-[11px] uppercase text-zinc-500">{props.member.role ?? props.member.kind}</span>
      </li>
    );
  }

  return (
    <li
      data-testid={`member-${props.member.handle}`}
      className={`wr-member ${expanded ? 'is-expanded' : ''}`}
    >
      <button
        type="button"
        data-testid={`member-${props.member.handle}-toggle`}
        aria-expanded={expanded}
        aria-controls={`member-${props.member.id}-detail`}
        onClick={props.onToggle}
        className="wr-member-summary"
      >
        <span className="wr-member-avatar" aria-hidden="true"><Bot size={17} /></span>
        <span className="wr-member-identity">
          <strong>@{props.member.handle}</strong>
          <small>{props.member.harness ?? 'agent'} · {props.member.policy ?? 'default policy'}</small>
        </span>
        <span className="wr-member-state" data-state={state}>
          <i aria-hidden="true" /> {state.replaceAll('_', ' ')}
        </span>
        {(props.detail?.queued_count ?? 0) > 0 && (
          <span
            data-testid={`member-${props.member.handle}-queued`}
            className="wr-count wr-count-attention"
          >
            {props.detail!.queued_count} queued
          </span>
        )}
        <ChevronRight className="wr-member-chevron" aria-hidden="true" size={15} />
      </button>
      {expanded && <div id={`member-${props.member.id}-detail`} className="wr-member-detail">
      <dl className="wr-member-facts">
        <dt className="text-zinc-500">Harness</dt>
        <dd className="truncate text-zinc-300">{props.member.harness ?? '-'}</dd>
        <dt className="text-zinc-500">Custody</dt>
        <dd className="truncate text-zinc-300">{props.member.custody ?? 'owned'}</dd>
        <dt className="text-zinc-500">Session</dt>
        <dd className="truncate font-mono text-zinc-300" title={props.member.session_ref}>
          {props.member.session_ref ?? 'pending'}
        </dd>
        <dt className="text-zinc-500">Cwd</dt>
        <dd className="truncate font-mono text-zinc-300" title={props.member.cwd}>
          {props.member.cwd ?? '-'}
        </dd>
        <dt className="text-zinc-500">Spend</dt>
        <dd className="text-zinc-300">
          ${(props.detail?.spend.cost_usd ?? 0).toFixed(2)} · {tokens} tk
          {(props.detail?.spend.uncosted_tokens ?? 0) > 0 &&
            ` · ${props.detail!.spend.uncosted_tokens} uncosted`}
        </dd>
      </dl>
      {props.member.policy && (
        <span className="wr-policy-chip">
          {props.member.policy}
        </span>
      )}
      {/* harn:assume custody-uncertain-never-double-writes ref=attach-custody-web-hint */}
      {canManage && props.member.session_ref && props.member.custody !== 'mirrored' && state !== 'dead' && (
        <div className="mt-2 flex min-w-0 items-center gap-2 text-[10px]">
          <code
            data-testid={`attach-command-${props.member.handle}`}
            className="wr-code-field min-w-0 flex-1 truncate"
          >
            wireroom attach @{props.member.handle}
          </code>
          <button
            type="button"
            title="Copy attach command"
            onClick={() =>
              void navigator.clipboard?.writeText(`wireroom attach @${props.member.handle}`)
            }
            className="wr-secondary-button min-h-11 shrink-0 px-3"
          >
            Copy
          </button>
        </div>
      )}
      {/* harn:end custody-uncertain-never-double-writes */}
      <p
        data-testid={`member-${props.member.handle}-history`}
        className="mt-2 truncate text-[10px] text-zinc-500"
        title={props.history.map((item) => `${item.ts} ${item.state}`).join('\n')}
      >
        {props.history.map((item) => item.state).join(' > ') || state}
      </p>
      {canManage && (renaming ? (
        <form
          className="mt-2 grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            props.connection.act({
              act: 'rename',
              member_id: props.member.id,
              handle,
              display_name: displayName,
            });
            setRenaming(false);
          }}
        >
          <input
            data-testid={`rename-${props.member.handle}-handle`}
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            pattern="[a-z0-9][a-z0-9-]{1,30}"
            required
            className="min-h-11 border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100"
          />
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            required
            className="min-h-11 border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              data-testid={`rename-${props.member.handle}-submit`}
              className="min-h-11 bg-sky-800 px-3 text-xs text-white"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setRenaming(false)}
              className="min-h-11 border border-zinc-700 px-3 text-xs text-zinc-300"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1">
          <button
            type="button"
            data-testid={`rename-${props.member.handle}`}
            onClick={() => setRenaming(true)}
            className="min-h-11 border border-zinc-700 px-3 text-xs text-zinc-300"
          >
            Rename
          </button>
          {props.member.custody === 'mirrored' ? (
            <button
              type="button"
              data-testid={`adopt-${props.member.handle}`}
              onClick={() => props.connection.act({ act: 'adopt', member_id: props.member.id })}
              className="min-h-11 bg-emerald-800 px-3 text-xs text-white"
            >
              Adopt
            </button>
          ) : state === 'dead' ? (
            <button
              type="button"
              data-testid={`revive-${props.member.handle}`}
              disabled={!props.member.session_ref}
              onClick={() => props.connection.act({ act: 'revive', member_id: props.member.id })}
              className="min-h-11 bg-emerald-800 px-3 text-xs text-white disabled:opacity-40"
            >
              Revive
            </button>
          ) : (
            <button
              type="button"
              data-testid={`kill-${props.member.handle}`}
              onClick={() => props.connection.act({ act: 'kill', member_id: props.member.id })}
              className="min-h-11 bg-red-900 px-3 text-xs text-red-100"
            >
              Kill
            </button>
          )}
          {state !== 'dead' && props.member.custody !== 'mirrored' && (
            <button
              type="button"
              data-testid={`${state === 'paused' ? 'unpause' : 'pause'}-${props.member.handle}`}
              onClick={() =>
                props.connection.act({
                  act: state === 'paused' ? 'unpause' : 'pause',
                  member_id: props.member.id,
                })
              }
              className="min-h-11 border border-zinc-700 px-3 text-xs text-zinc-300"
            >
              {state === 'paused' ? 'Unpause' : 'Pause'}
            </button>
          )}
        </div>
      ))}
      </div>}
    </li>
  );
}

export function MemberRail(props: {
  members: Member[];
  details: Record<string, MemberDetail>;
  history: Record<string, MemberStateObservation[]>;
  adapters: AdapterRegistration[];
  connection: Connection;
  variant?: 'rail' | 'context' | 'drawer';
  className?: string;
  canManageAgents?: boolean;
}) {
  const variant = props.variant ?? 'rail';
  const firstAgentId = props.members.find((member) => member.kind === 'agent')?.id;
  const [selectedMemberId, setSelectedMemberId] = useState<string | undefined>(firstAgentId);
  const initializedSelection = useRef(firstAgentId !== undefined);

  useEffect(() => {
    if (!initializedSelection.current && firstAgentId) {
      initializedSelection.current = true;
      setSelectedMemberId(firstAgentId);
      return;
    }
    if (selectedMemberId && !props.members.some((member) => member.id === selectedMemberId)) {
      setSelectedMemberId(undefined);
    }
  }, [firstAgentId, props.members, selectedMemberId]);

  return (
    <aside className={`wr-member-rail wr-member-rail-${variant} ${props.className ?? ''}`}>
      <div className="wr-member-rail-heading">
        <div className="wr-rail-label"><span>Members</span><span>{props.members.filter((m) => m.kind !== 'system').length}</span></div>
        {(props.canManageAgents ?? true) && (
          <SpawnAgentDialog adapters={props.adapters} connection={props.connection} />
        )}
      </div>
      <ul className="mt-3">
        {props.members
          .filter((m) => m.kind !== 'system')
          .map((m) => (
            <MemberCard
              key={m.id}
              member={m}
              detail={props.details[m.id]}
              history={props.history[m.id] ?? []}
              connection={props.connection}
              expanded={m.kind === 'agent' ? selectedMemberId === m.id : undefined}
              onToggle={m.kind === 'agent'
                ? () => setSelectedMemberId((current) => current === m.id ? undefined : m.id)
                : undefined}
              canManage={props.canManageAgents}
            />
          ))}
      </ul>
    </aside>
  );
}

export interface ExtensionRunSummary {
  id: string;
  description?: string;
  agentType?: string;
  transcriptPath?: string;
  summary?: string;
  ended: boolean;
}

export function runEventPresentation(event: WireEvent): { label: string; detail?: string; tone: string } {
  const compact = (value: unknown): string => {
    const rendered = typeof value === 'string' ? value : JSON.stringify(value);
    return rendered.length > 220 ? `${rendered.slice(0, 217)}...` : rendered;
  };
  if (event.type === 'run.item') {
    const labels: Record<typeof event.item_type, string> = {
      tool_call: 'Tool call',
      tool_result: 'Tool result',
      reasoning_summary: 'Reasoning summary',
      text_delta: 'Response draft',
      commit: 'Commit recorded',
      file_change: 'File changed',
    };
    return {
      label: labels[event.item_type],
      detail: compact(event.payload),
      tone: event.item_type === 'commit' || event.item_type === 'file_change' ? 'change' : 'work',
    };
  }
  if (event.type === 'run.started') {
    return { label: 'Run started', detail: `Triggered by #${String(event.trigger_msg)}`, tone: 'work' };
  }
  if (event.type === 'run.completed') {
    return { label: `Run ${event.status}`, detail: event.final_text, tone: event.status === 'completed' ? 'success' : 'danger' };
  }
  if (event.type === 'ask.raised' || event.type === 'approval.raised') {
    return { label: event.type === 'ask.raised' ? 'Question raised' : 'Approval raised', detail: event.card.prompt, tone: 'attention' };
  }
  if (event.type === 'member.state') {
    return { label: 'Member state changed', detail: event.state.replaceAll('_', ' '), tone: 'work' };
  }
  return {
    label: event.type === 'extension.started' ? 'Extension started' : 'Extension finished',
    detail: event.type === 'extension.started' ? event.description : event.summary,
    tone: 'extension',
  };
}

function RunEventIcon(props: { event: WireEvent }) {
  if (props.event.type !== 'run.item') return <Activity aria-hidden="true" size={15} />;
  if (props.event.item_type === 'tool_call' || props.event.item_type === 'tool_result') {
    return <Wrench aria-hidden="true" size={15} />;
  }
  if (props.event.item_type === 'commit') return <GitCommitHorizontal aria-hidden="true" size={15} />;
  if (props.event.item_type === 'file_change') return <FileCode2 aria-hidden="true" size={15} />;
  return <FileText aria-hidden="true" size={15} />;
}

// harn:assume extensions-not-addressable-v1 ref=extension-run-rendering
export function extensionRunSummaries(events: WireEvent[]): ExtensionRunSummary[] {
  const extensions = new Map<string, ExtensionRunSummary>();
  for (const event of events) {
    if (event.type === 'extension.started') {
      extensions.set(event.ext_member, {
        id: event.ext_member,
        description: event.description,
        agentType: event.agent_type,
        transcriptPath: event.transcript_path,
        ended: false,
      });
    } else if (event.type === 'extension.ended') {
      const current = extensions.get(event.ext_member) ?? {
        id: event.ext_member,
        ended: false,
      };
      extensions.set(event.ext_member, {
        ...current,
        transcriptPath: event.transcript_path ?? current.transcriptPath,
        summary: event.summary,
        ended: true,
      });
    }
  }
  return [...extensions.values()];
}

export function RunMessageView(props: {
  message: Message;
  authorHandle: string;
  liveEventCount: number;
  room: string;
  token: string;
  onInspect?: () => void;
}) {
  const run = props.message.run!;
  const [expanded, setExpanded] = useState(false);
  const [events, setEvents] = useState<WireEvent[] | undefined>(undefined);
  const running = run.status === 'running';
  const extensions = extensionRunSummaries(events ?? []);
  const tokenTotal = run.usage
    ? run.usage.input_tokens + run.usage.output_tokens
    : undefined;

  useEffect(() => {
    if (expanded && events === undefined) {
      fetchRunEvents(props.room, props.message.id, { token: props.token })
        .then(setEvents)
        .catch(() => setEvents([]));
    }
  }, [expanded, events, props.room, props.message.id, props.token]);

  return (
    <div
      id={String(props.message.id)}
      data-testid={`run-${props.message.id}`}
      data-run-status={run.status}
      className="wr-run-card scroll-mt-16"
    >
      <div className="wr-run-heading">
        <span className="wr-actor-mark wr-actor-agent" aria-hidden="true">
          <Bot size={18} />
        </span>
        <button
          type="button"
          data-testid={`run-${props.message.id}-toggle`}
          aria-expanded={expanded}
          aria-controls={`run-${String(props.message.id)}-events`}
          onClick={() => setExpanded((e) => !e)}
          className="wr-run-toggle"
        >
          {expanded ? <ChevronDown aria-hidden="true" size={16} /> : <ChevronRight aria-hidden="true" size={16} />}
          <span className="wr-run-identity">
            <strong>@{props.authorHandle}</strong>
            <small>
              <Clock3 aria-hidden="true" size={12} />
              {new Date(run.started_ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </small>
          </span>
          {running ? (
            <span data-testid={`run-${props.message.id}-live`} className="wr-run-status is-running">
              running · {props.liveEventCount} events
            </span>
          ) : (
            <span className={`wr-run-status is-${run.status}`}>
              {run.status}
            </span>
          )}
        </button>
        {props.onInspect && (
          <button
            type="button"
            data-testid={`run-${props.message.id}-inspect`}
            aria-label={`Inspect run ${String(props.message.id)}`}
            title="Inspect run"
            className="wr-icon-button"
            onClick={props.onInspect}
          >
            <PanelRight aria-hidden="true" size={16} />
          </button>
        )}
        <MessagePermalink id={props.message.id} />
      </div>
      {!running && props.message.body !== '' && (
        <p data-testid={`run-${props.message.id}-body`} className="wr-run-body">
          {props.message.body}
        </p>
      )}
      {!running && run.usage && (
        <div className="wr-run-summary" aria-label="Run usage">
          <span>{tokenTotal?.toLocaleString()} tokens</span>
          <span>{run.tool_calls} tool calls</span>
          <span>{run.usage.cost_usd === undefined ? 'cost not reported' : `$${run.usage.cost_usd.toFixed(2)}`}</span>
        </div>
      )}
      {expanded && (
        <div id={`run-${String(props.message.id)}-events`} data-testid={`run-${props.message.id}-events`} className="wr-run-events">
          {extensions.length > 0 && (
            <div data-testid={`run-${props.message.id}-extensions`} className="wr-run-extensions">
              {extensions.map((extension) => (
                <div
                  key={extension.id}
                  data-testid={`run-${props.message.id}-extension-${extension.id}`}
                >
                  <div className="wr-extension-heading">
                    <strong>
                      {extension.description ?? `extension ${extension.id.slice(-6)}`}
                    </strong>
                    <span data-state={extension.ended ? 'ended' : 'running'}>
                      {extension.ended ? 'finished' : 'running'}
                    </span>
                    {extension.agentType && <span>{extension.agentType}</span>}
                  </div>
                  {extension.summary && <p>{extension.summary}</p>}
                </div>
              ))}
            </div>
          )}
          <ol className="wr-run-event-list">
            {(events ?? [])
              .filter((event) => event.type !== 'extension.started' && event.type !== 'extension.ended')
              .map((event, i) => {
                const presentation = runEventPresentation(event);
                return (
                  <li key={i} data-tone={presentation.tone}>
                    <span className="wr-event-icon"><RunEventIcon event={event} /></span>
                    <span>
                      <strong>{presentation.label}</strong>
                      {presentation.detail && <code>{presentation.detail}</code>}
                    </span>
                  </li>
                );
              })}
            {events !== undefined && events.length === 0 && <li>(no journaled events)</li>}
          </ol>
        </div>
      )}
    </div>
  );
}
// harn:end extensions-not-addressable-v1

export function RunStallBadge(props: { message: Message }) {
  if (props.message.run?.status !== 'running' || !props.message.run.stalled_since) return null;
  return (
    <span
      data-testid={`run-${props.message.id}-stalled`}
      className="wr-stall-badge"
    >
      stalled
    </span>
  );
}

export function AskCardView(props: {
  message: Message;
  authorHandle: string;
  answered: boolean;
  connection: Connection;
  canAnswer?: boolean;
}) {
  const ask = props.message.ask!;
  const [sent, setSent] = useState(false);
  const done = props.answered || sent;
  const approval = ask.kind === 'approval';
  return (
    <div
      id={String(props.message.id)}
      data-testid={`card-${props.message.id}`}
      className="wr-ask-card scroll-mt-16"
    >
      <div className="wr-ask-heading">
        <span className="wr-ask-symbol" aria-hidden="true">
          {approval ? <ShieldAlert size={20} /> : <CircleHelp size={20} />}
        </span>
        <div>
          <strong>{approval ? 'Approval required' : 'Question needs you'}</strong>
          <p>
            {ask.kind === 'ask' ? 'question from' : 'approval requested by'} @{props.authorHandle}
            {ask.tool && ` · ${ask.tool}`}
          </p>
        </div>
        <MessagePermalink id={props.message.id} />
      </div>
      <p className="wr-ask-prompt">{ask.prompt}</p>
      {ask.detail && <code className="wr-ask-detail">{ask.detail}</code>}
      {(props.canAnswer ?? true) && <div className="wr-ask-actions">
        {(ask.options ?? []).map((option, index) => {
          const destructive = /^(deny|reject|no|cancel)$/i.test(option.label);
          const permission = approval && !destructive;
          const descriptionId = option.description
            ? `card-${String(props.message.id)}-option-${String(index)}-description`
            : undefined;
          return (
          <button
            key={option.label}
            type="button"
            data-testid={`card-${props.message.id}-option-${option.label}`}
            disabled={done}
            title={option.description}
            aria-describedby={descriptionId}
            onClick={() => {
              props.connection.act({
                act: 'answer_interaction',
                interaction_id: String(props.message.id), // the card's #N — stable across re-raises
                answer: option.label,
              });
              setSent(true);
            }}
            className={`wr-ask-option min-h-11 px-4 text-sm disabled:opacity-40 ${destructive ? 'is-destructive' : ''} ${permission ? 'is-permission' : ''}`}
          >
            {destructive ? <CircleX aria-hidden="true" size={17} /> : permission ? <CircleCheck aria-hidden="true" size={17} /> : null}
            <span className="wr-option-copy">
              <span>{option.label}</span>
              {option.description && <small id={descriptionId}>{option.description}</small>}
            </span>
          </button>
          );
        })}
      </div>}
      {done && <p className="mt-1 text-xs text-zinc-400">answered</p>}
    </div>
  );
}

export function HoldBanner(props: {
  held: Delivery[];
  handleOf: (memberId: string) => string;
  connection: Connection;
  canRelease?: boolean;
  canRedeliver?: boolean;
}) {
  if (props.held.length === 0) return null;
  return (
    <div data-testid="hold-banner" className="wr-hold-banner">
      {props.held.map((delivery) => (
        <div key={delivery.id} className="wr-hold-row">
          <span className="wr-hold-symbol" aria-hidden="true"><PauseCircle size={19} /></span>
          <span className="wr-hold-copy">
            <strong>Delivery held</strong>
            <small>#{delivery.message_id} to @{props.handleOf(delivery.recipient)}</small>
          </span>
          {(props.canRelease ?? true) && <button
            type="button"
            data-testid={`release-${delivery.id}`}
            onClick={() => props.connection.act({ act: 'release_hold', delivery_id: delivery.id })}
            className="wr-attention-button min-h-11 px-3 text-xs"
          >
            <Play aria-hidden="true" size={15} /> Release
          </button>}
          {(props.canRedeliver ?? true) && <button
            type="button"
            onClick={() => props.connection.act({ act: 'redeliver', delivery_id: delivery.id })}
            className="wr-secondary-button min-h-11 px-3 text-xs"
          >
            <RotateCcw aria-hidden="true" size={15} /> Redeliver
          </button>}
        </div>
      ))}
    </div>
  );
}

// harn:assume implied-recipient-visible-before-send ref=composer-implied-recipient
/**
 * PROTOCOL invariant 3: the human always sees where the draft will go BEFORE
 * sending — explicit mentions when present, else the latest FINALIZED agent
 * author (the untagged default), else room commentary (delivered to nobody).
 */
export function impliedRecipient(
  draft: string,
  members: Record<string, Member>,
  messages: Record<number, Message>,
): { kind: 'mentions' | 'default' | 'commentary'; label: string } {
  const roster = Object.values(members);
  const byId = new Map(roster.map((member) => [member.id, member]));
  const handles: string[] = [];
  for (const span of parseBody(draft, roster).mentions) {
    const member = byId.get(span.member_id);
    if (member && !handles.includes(member.handle)) {
      handles.push(member.handle);
    }
  }
  if (handles.length > 0) {
    return { kind: 'mentions', label: `→ ${handles.map((h) => `@${h}`).join(' ')}` };
  }
  const fallback = latestFinalizedAgentAuthor(messages, members);
  if (fallback) return { kind: 'default', label: `→ @${fallback.handle} (untagged default)` };
  return { kind: 'commentary', label: 'room commentary — delivered to nobody' };
}

export function Composer(props: {
  members: Record<string, Member>;
  messages: Record<number, Message>;
  connection: Connection;
}) {
  const [draft, setDraft] = useState('');
  const implied = useMemo(
    () => impliedRecipient(draft, props.members, props.messages),
    [draft, props.members, props.messages],
  );
  const send = (): void => {
    if (draft.trim() === '') return;
    props.connection.post(draft);
    setDraft('');
  };
  return (
    <div className="wr-composer">
      <div className="wr-composer-heading">
        <span>Message the room</span>
        <p data-testid="implied-recipient" data-kind={implied.kind} className="wr-recipient">
          {implied.label}
        </p>
      </div>
      <div className="wr-composer-row">
        <textarea
          data-testid="composer-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          aria-label="Message the room"
          placeholder="Message the room"
          className="wr-input wr-composer-input min-h-12 min-w-0 flex-1 resize-none px-3 py-2 text-base sm:text-sm"
        />
        <button
          type="button"
          data-testid="composer-send"
          aria-label="Send message"
          title="Send message"
          onClick={send}
          disabled={draft.trim() === ''}
          className="wr-send-button h-12 w-12 shrink-0 disabled:opacity-40"
        >
          <Send aria-hidden="true" size={20} />
        </button>
      </div>
    </div>
  );
}
// harn:end implied-recipient-visible-before-send

export function MessageRow(props: { message: Message; authorHandle: string; mine: boolean }) {
  const { message } = props;
  const [note, setNote] = useState<LedgerNote>();
  const [noteError, setNoteError] = useState(false);
  const ledgerTrigger = useRef<HTMLButtonElement>(null);
  const ledgerDialog = useRef<HTMLElement>(null);
  const ledgerClose = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!note && !noteError) return;
    requestAnimationFrame(() => ledgerClose.current?.focus());
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setNote(undefined);
        setNoteError(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...(ledgerDialog.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
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
    window.addEventListener('keydown', dismiss);
    return () => {
      window.removeEventListener('keydown', dismiss);
      ledgerTrigger.current?.focus();
    };
  }, [note, noteError]);
  const body = (
    <>
      {ledgerTextSegments(message.body).map((segment, index) =>
        segment.kind === 'text' ? segment.text : (
          <button
            ref={ledgerTrigger}
            key={`${segment.name}-${String(index)}`}
            type="button"
            data-testid={`ledger-ref-${segment.name}`}
            className="text-sky-300 underline decoration-zinc-600 underline-offset-2 hover:text-sky-200"
            onClick={() => {
              setNoteError(false);
              const urlToken = new URLSearchParams(window.location.search).get('token') ?? '';
              void storedBrowserAccess()
                .catch(() => undefined)
                .then((access) => fetchLedgerNote(message.room, segment.name, {
                  token: access?.origin === window.location.origin ? access.token : urlToken,
                }))
                .then(setNote)
                .catch(() => setNoteError(true));
            }}
          >
            {segment.text}
          </button>
        ),
      )}
    </>
  );
  const viewer = note || noteError ? (
    <div className="wr-modal-backdrop fixed inset-0 z-30 flex items-center justify-center p-4">
      <section
        ref={ledgerDialog}
        role="dialog"
        aria-modal="true"
        aria-label={note ? `Ledger note ${note.name}` : 'Ledger note unavailable'}
        data-testid="ledger-note-dialog"
        className="wr-focused-glass max-h-[80vh] w-full max-w-2xl overflow-auto p-5"
      >
        <div className="wr-dialog-heading">
          <div>
            <h2>{note ? `[[${note.name}]]` : 'Note unavailable'}</h2>
            <p>Read-only ledger note</p>
          </div>
          <button
            ref={ledgerClose}
            type="button"
            aria-label="Close ledger note"
            className="wr-icon-button"
            onClick={() => {
              setNote(undefined);
              setNoteError(false);
            }}
          >
            <X aria-hidden="true" size={18} />
          </button>
        </div>
        {note && <pre className="mt-4 whitespace-pre-wrap font-sans text-sm text-zinc-200">{note.body}</pre>}
      </section>
    </div>
  ) : null;
  if (message.kind === 'system') {
    return (
      <>
        <p
          id={String(message.id)}
          data-testid={`msg-${message.id}`}
        className="wr-system-message scroll-mt-16 target:text-sky-300"
        >
          {body} <MessagePermalink id={message.id} />
        </p>
        {viewer}
      </>
    );
  }
  return (
    <>
      <div
        id={String(message.id)}
        data-testid={`msg-${message.id}`}
        className={`wr-message scroll-mt-16 ${props.mine ? 'is-mine' : ''} target:border-l-2 target:border-sky-600 target:pl-2`}
      >
        <span className="wr-actor-mark wr-actor-human" aria-hidden="true"><UserRound size={17} /></span>
        <div className="wr-message-content">
          <div className="wr-message-meta">
            <strong>@{props.authorHandle}</strong>
            <time dateTime={message.ts}>{new Date(message.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
            <MessagePermalink id={message.id} />
          </div>
          <p className="whitespace-pre-wrap text-zinc-100">{body}</p>
        </div>
      </div>
      {viewer}
    </>
  );
}

export const handleLookup = (members: Record<string, Member>) => (memberId: string): string =>
  members[memberId]?.handle ?? 'unknown';

export const isMe = (
  members: Record<string, Member>,
  memberId: string,
  selfMemberId?: string,
): boolean => me(members, selfMemberId)?.id === memberId;
