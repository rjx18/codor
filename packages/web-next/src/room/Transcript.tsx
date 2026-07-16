import type { Delivery, Member, Message } from '@codor/protocol';
import { ArrowDown, Check, CheckCheck, ChevronRight, Clock3, Copy, Quote, TerminalSquare } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { Connection } from '@legacy/ws.js';

import { fetchMessageHistory, fetchRunEvents } from '@legacy/api.js';
import {
  compactRunRow,
  diffStat,
  formatRunDuration,
  mergeRunEvents,
  presentRunEvents,
  type RunRow,
} from '@legacy/run-presenter.js';
import {
  HISTORY_PAGE_SIZE,
  pendingInteractions,
  sortedMessages,
  useRoomStore,
  type RunEventBuffer,
} from '@legacy/state.js';

import { useIsMobile } from '../app/session.js';
import { Chip, Modal, TypingDots } from '../primitives/primitives.js';
import { clockTime, memberAccent } from '../primitives/identity.js';
import { DiffViewer } from './ContextPanel.js';

/** Consecutive same-author messages within this window collapse their header. */
const GROUP_WINDOW_MS = 2 * 60_000;

export function Transcript(props: { room: string; token: () => string; connection: Connection }) {
  const messages = useRoomStore((s) => s.messages);
  const members = useRoomStore((s) => s.members);
  const selfId = useRoomStore((s) => s.selfMemberId);
  const historyCursor = useRoomStore((s) => s.historyCursor);
  const mergeHistoryPage = useRoomStore((s) => s.mergeHistoryPage);
  const connected = useRoomStore((s) => s.connected);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [hasOlder, setHasOlder] = useState(true);

  const inbox = useRoomStore((s) => s.inbox);
  const ordered = useMemo(() => sortedMessages(messages), [messages]);
  // Interaction cards stay in the timeline only while they need the operator;
  // resolved ones leave. pendingInteractions is the legacy single source of truth.
  const visible = useMemo(() => {
    const pending = new Set(
      pendingInteractions({ messages, inbox, members, selfMemberId: selfId }).map((m) => m.id),
    );
    return ordered.filter(
      (m) => (m.kind !== 'ask' && m.kind !== 'approval') || pending.has(m.id),
    );
  }, [ordered, messages, inbox, members, selfId]);

  // Working agents drive the typing indicator row. Derived with useMemo — a selector
  // returning a fresh array every snapshot would loop useSyncExternalStore forever.
  const workingAgents = useMemo(
    () => Object.values(members).filter((m) => m.kind === 'agent' && (m.state === 'running' || m.state === 'queued')),
    [members],
  );

  // Follow the tail unless the reader scrolled up; then offer the jump chip instead.
  const lastId = visible.at(-1)?.id;
  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    if (pinnedRef.current) {
      node.scrollTop = node.scrollHeight;
      setShowJump(false);
    } else {
      setShowJump(true);
    }
  }, [lastId]);

  const onScroll = (): void => {
    const node = scrollerRef.current;
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
    pinnedRef.current = nearBottom;
    setShowJump(!nearBottom);
    if (node.scrollTop < 80 && !historyBusy && hasOlder && historyCursor !== undefined && historyCursor > 1) {
      setHistoryBusy(true);
      const prior = { height: node.scrollHeight, top: node.scrollTop };
      void fetchMessageHistory(props.room, { before: historyCursor, limit: HISTORY_PAGE_SIZE }, { token: props.token() })
        .then((page) => {
          if (page.messages.length === 0) setHasOlder(false);
          mergeHistoryPage(page.messages);
          requestAnimationFrame(() => {
            node.scrollTop = prior.top + node.scrollHeight - prior.height;
          });
        })
        .catch(() => undefined)
        .finally(() => setHistoryBusy(false));
    }
  };

  return (
    <div className="nx-transcript-wrap">
      <div ref={scrollerRef} className="nx-transcript" data-testid="timeline" onScroll={onScroll} tabIndex={0}>
        <div className="nx-column">
          {!connected && ordered.length === 0 && <TranscriptSkeleton />}
          {connected && visible.length === 0 && (
            <p className="nx-empty" data-testid="timeline-empty">No messages yet — say something.</p>
          )}
          {visible.map((message, index) => {
            const previous = visible[index - 1];
            const grouped = previous !== undefined
              && previous.author === message.author
              && previous.kind !== 'system' && message.kind !== 'system'
              && Date.parse(message.ts) - Date.parse(previous.ts) < GROUP_WINDOW_MS;
            return (
              <TurnBlock
                key={message.id}
                message={message}
                author={members[message.author]}
                mine={message.author === selfId}
                grouped={grouped}
                room={props.room}
                token={props.token}
                connection={props.connection}
                deliveries={inbox}
                members={members}
              />
            );
          })}
          {workingAgents.length > 0 && (
            <div className="nx-working-row" data-testid="live-activity">
              <Chip name={workingAgents[0]!.handle} accent={memberAccent(workingAgents[0]!)} size={24} />
              <span className="nx-working-pill"><TypingDots label={`@${workingAgents[0]!.handle} is working`} /></span>
            </div>
          )}
        </div>
      </div>
      {showJump && (
        <button
          className="nx-jump"
          onClick={() => {
            const node = scrollerRef.current;
            if (node) node.scrollTop = node.scrollHeight;
            pinnedRef.current = true;
            setShowJump(false);
          }}
        >
          <ArrowDown size={14} aria-hidden="true" /> new messages
        </button>
      )}
    </div>
  );
}

// ── One turn: header (unless grouped) + body content ─────────────────────

function TurnBlock(props: {
  message: Message;
  author: Member | undefined;
  mine: boolean;
  grouped: boolean;
  room: string;
  token: () => string;
  connection: Connection;
  deliveries: Record<string, Delivery>;
  members: Record<string, Member>;
}) {
  const { message, author } = props;
  const [copied, setCopied] = useState(false);

  if (message.kind === 'system') {
    return (
      <p id={String(message.id)} data-testid={`msg-${message.id}`} className="nx-system">
        {message.body}
      </p>
    );
  }

  const handle = author?.handle ?? '…';

  // Acknowledgements collapse to one quiet line — the ack IS the content.
  if (message.ack === true) {
    return (
      <p id={String(message.id)} data-testid={`ack-${handle}`} className="nx-system nx-ack">
        <Check size={13} aria-hidden="true" /> @{handle} acknowledged
      </p>
    );
  }

  const copy = (): void => {
    void navigator.clipboard?.writeText(message.body).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  const quote = (): void => {
    const line = message.body.split('\n', 1)[0] ?? '';
    window.dispatchEvent(new CustomEvent('nx-quote', { detail: `@${handle} > ${line}` }));
  };

  return (
    <article
      id={String(message.id)}
      data-testid={message.kind === 'run' ? `run-${message.id}` : `msg-${message.id}`}
      className={`nx-turn ${props.grouped ? 'is-grouped' : ''} ${props.mine ? 'is-mine' : ''}`}
    >
      {!props.grouped && (
        <Chip name={handle} accent={author ? memberAccent(author) : 'indigo'} size={34} />
      )}
      <div className="nx-turn-main">
        {!props.grouped && (
          <div className="nx-turn-meta">
            <strong className="nx-turn-author">@{handle}</strong>
            {message.origin !== undefined && (
              <span className="nx-turn-origin" title={`via ${message.origin.platform}`}>
                {message.origin.sender_name} · {message.origin.platform}
              </span>
            )}
            <time className="nx-turn-time" dateTime={message.ts}>{clockTime(message.ts)}</time>
            {author?.kind === 'human' && (
              <SeenTicks message={message} deliveries={props.deliveries} members={props.members} />
            )}
            <span className="nx-turn-spacer" />
            <a className="nx-permalink" href={`#${message.id}`}>#{message.id}</a>
            <span className="nx-turn-actions">
              <button className="nx-iconbtn is-quiet" aria-label="Quote message" data-testid={`msg-${message.id}-quote`} onClick={quote}>
                <Quote size={14} aria-hidden="true" />
              </button>
              <button className="nx-iconbtn is-quiet" aria-label="Copy message" data-testid={`msg-${message.id}-copy`} onClick={copy}>
                {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
              </button>
            </span>
          </div>
        )}
        {message.kind === 'run'
          ? <RunContent message={message} room={props.room} token={props.token} />
          : message.kind === 'ask' || message.kind === 'approval'
            ? <AskCardView message={message} connection={props.connection} />
            : <MessageProse body={message.body} />}
      </div>
    </article>
  );
}

/** Delivery ticks per Richard #302: a message to agents is "seen" once its
 *  deliveries are consumed — queued or held ones have not reached anyone yet. */
function SeenTicks(props: {
  message: Message;
  deliveries: Record<string, Delivery>;
  members: Record<string, Member>;
}) {
  const relevant = Object.values(props.deliveries).filter(
    (d) => d.message_id === props.message.id && props.members[d.recipient]?.kind === 'agent',
  );
  if (relevant.length === 0) return null;
  // delivering means the turn already carries the payload — the agent has it.
  const seen = relevant.every((d) => d.state === 'delivering' || d.state === 'consumed');
  return (
    <span
      className={`nx-seen ${seen ? 'is-seen' : ''}`}
      title={seen ? 'Delivered to its agents' : 'Waiting in the queue'}
      data-testid={`msg-${props.message.id}-seen`}
      data-seen={seen}
    >
      {seen ? <CheckCheck size={13} aria-hidden="true" /> : <Clock3 size={12} aria-hidden="true" />}
    </span>
  );
}

function MessageProse(props: { body: string }) {
  const segments = useMemo(() => props.body.split(/(`[^`]+`)/g), [props.body]);
  return (
    <div className="nx-prose">
      {segments.map((segment, i) =>
        segment.startsWith('`') && segment.endsWith('`') && segment.length > 2
          ? <code key={i} className="nx-code">{segment.slice(1, -1)}</code>
          : <span key={i}>{segment}</span>,
      )}
    </div>
  );
}

// ── Run rendering (transcript model per Richard #298): run prose flows as
// ordinary turn content; each maximal consecutive stretch of tool rows collapses
// BY DEFAULT behind one aggregate summary line that expands to the bordered
// cards. A single-tool stretch shows its card directly. ─────────────────────

type RunSegment =
  | { kind: 'prose'; row: RunRow }
  | { kind: 'tools'; rows: RunRow[] };

function segmentRows(rows: RunRow[]): RunSegment[] {
  const segments: RunSegment[] = [];
  for (const row of rows) {
    const last = segments.at(-1);
    if (row.kind === 'tool') {
      if (last?.kind === 'tools') last.rows.push(row);
      else segments.push({ kind: 'tools', rows: [row] });
    } else {
      segments.push({ kind: 'prose', row });
    }
  }
  return segments;
}

function RunContent(props: { message: Message; room: string; token: () => string }) {
  const live = useRoomStore((s) => s.runEvents[props.message.id]);
  const [journal, setJournal] = useState<RunEventBuffer>();
  const running = props.message.run?.status === 'running';

  // The journal covers whatever the live buffer missed (late joins, trimmed
  // buffers) — for running runs too, so a fresh viewer sees the evidence so far.
  useEffect(() => {
    let current = true;
    void fetchRunEvents(props.room, props.message.id, { token: props.token() })
      .then((events) => {
        if (current) setJournal({ events, dropped_count: 0 });
      })
      .catch(() => undefined);
    return () => { current = false; };
  }, [props.message.id, props.message.run?.status, props.room, props.token]);

  const rows = useMemo(() => {
    const merged = mergeRunEvents(journal?.events, live ?? { events: [], dropped_count: 0 });
    return presentRunEvents(merged);
  }, [journal, live]);
  const segments = useMemo(() => segmentRows(rows), [rows]);

  // The prose already streams through text rows; only a run that produced no
  // prose at all (e.g. a failure) falls back to the settled final text.
  const hasProse = segments.some((s) => s.kind === 'prose');
  const finalText = props.message.run?.final_text ?? props.message.body;

  return (
    <div className="nx-run" data-run-status={props.message.run?.status ?? 'running'}>
      {segments.map((segment, index) =>
        segment.kind === 'prose'
          ? <div key={segment.row.eventIndex} className="nx-prose">{segment.row.text}</div>
          : <ToolBatch key={`tools-${segment.rows[0]?.eventIndex ?? index}`} rows={segment.rows} />,
      )}
      {running && rows.length === 0 && <TypingDots label="run starting" />}
      {running && <ElapsedSince ts={props.message.ts} />}
      {!running && !hasProse && finalText.length > 0 && <MessageProse body={finalText} />}
    </div>
  );
}

/** Ticking elapsed line under a live run. */
function ElapsedSince(props: { ts: string }) {
  const [, force] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(props.ts)) / 1000));
  return (
    <p className="nx-run-elapsed" data-testid="run-elapsed">
      running · {formatRunDuration(seconds * 1000)}
    </p>
  );
}

/** One aggregate line per tool batch — "Ran 4 tools · wrote 3 files +34 −76 ›" —
 *  expanding to the bordered cards. Counts update live while the batch runs. */
function ToolBatch(props: { rows: RunRow[] }) {
  const [expanded, setExpanded] = useState(false);
  const isMobile = useIsMobile();
  // On the phone every batch is a quiet disclosure line — no bare cards
  // (2a re-composition); desktop shows a lone tool's card directly.
  if (props.rows.length === 1 && !isMobile) return <ToolCard row={props.rows[0]!} />;

  const active = props.rows.some((row) => row.status === 'running');
  const diffs = props.rows.filter((row) => row.diff?.unified !== undefined);
  const stat = diffs.reduce(
    (sum, row) => {
      const { added, removed } = diffStat(row.diff!.unified);
      return { added: sum.added + added, removed: sum.removed + removed };
    },
    { added: 0, removed: 0 },
  );
  const plural = props.rows.length === 1 ? 'tool' : 'tools';
  const summary = [
    active ? `Running · ${props.rows.length} ${plural} so far` : `Ran ${props.rows.length} ${plural}`,
    diffs.length > 0
      ? `wrote ${diffs.length} file${diffs.length === 1 ? '' : 's'} +${stat.added} −${stat.removed}`
      : undefined,
  ].filter(Boolean).join(' · ');

  return (
    <div className="nx-batch" data-testid="tool-batch">
      <button
        className={`nx-batch-line ${active ? 'is-active' : ''}`}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <ChevronRight size={14} aria-hidden="true" className={expanded ? 'is-open' : ''} />
        {summary}
      </button>
      {expanded && (
        <div className="nx-batch-cards">
          {props.rows.map((row) => <ToolCard key={row.eventIndex} row={row} />)}
        </div>
      )}
    </div>
  );
}

function ToolCard(props: { row: RunRow }) {
  const [inspecting, setInspecting] = useState(false);
  const compact = compactRunRow(props.row);
  const status = props.row.status === 'running'
    ? 'Running…'
    : props.row.status === 'error'
      ? 'Failed'
      : `Done${props.row.duration_ms !== undefined ? ` · ${formatRunDuration(props.row.duration_ms)}` : ''}`;
  return (
    <>
      <button
        type="button"
        className={`nx-tool ${props.row.status === 'error' ? 'is-error' : ''}`}
        data-row-kind="tool"
        aria-label={`Inspect ${props.row.title}`}
        onClick={() => setInspecting(true)}
      >
        <span className="nx-tool-head">
          <TerminalSquare size={15} aria-hidden="true" />
          <span className="nx-tool-name">{props.row.title}</span>
          <span className="nx-tool-spacer" />
          <span className={`nx-tool-status is-${props.row.status}`}>{status}</span>
        </span>
        <span className={`nx-tool-body ${compact.mono ? 'is-mono' : ''}`}>{compact.label}</span>
      </button>
      {inspecting && (
        // The card re-renders as live events land, so an open inspector follows
        // the running row's latest output.
        <Modal label={`Tool: ${props.row.title}`} onClose={() => setInspecting(false)} wide testid="run-inspector">
          <div className="nx-inspect-head">
            <h2 className="nx-dialog-title">{props.row.title}</h2>
            <span className={`nx-tool-status is-${props.row.status}`}>{status}</span>
          </div>
          {props.row.detail !== undefined && <p className="nx-inspect-detail">{props.row.detail}</p>}
          {props.row.event.type === 'run.item' && props.row.event.item_type === 'tool_call' && (
            <pre className="nx-inspect-block">{JSON.stringify(props.row.event.payload, null, 2)}</pre>
          )}
          {props.row.output_text !== undefined && props.row.output_text !== '' && (
            <pre className="nx-inspect-block" data-testid="inspector-output">{props.row.output_text}</pre>
          )}
          {props.row.diff?.unified !== undefined && <DiffViewer diff={props.row.diff} />}
        </Modal>
      )}
    </>
  );
}

// ── Interaction cards: options answer durably; the resolved card leaves the
// timeline once the server marks its delivery resolved. ─────────────────────

function AskCardView(props: { message: Message; connection: Connection }) {
  const ask = props.message.ask;
  const [picked, setPicked] = useState<string[]>([]);
  const [sent, setSent] = useState(false);
  if (!ask) return <MessageProse body={props.message.body} />;

  const answer = (value: unknown): void => {
    props.connection.act({
      act: 'answer_interaction',
      interaction_id: ask.interaction_id,
      answer: value,
    });
    setSent(true);
  };

  return (
    <div className="nx-ask" data-testid={`ask-${props.message.id}`}>
      <div className="nx-ask-head">
        <span className="nx-ask-kind">{ask.kind === 'approval' ? 'Approval needed' : 'Question'}</span>
        {ask.tool !== undefined && <code className="nx-code">{ask.tool}</code>}
      </div>
      <p className="nx-ask-prompt">{ask.prompt}</p>
      {ask.detail !== undefined && <pre className="nx-ask-detail">{ask.detail}</pre>}
      {ask.options !== undefined && ask.options.length > 0 && (
        <div className="nx-ask-options">
          {ask.options.map((option) => (
            <button
              key={option.label}
              className={`nx-btn ${ask.multi === true && picked.includes(option.label) ? 'is-primary' : ''}`}
              disabled={sent}
              title={option.description}
              data-testid={`ask-${props.message.id}-${option.label}`}
              onClick={() => {
                if (ask.multi === true) {
                  setPicked((prior) =>
                    prior.includes(option.label)
                      ? prior.filter((label) => label !== option.label)
                      : [...prior, option.label],
                  );
                } else {
                  answer(option.label);
                }
              }}
            >
              {option.label}
            </button>
          ))}
          {ask.multi === true && (
            <button
              className="nx-btn is-primary"
              disabled={sent || picked.length === 0}
              onClick={() => answer(picked)}
            >
              Send answer
            </button>
          )}
        </div>
      )}
      {sent && <p className="nx-ask-sent">Answered — waiting for the agent…</p>}
    </div>
  );
}

function TranscriptSkeleton() {
  return (
    <div className="nx-skeleton" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="nx-skeleton-row">
          <span className="nx-skeleton-chip" />
          <span className="nx-skeleton-lines">
            <span style={{ width: '38%' }} />
            <span style={{ width: '86%' }} />
            <span style={{ width: '64%' }} />
          </span>
        </div>
      ))}
    </div>
  );
}
