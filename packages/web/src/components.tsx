import { parseBody, type Delivery, type Member, type Message, type RoomMeter, type WireEvent } from '@wireroom/protocol';
import { useEffect, useMemo, useState } from 'react';

import { fetchRunEvents } from './api.js';
import type { AdapterRegistration, MemberDetail } from './api.js';
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

export function Header(props: {
  roomName: string;
  connected: boolean;
  meter: RoomMeter | undefined;
  unread: number;
}) {
  return (
    <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
      <h1 className="font-semibold text-zinc-100">{props.roomName}</h1>
      <span
        data-testid="connection"
        className={`h-2 w-2 rounded-full ${props.connected ? 'bg-emerald-500' : 'bg-red-500'}`}
        title={props.connected ? 'connected' : 'disconnected'}
      />
      {props.meter && (
        <span data-testid="meter" className="text-xs text-zinc-400">
          today · {props.meter.turns} turns · ${props.meter.cost_usd.toFixed(2)}
        </span>
      )}
      <span className="ml-auto" />
      <span data-testid="inbox-badge" className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-200">
        inbox {props.unread > 0 ? <strong className="text-amber-400">{props.unread}</strong> : 0}
      </span>
    </header>
  );
}

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
        className="w-full border border-zinc-700 px-2 py-1 text-sm text-zinc-100 hover:bg-zinc-800"
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
                className="border border-zinc-700 px-3 py-1 text-sm text-zinc-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                data-testid="spawn-submit"
                disabled={props.adapters.length === 0}
                className="bg-sky-700 px-3 py-1 text-sm text-white disabled:opacity-40"
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
        </dd>
      </dl>
      {props.member.policy && (
        <span className="mt-2 inline-block rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
          {props.member.policy}
        </span>
      )}
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
            className="border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100"
          />
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            required
            className="border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              data-testid={`rename-${props.member.handle}-submit`}
              className="bg-sky-800 px-2 py-1 text-xs text-white"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setRenaming(false)}
              className="border border-zinc-700 px-2 py-1 text-xs text-zinc-300"
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
            className="border border-zinc-700 px-2 py-1 text-xs text-zinc-300"
          >
            Rename
          </button>
          {props.member.custody === 'mirrored' ? (
            <button
              type="button"
              data-testid={`adopt-${props.member.handle}`}
              onClick={() => props.connection.act({ act: 'adopt', member_id: props.member.id })}
              className="bg-emerald-800 px-2 py-1 text-xs text-white"
            >
              Adopt
            </button>
          ) : state === 'dead' ? (
            <button
              type="button"
              data-testid={`revive-${props.member.handle}`}
              disabled={!props.member.session_ref}
              onClick={() => props.connection.act({ act: 'revive', member_id: props.member.id })}
              className="bg-emerald-800 px-2 py-1 text-xs text-white disabled:opacity-40"
            >
              Revive
            </button>
          ) : (
            <button
              type="button"
              data-testid={`kill-${props.member.handle}`}
              onClick={() => props.connection.act({ act: 'kill', member_id: props.member.id })}
              className="bg-red-900 px-2 py-1 text-xs text-red-100"
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
              className="border border-zinc-700 px-2 py-1 text-xs text-zinc-300"
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
}) {
  return (
    <aside className="w-80 shrink-0 overflow-y-auto border-r border-zinc-800 p-3">
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

  useEffect(() => {
    if (expanded && events === undefined) {
      fetchRunEvents(props.room, props.message.id, { token: props.token })
        .then(setEvents)
        .catch(() => setEvents([]));
    }
  }, [expanded, events, props.room, props.message.id, props.token]);

  return (
    <div data-testid={`run-${props.message.id}`} data-run-status={run.status} className="rounded border border-zinc-800 p-2">
      <button
        type="button"
        data-testid={`run-${props.message.id}-toggle`}
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 text-left text-xs text-zinc-400"
      >
        <span>{expanded ? '▾' : '▸'}</span>
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
            {` · #${props.message.id}`}
          </span>
        )}
      </button>
      {!running && props.message.body !== '' && (
        <p data-testid={`run-${props.message.id}-body`} className="mt-1 whitespace-pre-wrap text-sm text-zinc-100">
          {props.message.body}
        </p>
      )}
      {expanded && (
        <ol data-testid={`run-${props.message.id}-events`} className="mt-2 space-y-1 border-t border-zinc-800 pt-2 text-xs text-zinc-400">
          {(events ?? []).map((event, i) => (
            <li key={i}>
              {event.type === 'run.item' ? `${event.item_type}: ${JSON.stringify(event.payload).slice(0, 120)}` : event.type}
            </li>
          ))}
          {events !== undefined && events.length === 0 && <li>(no journaled events)</li>}
        </ol>
      )}
    </div>
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
    <div data-testid={`card-${props.message.id}`} className="rounded border border-fuchsia-900 bg-fuchsia-950/30 p-2">
      <p className="text-xs text-fuchsia-300">
        {ask.kind === 'ask' ? 'question from' : 'approval requested by'} @{props.authorHandle}
        {ask.tool && ` · ${ask.tool}`}
      </p>
      <p className="mt-1 text-sm text-zinc-100">{ask.prompt}</p>
      {ask.detail && <code className="mt-1 block text-xs text-zinc-400">{ask.detail}</code>}
      <div className="mt-2 flex gap-2">
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
            className="rounded bg-fuchsia-800 px-2 py-1 text-xs text-white disabled:opacity-40"
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
    <div data-testid="hold-banner" className="border-b border-amber-900 bg-amber-950/40 px-4 py-2 text-sm text-amber-200">
      {props.held.map((delivery) => (
        <div key={delivery.id} className="flex items-center gap-3">
          <span>
            delivery #{delivery.message_id} → @{props.handleOf(delivery.recipient)} is held
          </span>
          <button
            type="button"
            data-testid={`release-${delivery.id}`}
            onClick={() => props.connection.act({ act: 'release_hold', delivery_id: delivery.id })}
            className="rounded bg-amber-700 px-2 py-0.5 text-xs text-white"
          >
            release
          </button>
          <button
            type="button"
            onClick={() => props.connection.act({ act: 'redeliver', delivery_id: delivery.id })}
            className="rounded bg-zinc-700 px-2 py-0.5 text-xs text-white"
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
    <div className="border-t border-zinc-800 p-3">
      <p data-testid="implied-recipient" data-kind={implied.kind} className="mb-1 text-xs text-zinc-400">
        {implied.label}
      </p>
      <div className="flex gap-2">
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
          placeholder="Message the room — @handle to address, #N to reference"
          className="flex-1 resize-none rounded border border-zinc-700 bg-zinc-900 p-2 text-sm text-zinc-100"
        />
        <button
          type="button"
          data-testid="composer-send"
          onClick={send}
          className="rounded bg-sky-700 px-3 text-sm text-white"
        >
          send
        </button>
      </div>
    </div>
  );
}
// harn:end implied-recipient-visible-before-send

export function MessageRow(props: { message: Message; authorHandle: string; mine: boolean }) {
  const { message } = props;
  if (message.kind === 'system') {
    return (
      <p data-testid={`msg-${message.id}`} className="text-center text-xs italic text-zinc-500">
        {message.body}
      </p>
    );
  }
  return (
    <div data-testid={`msg-${message.id}`} className="text-sm">
      <span className={`font-medium ${props.mine ? 'text-sky-300' : 'text-emerald-300'}`}>@{props.authorHandle}</span>
      <span className="ml-2 text-[10px] text-zinc-500">#{message.id}</span>
      <p className="whitespace-pre-wrap text-zinc-100">{message.body}</p>
    </div>
  );
}

export const handleLookup = (members: Record<string, Member>) => (memberId: string): string =>
  members[memberId]?.handle ?? 'unknown';

export const isMe = (members: Record<string, Member>, memberId: string): boolean =>
  me(members)?.id === memberId;
