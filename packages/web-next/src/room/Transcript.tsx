import type { Delivery, Member, Message } from '@codor/protocol';
import { ArrowDown, Bot, Check, CheckCheck, ChevronRight, Clock3, Copy, Globe, LoaderCircle, Pencil, Pin, PinOff, Quote, Search, Square, TerminalSquare, Trash2, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { Connection } from '@legacy/ws.js';

import { fetchMessageHistory, fetchRunEvents } from '@legacy/api.js';
import {
  compactRunRow,
  diffStat,
  formatRunDuration,
  mergeRunEvents,
  type RunRow,
} from '@legacy/run-presenter.js';
import {
  HISTORY_PAGE_SIZE,
  pendingInteractions,
  useRoomStore,
  type RunEventBuffer,
} from '@legacy/state.js';

import { useIsMobile } from '../app/session.js';
import { Button, Chip, Modal, TypingDots } from '../primitives/primitives.js';
import { clockTime, memberAccent } from '../primitives/identity.js';
import { DiffViewer } from './ContextPanel.js';
import { CompactionMarker } from './CompactionMarker.js';
import { renderMarkdown } from './markdown.js';
import { presentRunTimeline, type CompactionRunTimelineItem } from './run-timeline.js';

/** Consecutive same-author messages within this window collapse their header. */
const GROUP_WINDOW_MS = 2 * 60_000;
const RELEASE_PIN_DISTANCE_PX = 120;
const REGLUE_DISTANCE_PX = 80;

function transcriptTime(message: Message): number {
  if (message.kind === 'run' && message.run?.status === 'running') {
    return Number.POSITIVE_INFINITY;
  }
  if (message.kind === 'run' && message.run?.status !== 'running') {
    return Date.parse(message.run?.ended_ts ?? message.ts);
  }
  return Date.parse(message.ts);
}

function transcriptMessages(messages: Record<number, Message>): Message[] {
  return Object.values(messages).sort((left, right) => {
    const leftRunning = left.kind === 'run' && left.run?.status === 'running';
    const rightRunning = right.kind === 'run' && right.run?.status === 'running';
    if (leftRunning !== rightRunning) return leftRunning ? 1 : -1;
    const byTime = leftRunning && rightRunning
      ? Date.parse(left.ts) - Date.parse(right.ts)
      : transcriptTime(left) - transcriptTime(right);
    return byTime === 0 ? left.id - right.id : byTime;
  });
}

export function Transcript(props: { room: string; token: () => string; connection: Connection }) {
  const messages = useRoomStore((s) => s.messages);
  const members = useRoomStore((s) => s.members);
  const selfId = useRoomStore((s) => s.selfMemberId);
  const historyCursor = useRoomStore((s) => s.historyCursor);
  const mergeHistoryPage = useRoomStore((s) => s.mergeHistoryPage);
  const connected = useRoomStore((s) => s.connected);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const upwardScrollRef = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const maxSeenIdRef = useRef<number>();
  const [historyBusy, setHistoryBusy] = useState(false);
  const [hasOlder, setHasOlder] = useState(true);

  const inbox = useRoomStore((s) => s.inbox);
  const ordered = useMemo(() => transcriptMessages(messages), [messages]);
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

  // Pinned messages surface in a strip above the timeline, oldest first.
  const pinned = useMemo(() => ordered.filter((m) => m.pinned === true), [ordered]);
  // Only human owners/admins get the pin affordance — the server refuses anyone
  // else, so showing the control to them would only earn an error.
  const selfRole = selfId !== undefined ? members[selfId]?.role : undefined;
  const canPin = selfRole === 'owner' || selfRole === 'admin';
  // Interrupt is gated at admin too — the same owner/admin viewers may stop a run.
  const canStop = selfRole === 'owner' || selfRole === 'admin';
  // Delete is an owner/admin act as well; the server refuses anyone else.
  const canDelete = selfRole === 'owner' || selfRole === 'admin';

  // Working agents drive the typing indicator. Derived with useMemo — a selector
  // returning a fresh array every snapshot would loop useSyncExternalStore forever.
  const workingAgents = useMemo(
    () => Object.values(members).filter((m) => m.kind === 'agent' && (m.state === 'running' || m.state === 'queued')),
    [members],
  );
  // ONE indicator for the whole room: the most recently started still-running
  // run names the agent; queued-only work falls back to any working member.
  const typingAgent = useMemo(() => {
    if (workingAgents.length === 0) return undefined;
    const latestRunning = ordered.filter((m) => m.kind === 'run' && m.run?.status === 'running').at(-1);
    return workingAgents.find((m) => m.id === latestRunning?.author) ?? workingAgents[0];
  }, [workingAgents, ordered]);

  // Arrivals while unpinned drive the jump counter. Only ids above the
  // highwater mark are new — history pages prepend OLD ids and never count.
  useEffect(() => {
    const maxId = visible.reduce((max, m) => Math.max(max, m.id), 0);
    if (pinnedRef.current || maxSeenIdRef.current === undefined) {
      maxSeenIdRef.current = maxId;
      return;
    }
    const prior = maxSeenIdRef.current;
    if (maxId > prior) {
      setNewCount((count) => count + visible.filter((m) => m.id > prior).length);
      maxSeenIdRef.current = maxId;
    }
  }, [visible]);

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

  // Run prose and evidence can grow without creating a new message. While the
  // reader is pinned, follow that column growth too; an upward scroll past the
  // release threshold is the only thing that suspends this observer.
  useEffect(() => {
    const node = scrollerRef.current;
    const column = columnRef.current;
    if (!node || !column) return;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (!pinnedRef.current) return;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!pinnedRef.current) return;
        node.scrollTop = node.scrollHeight;
        setShowJump(false);
      });
    });
    observer.observe(column);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, []);

  const onScroll = (): void => {
    const node = scrollerRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    const upward = lastScrollTopRef.current - node.scrollTop;
    lastScrollTopRef.current = node.scrollTop;
    if (upward > 0) upwardScrollRef.current += upward;
    else if (upward < 0) upwardScrollRef.current = 0;
    if (distance < REGLUE_DISTANCE_PX) {
      pinnedRef.current = true;
      setNewCount(0); // re-glued: everything below is seen again
    } else if (pinnedRef.current && upwardScrollRef.current >= RELEASE_PIN_DISTANCE_PX) {
      pinnedRef.current = false;
    }
    setShowJump(!pinnedRef.current);
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
      {pinned.length > 0 && (
        <div className="nx-pinned-strip" data-testid="pinned-strip">
          <Pin size={13} aria-hidden="true" className="nx-pinned-mark" />
          <ul className="nx-pinned-list">
            {pinned.map((message) => (
              <li key={message.id}>
                <a
                  className="nx-pinned-item"
                  href={`#${message.id}`}
                  data-testid={`pinned-${message.id}`}
                  title={message.body}
                >
                  <span className="nx-pinned-who">@{members[message.author]?.handle ?? '…'}</span>
                  <span className="nx-pinned-snippet">{pinnedSnippet(message)}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div ref={scrollerRef} className="nx-transcript" data-testid="timeline" onScroll={onScroll} tabIndex={0}>
        <div ref={columnRef} className="nx-column">
          {!connected && ordered.length === 0 && <TranscriptSkeleton />}
          {connected && visible.length === 0 && (
            <p className="nx-empty" data-testid="timeline-empty">No messages yet — say something.</p>
          )}
          {visible.map((message, index) => {
            const previous = visible[index - 1];
            const grouped = previous !== undefined
              && previous.author === message.author
              && previous.kind !== 'system' && message.kind !== 'system'
              && Number.isFinite(transcriptTime(previous))
              && Number.isFinite(transcriptTime(message))
              && transcriptTime(message) - transcriptTime(previous) < GROUP_WINDOW_MS;
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
                canPin={canPin}
                canDelete={canDelete}
              />
            );
          })}
          {typingAgent !== undefined && (
            // Sticky floor of the scroller: visible at any scroll position,
            // present only while someone is actually working.
            <div className="nx-typing-bar" data-testid="live-activity">
              <Chip name={typingAgent.handle} accent={memberAccent(typingAgent)} size={24} />
              <TypingDots label={`@${typingAgent.handle} is working`} />
              {canStop && (
                <button
                  type="button"
                  className="nx-typing-stop"
                  aria-label={`Stop @${typingAgent.handle}`}
                  data-testid="typing-stop"
                  title="Stop this run (the agent stays alive)"
                  onClick={() => props.connection.act({ act: 'interrupt', member_id: typingAgent.id })}
                >
                  <Square size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {showJump && (
        // Merely scrolled up: a plain arrow back to the latest. Only arrivals
        // while unpinned turn it into a counter.
        <button
          className={`nx-jump ${newCount === 0 ? 'is-arrow' : ''}`}
          aria-label={newCount === 0 ? 'Back to latest' : undefined}
          onClick={() => {
            const node = scrollerRef.current;
            if (node) node.scrollTop = node.scrollHeight;
            pinnedRef.current = true;
            setNewCount(0);
            setShowJump(false);
          }}
        >
          <ArrowDown size={14} aria-hidden="true" />
          {newCount > 0 && `${newCount} new message${newCount === 1 ? '' : 's'}`}
        </button>
      )}
    </div>
  );
}

/** One-line preview for the pinned strip: the first non-empty body line. */
function pinnedSnippet(message: Message): string {
  const line = message.body.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line || '(no text)';
}

// ── One turn: header (unless grouped) + body content ─────────────────────

function TurnBlock(props: {
  message: Message;
  author: Member | undefined;
  mine: boolean;
  grouped: boolean;
  canPin: boolean;
  canDelete: boolean;
  room: string;
  token: () => string;
  connection: Connection;
  deliveries: Record<string, Delivery>;
  members: Record<string, Member>;
}) {
  const { message, author } = props;
  const isMobile = useIsMobile();

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

  // A purged message keeps its place, author, and time but shows only a
  // tombstone — no body, no actions (its pin was cleared server-side too).
  if (message.deleted === true) {
    return (
      <article
        id={String(message.id)}
        data-testid={`msg-${message.id}`}
        className={`nx-turn is-deleted ${props.grouped ? 'is-grouped' : ''} ${props.mine ? 'is-mine' : ''}`}
      >
        {!props.grouped && !isMobile && (
          <Chip name={handle} accent={author ? memberAccent(author) : 'indigo'} size={34} />
        )}
        <div className="nx-turn-main">
          {!props.grouped && (
            <div className="nx-turn-meta">
              {isMobile && (
                <Chip name={handle} accent={author ? memberAccent(author) : 'indigo'} size={24} />
              )}
              <strong className="nx-turn-author">@{handle}</strong>
              <time className="nx-turn-time" dateTime={message.ts}>{clockTime(message.ts)}</time>
              <span className="nx-turn-spacer" />
              <a className="nx-permalink" href={`#${message.id}`}>#{message.id}</a>
            </div>
          )}
          <p className="nx-deleted" data-testid={`msg-${message.id}-deleted`}>[deleted]</p>
        </div>
      </article>
    );
  }

  const quote = (): void => {
    const line = message.body.split('\n', 1)[0] ?? '';
    window.dispatchEvent(new CustomEvent('nx-quote', { detail: `@${handle} > ${line}` }));
  };

  return (
    <article
      id={String(message.id)}
      data-testid={message.kind === 'run' ? `run-${message.id}` : `msg-${message.id}`}
      className={`nx-turn ${props.grouped ? 'is-grouped' : ''} ${props.mine ? 'is-mine' : ''} ${message.pinned === true ? 'is-pinned' : ''}`}
    >
      {!props.grouped && !isMobile && (
        <Chip name={handle} accent={author ? memberAccent(author) : 'indigo'} size={34} />
      )}
      <div className="nx-turn-main">
        {!props.grouped && (
          <div className="nx-turn-meta">
            {/* The phone trades the chip column for a small chip in the header. */}
            {isMobile && (
              <Chip name={handle} accent={author ? memberAccent(author) : 'indigo'} size={24} />
            )}
            <strong className="nx-turn-author">@{handle}</strong>
            {message.origin !== undefined && (
              <span className="nx-turn-origin" title={`via ${message.origin.platform}`}>
                {message.origin.sender_name} · {message.origin.platform}
              </span>
            )}
            <time className="nx-turn-time" dateTime={message.ts}>{clockTime(message.ts)}</time>
            {message.pinned === true && (
              <Pin size={12} className="nx-pin-glyph" aria-label="Pinned" data-testid={`msg-${message.id}-pinned`} />
            )}
            {author?.kind === 'human' && (
              <SeenTicks message={message} deliveries={props.deliveries} members={props.members} />
            )}
            <span className="nx-turn-spacer" />
            <a className="nx-permalink" href={`#${message.id}`}>#{message.id}</a>
            <span className="nx-turn-actions">
              <button className="nx-iconbtn is-quiet" aria-label="Quote message" data-testid={`msg-${message.id}-quote`} onClick={quote}>
                <Quote size={14} aria-hidden="true" />
              </button>
              {message.kind !== 'run' && (
                <CopyButton text={message.body} label="Copy message" testId={`msg-${message.id}-copy`} />
              )}
              {props.canPin && (
                <button
                  className="nx-iconbtn is-quiet"
                  aria-label={message.pinned === true ? 'Unpin message' : 'Pin message'}
                  aria-pressed={message.pinned === true}
                  data-testid={`msg-${message.id}-pin`}
                  onClick={() => props.connection.act({
                    act: 'pin_message',
                    message_id: message.id,
                    pinned: message.pinned !== true,
                  })}
                >
                  {message.pinned === true
                    ? <PinOff size={14} aria-hidden="true" />
                    : <Pin size={14} aria-hidden="true" />}
                </button>
              )}
              {props.canDelete && message.kind === 'chat' && (
                <DeleteButton messageId={message.id} connection={props.connection} />
              )}
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

function CopyButton(props: { text: string; label: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="nx-iconbtn is-quiet"
      aria-label={props.label}
      data-testid={props.testId}
      onClick={() => {
        void navigator.clipboard?.writeText(props.text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  );
}

/** Delete is destructive and irreversible, so it confirms before purging. */
function DeleteButton(props: { messageId: number; connection: Connection }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <button
        className="nx-iconbtn is-quiet"
        aria-label="Delete message"
        data-testid={`msg-${props.messageId}-delete`}
        onClick={() => setConfirming(true)}
      >
        <Trash2 size={14} aria-hidden="true" />
      </button>
      {confirming && (
        <Modal label="Delete message?" onClose={() => setConfirming(false)} alert testid="delete-confirm">
          <h2 className="nx-dialog-title">Delete this message?</h2>
          <p className="nx-dialog-body">
            The body is purged for everyone and cannot be restored; a “[deleted]” marker stays in its place.
          </p>
          <div className="nx-dialog-actions">
            <Button variant="quiet" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button
              variant="danger"
              data-testid="delete-confirm-go"
              onClick={() => {
                props.connection.act({ act: 'delete_message', message_id: props.messageId });
                setConfirming(false);
              }}
            >
              Delete
            </Button>
          </div>
        </Modal>
      )}
    </>
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
  // renderMarkdown sanitizes: only markdown-produced structure reaches the DOM.
  const html = useMemo(() => renderMarkdown(props.body), [props.body]);
  return <div className="nx-prose" dangerouslySetInnerHTML={{ __html: html }} />;
}

// ── Run rendering (transcript model per Richard #298): run prose flows as
// ordinary turn content; each maximal consecutive stretch of tool rows collapses
// BY DEFAULT behind one aggregate summary line that expands to the bordered
// cards. A single-tool stretch shows its card directly. ─────────────────────

type RunSegment =
  | { kind: 'prose'; row: RunRow }
  | { kind: 'tools'; rows: RunRow[] }
  | { kind: 'compaction'; item: CompactionRunTimelineItem };

// harn:assume web-compaction-markers-upgrade-in-place ref=web-compaction-timeline-wiring
function segmentTimeline(timeline: ReturnType<typeof presentRunTimeline>): RunSegment[] {
  const segments: RunSegment[] = [];
  for (const item of timeline) {
    if (item.kind === 'compaction') {
      segments.push({ kind: 'compaction', item });
      continue;
    }
    const row = item.row;
    const last = segments.at(-1);
    // Reasoning summaries are batch metadata, not visible prose. Ignoring them
    // here keeps tools on either side in one maximal batch, including empty
    // summaries emitted by adapters.
    if (
      row.icon === 'reasoning'
      || (row.event.type === 'run.item' && row.event.item_type === 'reasoning_summary')
    ) continue;
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

  const timeline = useMemo(() => {
    const merged = mergeRunEvents(journal?.events, live ?? { events: [], dropped_count: 0 });
    return presentRunTimeline(merged);
    // Keyed on counts, not object identity: run events are append-only, and
    // `live` is a fresh object per streamed frame — identity keying re-ran the
    // presenter over the full unchanged list on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journal?.events.length, live?.events.length, live?.dropped_count]);
  const segments = useMemo(() => segmentTimeline(timeline), [timeline]);

  // The prose already streams through text rows; only a run that produced no
  // prose at all (e.g. a failure) falls back to the settled final text.
  const hasProse = segments.some((s) => s.kind === 'prose');
  const finalText = props.message.run?.final_text ?? props.message.body;
  // harn:assume run-failure-evidence-is-surfaced ref=web-next-run-error-evidence
  // Failed/interrupted runs have empty bodies by design — their reason lives
  // on run.error and must render, or failures are silently blank.
  const runError = props.message.run?.error;
  // harn:end run-failure-evidence-is-surfaced

  return (
    <div className="nx-run" data-run-status={props.message.run?.status ?? 'running'}>
      {segments.map((segment, index) =>
        segment.kind === 'compaction'
          ? (
              <CompactionMarker
                key={segment.item.id}
                status={segment.item.status}
                trigger={segment.item.trigger}
                preTokens={segment.item.preTokens}
              />
            )
          : segment.kind === 'prose'
          ? (
              <RunTextBlock
                key={segment.row.eventIndex}
                messageId={props.message.id}
                blockId={segment.row.eventIndex}
                text={segment.row.text ?? ''}
              />
            )
          : <ToolBatch key={`tools-${segment.rows[0]?.eventIndex ?? index}`} rows={segment.rows} />,
      )}
      {running && <ElapsedSince ts={props.message.ts} />}
      {!running && !hasProse && finalText.length > 0 && (
        <RunTextBlock messageId={props.message.id} blockId="final" text={finalText} />
      )}
      {/* harn:assume run-failure-evidence-is-surfaced ref=web-next-run-error-evidence */}
      {!running && runError !== undefined && runError !== '' && (
        <p className="nx-field-note is-error" role="alert" data-testid="run-error">
          {runError}
        </p>
      )}
      {/* harn:end run-failure-evidence-is-surfaced */}
    </div>
  );
}
// harn:end web-compaction-markers-upgrade-in-place

function RunTextBlock(props: { messageId: number; blockId: number | 'final'; text: string }) {
  return (
    <div className="nx-run-block" data-testid={`run-${props.messageId}-block-${props.blockId}`}>
      <MessageProse body={props.text} />
      <span className="nx-run-block-actions">
        <CopyButton
          text={props.text}
          label="Copy run block"
          testId={`run-${props.messageId}-block-${props.blockId}-copy`}
        />
      </span>
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
 *  expanding to the one-line rows. Counts update live while the batch runs. */
function ToolBatch(props: { rows: RunRow[] }) {
  const [expanded, setExpanded] = useState(false);
  // A lone tool is its own line on every form factor — no "Ran 1 tool" wrapper.
  if (props.rows.length === 1) return <ToolRow row={props.rows[0]!} />;

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
          {props.rows.map((row) => <ToolRow key={row.eventIndex} row={row} />)}
        </div>
      )}
    </div>
  );
}

const ROW_ICONS: Record<RunRow['icon'], LucideIcon> = {
  terminal: TerminalSquare,
  edit: Pencil,
  search: Search,
  web: Globe,
  // No dedicated glyph in the batch-B set — task/other and commit fold into bot.
  commit: Bot,
  reasoning: Bot,
  text: Bot,
  tool: Bot,
  generic: Bot,
};

/** The presenter's diff label is "+A −B file"; split the tinted counts back out. */
const DIFF_LABEL = /^\+(\d+)\s−(\d+)\s(.*)$/;

/** One line per tool: icon · what it did (± tinted) · a right-aligned ✓/✕ or
 *  spinner. The whole row opens the inspector — no bordered card anywhere. */
function ToolRow(props: { row: RunRow }) {
  const [inspecting, setInspecting] = useState(false);
  const compact = compactRunRow(props.row);
  const Icon = ROW_ICONS[compact.icon];
  const diff = DIFF_LABEL.exec(compact.label);
  // Modal keeps its textual status; the row itself only wears the mark.
  const status = props.row.status === 'running'
    ? 'Running…'
    : props.row.status === 'error'
      ? 'Failed'
      : `Done${props.row.duration_ms !== undefined ? ` · ${formatRunDuration(props.row.duration_ms)}` : ''}`;
  return (
    <>
      <button
        type="button"
        className={`nx-tool is-${props.row.status}`}
        data-row-kind="tool"
        aria-label={`Inspect ${props.row.title}`}
        onClick={() => setInspecting(true)}
      >
        <Icon className="nx-tool-icon" size={14} aria-hidden="true" />
        <span className={`nx-tool-label ${compact.mono ? 'is-mono' : ''}`}>
          {diff !== null ? (
            <>
              <span className="nx-stat-add">+{diff[1]}</span>{' '}
              <span className="nx-stat-del">−{diff[2]}</span>{' '}
              {diff[3]}
            </>
          ) : compact.label}
        </span>
        <span className={`nx-tool-mark is-${props.row.status}`}>
          {props.row.status === 'running'
            ? <LoaderCircle className="nx-spin" size={13} aria-label="running" />
            : props.row.status === 'error'
              ? <X size={13} aria-label="failed" />
              : <Check size={13} aria-label="done" />}
        </span>
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
