import type { Attachment, Delivery, Member, Message, WireEvent } from '@codor/protocol';
import { ArrowDown, Bot, Check, CheckCheck, ChevronRight, Clock3, Copy, Globe, LoaderCircle, Paperclip, Pencil, Pin, PinOff, Quote, RotateCcw, Search, Square, TerminalSquare, Trash2, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { Connection } from '@legacy/ws.js';

import { fetchMessageHistory } from '@legacy/api.js';
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
} from '@legacy/state.js';

import { useIsMobile } from '../app/session.js';
import { Button, Chip, Modal, TypingDots } from '../primitives/primitives.js';
import { clockTime, memberAccent } from '../primitives/identity.js';
import { OPEN_DIFF_EVENT } from './ContextPanel.js';
import { CompactionMarker } from './CompactionMarker.js';
import { jumpToMessage } from './panels.js';
import { renderMarkdown } from './markdown.js';
import { getRunJournal, requestRunJournal, useRunJournalVersion } from './run-journals.js';
import { attachmentUrl, formatAttachmentSize, isImageAttachment } from './attachments.js';
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

  // Pins older than the loaded page are invisible from loaded messages alone, so
  // hydrate the whole pinned set at room load and union it with loaded truth.
  const [hydratedPins, setHydratedPins] = useState<Message[]>([]);
  useEffect(() => {
    let live = true;
    setHydratedPins([]);
    void fetch(`/api/rooms/${encodeURIComponent(props.room)}/messages?pinned=1`, {
      headers: { authorization: `Bearer ${props.token()}` },
    })
      .then((res) => (res.ok ? res.json() as Promise<{ messages: Message[] }> : { messages: [] }))
      .then((body) => { if (live) setHydratedPins(body.messages); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [props.room, props.token]);

  // Strip = hydrated pins overlaid with loaded truth (a live unpin/delete on a
  // loaded message drops it; a live pin adds it), oldest first.
  const pinned = useMemo(() => {
    const byId = new Map<number, Message>();
    for (const message of hydratedPins) byId.set(message.id, message);
    for (const message of ordered) {
      if (message.pinned === true) byId.set(message.id, message);
      else byId.delete(message.id);
    }
    return [...byId.values()].sort((left, right) => left.id - right.id);
  }, [hydratedPins, ordered]);
  // Only human owners/admins get the pin affordance — the server refuses anyone
  // else, so showing the control to them would only earn an error.
  const selfRole = selfId !== undefined ? members[selfId]?.role : undefined;
  const canPin = selfRole === 'owner' || selfRole === 'admin';
  // Interrupt is gated at admin too — the same owner/admin viewers may stop a run.
  const canStop = selfRole === 'owner' || selfRole === 'admin';
  // Delete is an owner/admin act as well; the server refuses anyone else.
  const canDelete = selfRole === 'owner' || selfRole === 'admin';
  // Retry (failed/interrupted runs) is owner/admin too.
  const canRetry = selfRole === 'owner' || selfRole === 'admin';
  const selfHandle = selfId !== undefined ? members[selfId]?.handle : undefined;

  // Finalized runs are flattened into per-segment entries so a human message
  // posted mid-run lands between the run's blocks; running runs stay whole.
  const finalizedRunIds = useMemo(
    () => visible
      .filter((m) => m.kind === 'run' && m.run !== undefined && m.run.status !== 'running')
      .map((m) => m.id),
    [visible],
  );
  const runSegments = useFinalizedRunSegments(props.room, props.token, finalizedRunIds);
  const entries = useMemo(() => buildTimelineEntries(visible, runSegments), [visible, runSegments]);

  // Working agents drive the typing indicator. Derived with useMemo — a selector
  // returning a fresh array every snapshot would loop useSyncExternalStore forever.
  // EVERY working agent shows in the typing bar (richard #431). Running ones
  // first, then queued, each order stable by handle so the row never reshuffles.
  const workingAgents = useMemo(
    () => Object.values(members)
      .filter((m) => m.kind === 'agent' && (m.state === 'running' || m.state === 'queued'))
      .sort((left, right) => {
        if ((left.state === 'running') !== (right.state === 'running')) {
          return left.state === 'running' ? -1 : 1;
        }
        return left.handle.localeCompare(right.handle);
      }),
    [members],
  );

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
                <button
                  type="button"
                  className="nx-pinned-item"
                  data-testid={`pinned-${message.id}`}
                  title={message.body}
                  // A pin beyond the loaded window has no #id target yet; page
                  // history back to it rather than jumping to a dead fragment.
                  onClick={() => void jumpToMessage(props.room, message.id, props.token)}
                >
                  <span className="nx-pinned-who">@{members[message.author]?.handle ?? '…'}</span>
                  <span className="nx-pinned-snippet">{pinnedSnippet(message)}</span>
                </button>
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
          {renderTimeline(entries, {
            members, selfId, selfHandle, inbox,
            room: props.room, token: props.token, connection: props.connection,
            canPin, canDelete, canRetry,
          })}
          {workingAgents.length > 0 && (
            // Sticky floor of the scroller: visible at any scroll position, one
            // chip per working agent, present only while someone is working.
            <div className="nx-typing-bar" data-testid="live-activity">
              {workingAgents.map((agent) => (
                <span key={agent.id} className="nx-typing-agent" data-testid={`typing-${agent.handle}`}>
                  <Chip name={agent.handle} accent={memberAccent(agent)} size={24} />
                  <TypingDots label={`@${agent.handle} is working`} />
                  {canStop && agent.state === 'running' && (
                    <button
                      type="button"
                      className="nx-typing-stop"
                      aria-label={`Stop @${agent.handle}`}
                      data-testid={`typing-stop-${agent.handle}`}
                      title="Stop this run (the agent stays alive)"
                      onClick={() => props.connection.act({ act: 'interrupt', member_id: agent.id })}
                    >
                      <Square size={12} aria-hidden="true" />
                    </button>
                  )}
                </span>
              ))}
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
  canRetry: boolean;
  viewerId: string | undefined;
  viewerHandle: string | undefined;
  room: string;
  token: () => string;
  connection: Connection;
  deliveries: Record<string, Delivery>;
  members: Record<string, Member>;
}) {
  const { message, author } = props;
  const isMobile = useIsMobile();
  // A message that @-mentions the viewer is highlighted so it stands out.
  const mentionsMe = props.viewerId !== undefined
    && message.mentions.some((mention) => mention.member_id === props.viewerId);

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
      data-mentions-me={mentionsMe ? 'true' : undefined}
      className={`nx-turn ${props.grouped ? 'is-grouped' : ''} ${props.mine ? 'is-mine' : ''} ${message.pinned === true ? 'is-pinned' : ''} ${mentionsMe ? 'is-mentioned' : ''}`}
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
              {props.canRetry && message.kind === 'run'
                && (message.run?.status === 'failed' || message.run?.status === 'interrupted') && (
                <button
                  className="nx-iconbtn is-quiet"
                  aria-label="Retry run"
                  data-testid={`run-${message.id}-retry`}
                  onClick={() => props.connection.act({ act: 'retry_run', message_id: message.id })}
                >
                  <RotateCcw size={14} aria-hidden="true" />
                </button>
              )}
            </span>
          </div>
        )}
        {message.kind === 'run'
          ? <RunContent message={message} room={props.room} token={props.token} />
          : message.kind === 'ask' || message.kind === 'approval'
            ? <AskCardView message={message} connection={props.connection} />
            : <MessageProse body={message.body} highlightHandle={mentionsMe ? props.viewerHandle : undefined} />}
        {message.attachments !== undefined && message.attachments.length > 0 && (
          <MessageAttachments room={props.room} token={props.token} attachments={message.attachments} />
        )}
      </div>
    </article>
  );
}

/** A message's uploaded files: images inline (click opens the served file),
 *  everything else a download chip. Tombstones early-return above, so a deleted
 *  message never reaches here — its attachments vanish for free. */
function MessageAttachments(props: { room: string; token: () => string; attachments: Attachment[] }) {
  return (
    <div className="nx-attachments" data-testid="message-attachments">
      {props.attachments.map((attachment) => {
        const url = attachmentUrl(props.room, attachment.id, props.token());
        return isImageAttachment(attachment.mime) ? (
          <a
            key={attachment.id}
            className="nx-attach-image"
            href={url}
            target="_blank"
            rel="noreferrer"
            data-testid={`attachment-${attachment.id}`}
          >
            <img src={url} alt={attachment.name} loading="lazy" />
          </a>
        ) : (
          <a
            key={attachment.id}
            className="nx-attach-download"
            href={url}
            download={attachment.name}
            data-testid={`attachment-${attachment.id}`}
          >
            <Paperclip size={14} aria-hidden="true" />
            <span className="nx-attach-name">{attachment.name}</span>
            <span className="nx-attach-size">{formatAttachmentSize(attachment.size)}</span>
          </a>
        );
      })}
    </div>
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

/** Bold a mention of the viewer's own handle in already-sanitized markdown HTML.
 *  Only @handle preceded by a non-word/non-path char is wrapped (skips emails). */
function boldSelfMention(html: string, handle: string): string {
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.replace(
    new RegExp(`(^|[^\\w@/])@(${escaped})\\b`, 'gi'),
    '$1<strong class="nx-mention-self">@$2</strong>',
  );
}

function MessageProse(props: { body: string; highlightHandle?: string }) {
  // renderMarkdown sanitizes: only markdown-produced structure reaches the DOM.
  // The self-mention <strong> we add afterwards is our own safe markup.
  const html = useMemo(() => {
    const rendered = renderMarkdown(props.body);
    return props.highlightHandle === undefined
      ? rendered
      : boldSelfMention(rendered, props.highlightHandle);
  }, [props.body, props.highlightHandle]);
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

/** A segment's ordering time — the first row's journal stamp; undefined for a
 *  compaction marker or rows from pre-upgrade ts-less journals. */
function segmentTs(segment: RunSegment): string | undefined {
  if (segment.kind === 'prose') return segment.row.ts;
  if (segment.kind === 'tools') return segment.rows.find((row) => row.ts !== undefined)?.ts;
  return undefined;
}

/** Journals for a set of FINALIZED runs (complete, no live buffer needed),
 *  presented into segments so the transcript can interleave their blocks. Reads
 *  go through the shared room-scoped cache, so asking for the same journal from
 *  here and from a RunContent costs exactly one request. */
function useFinalizedRunSegments(
  room: string,
  token: () => string,
  runIds: readonly number[],
): Map<number, RunSegment[]> {
  const version = useRunJournalVersion();
  const key = runIds.join(',');
  useEffect(() => {
    for (const id of runIds) requestRunJournal(room, token, id, { terminal: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, token, key]);

  // Segments are memoized per run: a journal commit recomputes only that run,
  // not every run in the room (which would be quadratic in a large transcript).
  const segmentsRef = useRef(new Map<number, { events: WireEvent[]; segments: RunSegment[] }>());
  const segmentsRoomRef = useRef(room);
  return useMemo(() => {
    if (segmentsRoomRef.current !== room) {
      segmentsRef.current.clear(); // ids are room-local; never reuse across rooms
      segmentsRoomRef.current = room;
    }
    const map = new Map<number, RunSegment[]>();
    for (const id of runIds) {
      const events = getRunJournal(room, id);
      if (events === undefined) continue;
      const cached = segmentsRef.current.get(id);
      if (cached?.events === events) {
        map.set(id, cached.segments);
        continue;
      }
      const segments = segmentTimeline(
        presentRunTimeline(events.map((event, index) => ({ index, event }))),
      );
      segmentsRef.current.set(id, { events, segments });
      map.set(id, segments);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, key, version]);
}

function RunContent(props: { message: Message; room: string; token: () => string }) {
  const live = useRoomStore((s) => s.runEvents[props.message.id]);
  const running = props.message.run?.status === 'running';
  const version = useRunJournalVersion();

  // The journal covers whatever the live buffer missed (late joins, trimmed
  // buffers) — for running runs too, so a fresh viewer sees the evidence so far.
  // A live run jumps the queue; when it settles, the effect re-runs once with
  // terminal=true so the cache picks up the completed journal exactly once.
  useEffect(() => {
    requestRunJournal(props.room, props.token, props.message.id, {
      terminal: !running,
      priority: running,
    });
  }, [props.room, props.token, props.message.id, running]);

  const journalEvents = getRunJournal(props.room, props.message.id);
  const timeline = useMemo(() => {
    const merged = mergeRunEvents(journalEvents, live ?? { events: [], dropped_count: 0 });
    return presentRunTimeline(merged);
    // The cached journal is a stable reference, so identity keying is correct
    // here; `live` is a fresh object per streamed frame, so it stays keyed on
    // counts to avoid re-presenting an unchanged list on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journalEvents, live?.events.length, live?.dropped_count, version]);
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
      {/* A terminal run that produced no reply (e.g. interrupted by a restart)
          reads as a quiet status marker, never a blank bubble. */}
      {!running && !hasProse && finalText.length === 0
        && (props.message.run?.status === 'interrupted' || props.message.run?.status === 'failed') && (
        <p className={`nx-run-status is-${props.message.run.status}`} data-testid={`run-${props.message.id}-status`}>
          run {props.message.run.status}
        </p>
      )}
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

// ── Timeline flattening: a finalized run's segments become top-level entries
// ordered by their journal time, so a human message posted mid-run lands between
// the run's blocks. A non-interrupted run's segments stay contiguous and render
// as one stretch, identical to before. Running/empty runs stay whole turns. ──

type TimelineEntry =
  | { kind: 'turn'; message: Message; ts: number; order: number }
  | { kind: 'runseg'; message: Message; segment: RunSegment; isLast: boolean; ts: number; order: number };

function buildTimelineEntries(visible: Message[], runSegments: Map<number, RunSegment[]>): TimelineEntry[] {
  const list: TimelineEntry[] = [];
  visible.forEach((message, index) => {
    const base = index * 1000;
    const finalized = message.kind === 'run' && message.run !== undefined && message.run.status !== 'running';
    const segments = finalized ? runSegments.get(message.id) : undefined;
    // Only runs that produced prose can be split around a mid-run message.
    // Tools-only / empty / compaction-only runs stay whole turns so RunContent
    // keeps rendering their final-text fallback and status marker unchanged.
    if (finalized && segments !== undefined && segments.some((s) => s.kind === 'prose')) {
      let lastTs = Date.parse(message.run!.ended_ts ?? message.ts);
      segments.forEach((segment, segIndex) => {
        const stamp = segmentTs(segment);
        // A ts-less segment inherits its predecessor's time — pre-upgrade runs
        // (all ts-less) collapse to ended_ts and stay together, as before.
        const ts = stamp !== undefined ? Date.parse(stamp) : lastTs;
        lastTs = ts;
        list.push({ kind: 'runseg', message, segment, isLast: segIndex === segments.length - 1, ts, order: base + segIndex });
      });
    } else {
      list.push({ kind: 'turn', message, ts: transcriptTime(message), order: base });
    }
  });
  return list.sort((left, right) => (left.ts - right.ts) || (left.order - right.order));
}

interface TimelineCtx {
  members: Record<string, Member>;
  selfId: string | undefined;
  selfHandle: string | undefined;
  inbox: Record<string, Delivery>;
  room: string;
  token: () => string;
  connection: Connection;
  canPin: boolean;
  canDelete: boolean;
  canRetry: boolean;
}

function renderTimeline(entries: TimelineEntry[], ctx: TimelineCtx): ReactNode[] {
  const out: ReactNode[] = [];
  // A split run yields several stretches sharing one message id; only the first
  // carries the DOM id + permalink target so ids stay unique and #id resolves.
  const anchoredRunIds = new Set<number>();
  let prevAuthor: string | undefined;
  let prevTs = Number.NEGATIVE_INFINITY;
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index]!;
    if (entry.kind === 'runseg') {
      const runId = entry.message.id;
      const segments: RunSegment[] = [];
      let isLastStretch = false;
      while (index < entries.length) {
        const next = entries[index];
        if (next?.kind !== 'runseg' || next.message.id !== runId) break;
        segments.push(next.segment);
        isLastStretch = next.isLast;
        prevTs = next.ts;
        index += 1;
      }
      const anchored = !anchoredRunIds.has(runId);
      anchoredRunIds.add(runId);
      out.push(
        <RunStretch
          key={`run-${runId}-${entry.order}`}
          message={entry.message}
          author={ctx.members[entry.message.author]}
          segments={segments}
          isLastStretch={isLastStretch}
          anchored={anchored}
          mine={entry.message.author === ctx.selfId}
          canPin={ctx.canPin}
          canRetry={ctx.canRetry}
          connection={ctx.connection}
        />,
      );
      prevAuthor = entry.message.author;
    } else {
      const message = entry.message;
      // A failed/interrupted run that produced no prose renders as a quiet status
      // marker. Grouped under a neighbouring turn by the same author it loses its
      // header and #id entirely and reads as deleted (codex #516: that is how run
      // #501 "disappeared"). Such a run always stands alone, keeping its number,
      // permalink, status and error evidence. Ordering is untouched.
      const standaloneRun = message.kind === 'run'
        && (message.run?.status === 'failed' || message.run?.status === 'interrupted');
      const grouped = !standaloneRun
        && prevAuthor !== undefined
        && prevAuthor === message.author
        && message.kind !== 'system'
        && Number.isFinite(entry.ts) && Number.isFinite(prevTs)
        && entry.ts - prevTs < GROUP_WINDOW_MS;
      out.push(
        <TurnBlock
          key={`turn-${message.id}`}
          message={message}
          author={ctx.members[message.author]}
          mine={message.author === ctx.selfId}
          grouped={grouped}
          room={ctx.room}
          token={ctx.token}
          connection={ctx.connection}
          deliveries={ctx.inbox}
          members={ctx.members}
          canPin={ctx.canPin}
          canDelete={ctx.canDelete}
          canRetry={ctx.canRetry}
          viewerId={ctx.selfId}
          viewerHandle={ctx.selfHandle}
        />,
      );
      prevAuthor = message.kind === 'system' ? undefined : message.author;
      prevTs = entry.ts;
      index += 1;
    }
  }
  return out;
}

/** One contiguous stretch of a finalized run's segments, with its header and
 *  Retry affordance — the interleave splits a run into one stretch per stretch
 *  of blocks uninterrupted by another author. */
function RunStretch(props: {
  message: Message;
  author: Member | undefined;
  segments: RunSegment[];
  isLastStretch: boolean;
  anchored: boolean;
  mine: boolean;
  canPin: boolean;
  canRetry: boolean;
  connection: Connection;
}) {
  const { message, author } = props;
  const isMobile = useIsMobile();
  const handle = author?.handle ?? '…';
  const status = message.run?.status;
  const runError = message.run?.error;
  const quote = (): void => {
    const line = message.body.split('\n', 1)[0] ?? '';
    window.dispatchEvent(new CustomEvent('nx-quote', { detail: `@${handle} > ${line}` }));
  };
  return (
    <article
      id={props.anchored ? String(message.id) : undefined}
      data-testid={`run-${message.id}`}
      className={`nx-turn ${props.mine ? 'is-mine' : ''}`}
    >
      {!isMobile && <Chip name={handle} accent={author ? memberAccent(author) : 'indigo'} size={34} />}
      <div className="nx-turn-main">
        <div className="nx-turn-meta">
          {isMobile && <Chip name={handle} accent={author ? memberAccent(author) : 'indigo'} size={24} />}
          <strong className="nx-turn-author">@{handle}</strong>
          <time className="nx-turn-time" dateTime={message.ts}>{clockTime(message.ts)}</time>
          {props.anchored && message.pinned === true && (
            <Pin size={12} className="nx-pin-glyph" aria-label="Pinned" data-testid={`msg-${message.id}-pinned`} />
          )}
          <span className="nx-turn-spacer" />
          <a className="nx-permalink" href={`#${message.id}`}>#{message.id}</a>
          {/* Affordances live on the anchored (first) stretch only, so a split
              run never duplicates its controls or their testids. */}
          {props.anchored && (
            <span className="nx-turn-actions">
              <button className="nx-iconbtn is-quiet" aria-label="Quote message" data-testid={`msg-${message.id}-quote`} onClick={quote}>
                <Quote size={14} aria-hidden="true" />
              </button>
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
              {props.canRetry && (status === 'failed' || status === 'interrupted') && (
                <button
                  className="nx-iconbtn is-quiet"
                  aria-label="Retry run"
                  data-testid={`run-${message.id}-retry`}
                  onClick={() => props.connection.act({ act: 'retry_run', message_id: message.id })}
                >
                  <RotateCcw size={14} aria-hidden="true" />
                </button>
              )}
            </span>
          )}
        </div>
        <div className="nx-run" data-run-status={status ?? 'running'}>
          {props.segments.map((segment, index) =>
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
                      messageId={message.id}
                      blockId={segment.row.eventIndex}
                      text={segment.row.text ?? ''}
                    />
                  )
                : <ToolBatch key={`tools-${segment.rows[0]?.eventIndex ?? index}`} rows={segment.rows} />,
          )}
          {props.isLastStretch && runError !== undefined && runError !== '' && (
            <p className="nx-field-note is-error" role="alert" data-testid="run-error">{runError}</p>
          )}
        </div>
      </div>
    </article>
  );
}

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
  // A file-edit chip routes to the Diff tab focused on that file's CURRENT diff
  // (not this historical one); every other tool opens the input/output inspector.
  const diffPath = props.row.diff?.path;
  const openDiff = (): void => {
    window.dispatchEvent(new CustomEvent(OPEN_DIFF_EVENT, { detail: { path: diffPath } }));
  };
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
        aria-label={diffPath !== undefined ? `Open diff for ${diffPath}` : `Inspect ${props.row.title}`}
        onClick={diffPath !== undefined ? openDiff : () => setInspecting(true)}
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
