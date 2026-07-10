import {
  parseBody,
  type Delivery,
  type Member,
  type Message,
  type RoomMeter,
  type WireEvent,
} from '@wireroom/protocol';
import {
  ChevronDown,
  ChevronRight,
  Menu,
  Send,
  Settings,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { fetchLedgerNote, fetchRunEvents } from './api.js';
import type { AdapterRegistration, LedgerNote, MemberDetail } from './api.js';
import { storedBrowserAccess } from './crypto.js';
import { latestFinalizedAgentAuthor, me, type MemberStateObservation } from './state.js';
import type { Connection } from './ws.js';

const stateDot: Record<string, string> = {
  idle: 'bg-emerald-500',
  running: 'bg-sky-500 animate-pulse',
  queued: 'bg-amber-500',
  awaiting_input: 'bg-fuchsia-500',
  paused: 'bg-zinc-400',
  dead: 'bg-red-600',
  unreachable: 'bg-zinc-500',
  custody_uncertain: 'bg-orange-500',
};

// harn:assume permalink-ids-stable ref=message-permalink-rendering
function MessagePermalink(props: { id: number }) {
  return (
    <a
      href={`#${props.id}`}
      aria-label={`Permalink to message ${String(props.id)}`}
      className="inline-flex min-h-11 min-w-11 items-center justify-center text-[11px] text-zinc-500 hover:text-sky-300"
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
  onOpenNavigation?: () => void;
}) {
  return (
    <header className="flex min-h-14 items-center gap-2 border-b border-zinc-800 bg-zinc-950/95 px-2 sm:gap-3 sm:px-4">
      {props.onOpenNavigation && (
        <button
          type="button"
          data-testid="open-room-drawer"
          aria-label="Open rooms and members"
          title="Rooms and members"
          onClick={props.onOpenNavigation}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center text-zinc-300 hover:bg-zinc-800 lg:hidden"
        >
          <Menu aria-hidden="true" size={21} />
        </button>
      )}
      <h1 className="min-w-0 truncate text-sm font-semibold text-zinc-100 sm:text-base">{props.roomName}</h1>
      <span
        data-testid="connection"
        className={`h-2 w-2 shrink-0 rounded-full ${props.connected ? 'bg-emerald-500' : 'bg-red-500'}`}
        title={props.connected ? 'connected' : 'disconnected'}
      />
      {props.meter && (
        <span data-testid="meter" className="hidden min-w-0 truncate text-xs text-zinc-400 min-[390px]:inline">
          {props.meter.turns} turns · ${props.meter.cost_usd.toFixed(2)}
          {(props.meter.uncosted_tokens ?? 0) > 0 && ` · ${props.meter.uncosted_tokens ?? 0} tokens uncosted`}
        </span>
      )}
      <span className="ml-auto" />
      <a
        href={`/settings?${new URLSearchParams({ room: props.roomId }).toString()}`}
        data-testid="room-settings"
        aria-label="Settings"
        title="Settings"
        className="inline-flex h-11 w-11 items-center justify-center text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
      >
        <Settings aria-hidden="true" size={19} />
      </a>
      <span data-testid="inbox-badge" className="inline-flex min-h-7 min-w-7 items-center justify-center rounded bg-zinc-800 px-2 text-xs text-zinc-200" title={`${String(props.unread)} unread`}>
        <span className="hidden sm:inline">inbox&nbsp;</span>
        {props.unread > 0 ? <strong className="text-amber-400">{props.unread}</strong> : 0}
      </span>
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

  useEffect(() => {
    if (harness === '' && props.adapters[0]) setHarness(props.adapters[0].id);
  }, [harness, props.adapters]);

  const submit = (): void => {
    if (!harness || !handle || !cwd) return;
    props.connection.act({ act: 'spawn', harness, handle, cwd, policy });
    setHandle('');
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        data-testid="spawn-agent"
        onClick={() => setOpen(true)}
        className="min-h-11 w-full border border-zinc-700 px-3 text-sm text-zinc-100 hover:bg-zinc-800"
      >
        Spawn agent
      </button>
      {open && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/70 p-4">
          <form
            role="dialog"
            aria-modal="true"
            aria-label="Spawn agent"
            data-testid="spawn-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
            className="w-full max-w-md border border-zinc-700 bg-zinc-950 p-4 shadow-xl"
          >
            <h2 className="text-sm font-semibold text-zinc-100">Spawn agent</h2>
            <label className="mt-3 block text-xs text-zinc-400">
              Harness
              <select
                data-testid="spawn-harness"
                value={harness}
                onChange={(event) => setHarness(event.target.value)}
                className="mt-1 w-full border border-zinc-700 bg-zinc-900 p-2 text-sm text-zinc-100"
              >
                {props.adapters.map((adapter) => (
                  <option key={adapter.id} value={adapter.id}>
                    {adapter.id} {adapter.capabilities.resume ? '' : '(ephemeral)'}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-3 block text-xs text-zinc-400">
              Handle
              <input
                data-testid="spawn-handle"
                value={handle}
                onChange={(event) => setHandle(event.target.value)}
                pattern="[a-z0-9][a-z0-9-]{1,30}"
                required
                className="mt-1 w-full border border-zinc-700 bg-zinc-900 p-2 text-sm text-zinc-100"
              />
            </label>
            <label className="mt-3 block text-xs text-zinc-400">
              Working directory
              <input
                data-testid="spawn-cwd"
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                required
                className="mt-1 w-full border border-zinc-700 bg-zinc-900 p-2 text-sm text-zinc-100"
              />
            </label>
            <label className="mt-3 block text-xs text-zinc-400">
              Policy
              <select
                data-testid="spawn-policy"
                value={policy}
                onChange={(event) => setPolicy(event.target.value)}
                className="mt-1 w-full border border-zinc-700 bg-zinc-900 p-2 text-sm text-zinc-100"
              >
                <option value="read-only">read-only</option>
                <option value="workspace-write">workspace-write</option>
                <option value="full-access">full-access</option>
              </select>
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="min-h-11 border border-zinc-700 px-3 text-sm text-zinc-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                data-testid="spawn-submit"
                disabled={props.adapters.length === 0}
                className="min-h-11 bg-sky-700 px-4 text-sm text-white disabled:opacity-40"
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
}) {
  const [renaming, setRenaming] = useState(false);
  const [handle, setHandle] = useState(props.member.handle);
  const [displayName, setDisplayName] = useState(props.member.display_name);
  const state = props.member.state ?? 'idle';
  const tokens =
    (props.detail?.spend.input_tokens ?? 0) + (props.detail?.spend.output_tokens ?? 0);

  useEffect(() => {
    setHandle(props.member.handle);
    setDisplayName(props.member.display_name);
  }, [props.member.display_name, props.member.handle]);

  if (props.member.kind !== 'agent') {
    return (
      <li data-testid={`member-${props.member.handle}`} className="flex items-center gap-2 py-2 text-sm">
        <span className={`h-2 w-2 rounded-full ${stateDot[state] ?? 'bg-zinc-400'}`} />
        <span className="min-w-0 truncate text-zinc-200">@{props.member.handle}</span>
        <span className="ml-auto text-[10px] uppercase text-zinc-500">{props.member.kind}</span>
      </li>
    );
  }

  return (
    <li
      data-testid={`member-${props.member.handle}`}
      className="border-b border-zinc-800 py-3 text-sm"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${stateDot[state] ?? 'bg-zinc-400'}`} />
        <strong className="min-w-0 truncate font-medium text-zinc-100">@{props.member.handle}</strong>
        <span className="text-[10px] uppercase text-zinc-500">{state}</span>
        {(props.detail?.queued_count ?? 0) > 0 && (
          <span
            data-testid={`member-${props.member.handle}-queued`}
            className="ml-auto rounded bg-amber-900 px-1.5 py-0.5 text-[10px] text-amber-200"
          >
            {props.detail!.queued_count} queued
          </span>
        )}
      </div>
      <dl className="mt-2 grid grid-cols-[4rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px]">
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
        <span className="mt-2 inline-block rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
          {props.member.policy}
        </span>
      )}
      {/* harn:assume custody-uncertain-never-double-writes ref=attach-custody-web-hint */}
      {props.member.session_ref && props.member.custody !== 'mirrored' && state !== 'dead' && (
        <div className="mt-2 flex min-w-0 items-center gap-2 text-[10px]">
          <code
            data-testid={`attach-command-${props.member.handle}`}
            className="min-w-0 flex-1 truncate bg-zinc-900 px-1.5 py-1 text-zinc-400"
          >
            wireroom attach @{props.member.handle}
          </code>
          <button
            type="button"
            title="Copy attach command"
            onClick={() =>
              void navigator.clipboard?.writeText(`wireroom attach @${props.member.handle}`)
            }
            className="min-h-11 shrink-0 border border-zinc-700 px-3 text-zinc-300"
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
      {renaming ? (
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
      )}
    </li>
  );
}

export function MemberRail(props: {
  members: Member[];
  details: Record<string, MemberDetail>;
  history: Record<string, MemberStateObservation[]>;
  adapters: AdapterRegistration[];
  connection: Connection;
  className?: string;
}) {
  return (
    <aside className={`w-80 shrink-0 overflow-y-auto border-r border-zinc-800 p-3 ${props.className ?? ''}`}>
      <SpawnAgentDialog adapters={props.adapters} connection={props.connection} />
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
}) {
  const run = props.message.run!;
  const [expanded, setExpanded] = useState(false);
  const [events, setEvents] = useState<WireEvent[] | undefined>(undefined);
  const running = run.status === 'running';
  const extensions = extensionRunSummaries(events ?? []);

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
      className="scroll-mt-16 rounded border border-zinc-800 p-2 target:border-sky-600"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid={`run-${props.message.id}-toggle`}
          onClick={() => setExpanded((e) => !e)}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left text-xs text-zinc-400"
        >
          {expanded ? <ChevronDown aria-hidden="true" size={16} /> : <ChevronRight aria-hidden="true" size={16} />}
          <span className="text-zinc-300">@{props.authorHandle}</span>
          {running ? (
            <span data-testid={`run-${props.message.id}-live`} className="text-sky-400">
              running · {props.liveEventCount} events
            </span>
          ) : (
            <span>
              {run.status}
              {run.usage &&
                ` · ${run.usage.input_tokens + run.usage.output_tokens} tk` +
                  (run.usage.cost_usd !== undefined ? ` · $${run.usage.cost_usd.toFixed(2)}` : '')}
            </span>
          )}
        </button>
        <MessagePermalink id={props.message.id} />
      </div>
      {!running && props.message.body !== '' && (
        <p data-testid={`run-${props.message.id}-body`} className="mt-1 whitespace-pre-wrap text-sm text-zinc-100">
          {props.message.body}
        </p>
      )}
      {expanded && (
        <div data-testid={`run-${props.message.id}-events`} className="mt-2 border-t border-zinc-800 pt-2 text-xs text-zinc-400">
          {extensions.length > 0 && (
            <div data-testid={`run-${props.message.id}-extensions`} className="mb-2 space-y-2 border-l-2 border-sky-900 pl-3">
              {extensions.map((extension) => (
                <div
                  key={extension.id}
                  data-testid={`run-${props.message.id}-extension-${extension.id}`}
                >
                  <div className="flex items-center gap-2">
                    <strong className="text-zinc-200">
                      {extension.description ?? `extension ${extension.id.slice(-6)}`}
                    </strong>
                    <span className={extension.ended ? 'text-zinc-500' : 'text-sky-400'}>
                      {extension.ended ? 'finished' : 'running'}
                    </span>
                    {extension.agentType && <span>{extension.agentType}</span>}
                  </div>
                  {extension.summary && <p className="mt-1 whitespace-pre-wrap text-zinc-300">{extension.summary}</p>}
                </div>
              ))}
            </div>
          )}
          <ol className="space-y-1">
            {(events ?? [])
              .filter((event) => event.type !== 'extension.started' && event.type !== 'extension.ended')
              .map((event, i) => (
                <li key={i}>
                  {event.type === 'run.item' ? `${event.item_type}: ${JSON.stringify(event.payload).slice(0, 120)}` : event.type}
                </li>
              ))}
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
      className="mb-1 inline-block bg-amber-950 px-1.5 py-0.5 text-xs text-amber-300"
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
}) {
  const ask = props.message.ask!;
  const [sent, setSent] = useState(false);
  const done = props.answered || sent;
  return (
    <div
      id={String(props.message.id)}
      data-testid={`card-${props.message.id}`}
      className="scroll-mt-16 rounded-lg border border-amber-900/80 bg-amber-950/20 p-3 target:border-sky-600"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-amber-300">
          {ask.kind === 'ask' ? 'question from' : 'approval requested by'} @{props.authorHandle}
          {ask.tool && ` · ${ask.tool}`}
        </p>
        <MessagePermalink id={props.message.id} />
      </div>
      <p className="mt-1 text-sm text-zinc-100">{ask.prompt}</p>
      {ask.detail && <code className="mt-1 block text-xs text-zinc-400">{ask.detail}</code>}
      <div className="mt-3 flex flex-wrap gap-2">
        {(ask.options ?? []).map((option) => (
          <button
            key={option.label}
            type="button"
            data-testid={`card-${props.message.id}-option-${option.label}`}
            disabled={done}
            title={option.description}
            onClick={() => {
              props.connection.act({
                act: 'answer_interaction',
                interaction_id: String(props.message.id), // the card's #N — stable across re-raises
                answer: option.label,
              });
              setSent(true);
            }}
            className="min-h-11 rounded-md border border-zinc-700 bg-zinc-900 px-4 text-sm text-zinc-100 hover:border-sky-600 disabled:opacity-40"
          >
            {option.label}
          </button>
        ))}
      </div>
      {done && <p className="mt-1 text-xs text-zinc-400">answered</p>}
    </div>
  );
}

export function HoldBanner(props: {
  held: Delivery[];
  handleOf: (memberId: string) => string;
  connection: Connection;
}) {
  if (props.held.length === 0) return null;
  return (
    <div data-testid="hold-banner" className="border-b border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-200 sm:px-4">
      {props.held.map((delivery) => (
        <div key={delivery.id} className="flex flex-wrap items-center gap-2 sm:gap-3">
          <span className="min-w-0 flex-1">
            delivery #{delivery.message_id} → @{props.handleOf(delivery.recipient)} is held
          </span>
          <button
            type="button"
            data-testid={`release-${delivery.id}`}
            onClick={() => props.connection.act({ act: 'release_hold', delivery_id: delivery.id })}
            className="min-h-11 rounded-md bg-amber-700 px-3 text-xs text-white"
          >
            release
          </button>
          <button
            type="button"
            onClick={() => props.connection.act({ act: 'redeliver', delivery_id: delivery.id })}
            className="min-h-11 rounded-md bg-zinc-700 px-3 text-xs text-white"
          >
            redeliver
          </button>
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
    <div className="shrink-0 border-t border-zinc-800 bg-zinc-950/95 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:px-4">
      <p data-testid="implied-recipient" data-kind={implied.kind} className="mb-1 truncate text-xs text-zinc-400">
        {implied.label}
      </p>
      <div className="flex items-end gap-2">
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
          className="min-h-12 min-w-0 flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-base text-zinc-100 outline-none focus:border-sky-600 sm:text-sm"
        />
        <button
          type="button"
          data-testid="composer-send"
          aria-label="Send message"
          title="Send message"
          onClick={send}
          className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-40"
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
  const body = (
    <>
      {ledgerTextSegments(message.body).map((segment, index) =>
        segment.kind === 'text' ? segment.text : (
          <button
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
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={note ? `Ledger note ${note.name}` : 'Ledger note unavailable'}
        data-testid="ledger-note-dialog"
        className="max-h-[80vh] w-full max-w-2xl overflow-auto border border-zinc-700 bg-zinc-950 p-5 shadow-xl"
      >
        <div className="flex items-center gap-3 border-b border-zinc-800 pb-3">
          <h2 className="text-sm font-semibold text-zinc-100">
            {note ? `[[${note.name}]]` : 'Note unavailable'}
          </h2>
          <button
            type="button"
            aria-label="Close ledger note"
            className="ml-auto min-h-11 px-3 text-zinc-400 hover:text-zinc-100"
            onClick={() => {
              setNote(undefined);
              setNoteError(false);
            }}
          >
            Close
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
          className="scroll-mt-16 text-center text-xs italic text-zinc-500 target:text-sky-300"
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
        className="scroll-mt-16 text-sm target:border-l-2 target:border-sky-600 target:pl-2"
      >
        <span className={`font-medium ${props.mine ? 'text-sky-300' : 'text-emerald-300'}`}>@{props.authorHandle}</span>
        <span className="ml-2"><MessagePermalink id={message.id} /></span>
        <p className="whitespace-pre-wrap text-zinc-100">{body}</p>
      </div>
      {viewer}
    </>
  );
}

export const handleLookup = (members: Record<string, Member>) => (memberId: string): string =>
  members[memberId]?.handle ?? 'unknown';

export const isMe = (members: Record<string, Member>, memberId: string): boolean =>
  me(members)?.id === memberId;
