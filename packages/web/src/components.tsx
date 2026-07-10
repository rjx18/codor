import type { Delivery, Member, Message, RoomMeter, WireEvent } from '@wireroom/protocol';
import { useEffect, useMemo, useState } from 'react';

import { fetchRunEvents } from './api.js';
import { latestFinalizedAgentAuthor, me } from './state.js';
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

export function MemberRail(props: { members: Member[] }) {
  return (
    <aside className="w-48 shrink-0 border-r border-zinc-800 p-3">
      <ul className="space-y-2">
        {props.members
          .filter((m) => m.kind !== 'system')
          .map((m) => (
            <li key={m.id} data-testid={`member-${m.handle}`} className="flex items-center gap-2 text-sm">
              <span className={`h-2 w-2 rounded-full ${stateDot[m.state ?? 'idle'] ?? 'bg-zinc-400'}`} />
              <span className="text-zinc-200">@{m.handle}</span>
              {m.policy && <span className="rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">{m.policy}</span>}
            </li>
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
  const byHandle = new Map(Object.values(members).map((m) => [m.handle, m]));
  const handles: string[] = [];
  for (const match of draft.matchAll(/(^|[^\w`@])@([a-z0-9][a-z0-9-]*)/g)) {
    const member = byHandle.get(match[2]!);
    if (member && (member.kind === 'human' || member.kind === 'agent') && !handles.includes(member.handle)) {
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
