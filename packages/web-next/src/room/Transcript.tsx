import type {
  Attachment,
  Delivery,
  Member,
  Message,
  RunItemDiff,
  TranscriptHistoryIndexedEvent,
  TranscriptHistoryUnit,
  WireEvent,
} from '@codor/protocol';
import { ArrowDown, AudioLines, Bot, Check, CheckCheck, ChevronRight, CircleAlert, Clock3, Copy, Globe, LoaderCircle, Paperclip, Pencil, Pin, PinOff, Quote, RotateCcw, Search, Square, TerminalSquare, Trash2, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { Connection } from '@runtime/ws.js';

import { relayFetch } from '@runtime/relay-transport.js';
import {
  compactRunRow,
  diffStat,
  formatRunDuration,
  mergeRunEvents,
  type RunRow,
} from '@runtime/run-presenter.js';

import { useIsMobile } from '../app/session.js';
import { roomSlice, useClientStore, type TranscriptHistoryState } from '../app/store.js';
import { Button, Chip, Modal, TypingDots } from '../primitives/primitives.js';
import { clockTime, memberAccent } from '../primitives/identity.js';
import { CompactionMarker } from './CompactionMarker.js';
import { RunDiffDialog } from './RunDiffDialog.js';
import { JUMP_ANCHOR_EVENT, jumpToMessage } from './panels.js';
import { renderMarkdown } from './markdown.js';
import {
  activateRunJournalRoom,
  getRunJournal,
  requestRunJournal,
  useRunJournalVersion,
} from './run-journals.js';
import {
  formatAttachmentSize,
  isImageAttachment,
  useAttachmentDownload,
  useAttachmentObjectUrl,
  useNearViewport,
} from './attachments.js';
import { MiniWaveform } from './MiniWaveform.js';
import { formatElapsed } from './voice.js';
import { presentRunTimeline, type CompactionRunTimelineItem } from './run-timeline.js';
import { continuationFloor, transcriptMessages, transcriptTime } from './transcript-order.js';
import {
  ensureTranscriptHistory,
  indexedEventsForUnit,
  loadOlderTranscriptHistory,
  refreshTranscriptHistoryHead,
  revealTranscriptTarget,
  transcriptUnitKey,
} from './transcript-history.js';

/** Consecutive same-author messages within this window collapse their header. */
const GROUP_WINDOW_MS = 2 * 60_000;
const RELEASE_PIN_DISTANCE_PX = 120;
const REGLUE_DISTANCE_PX = 80;
const READ_DWELL_MS = 300;
const READ_MIN_VISIBLE_PX = 48;
const SEGMENT_CACHE_ROOMS = 3;

interface HistoryRestore {
  room: string;
  anchorUnit: string;
  anchorOffset: number;
  fallbackHeight: number;
  fallbackTop: number;
  merged: boolean;
}

/** Highest durable activity sequence the reader can meaningfully see. A tall
 * run needs 48 visible pixels; a short row needs half its own height. This keeps
 * a one-pixel fly-by from clearing unread while still allowing long turns to be
 * read without fitting their entire body in the viewport. */
function highestVisibleReadSeq(node: HTMLElement): number | undefined {
  const viewport = node.getBoundingClientRect();
  let highest: number | undefined;
  for (const row of node.querySelectorAll<HTMLElement>('[data-read-seq]')) {
    const rect = row.getBoundingClientRect();
    if (rect.height <= 0) continue;
    const visible = Math.min(rect.bottom, viewport.bottom) - Math.max(rect.top, viewport.top);
    const required = Math.min(READ_MIN_VISIBLE_PX, rect.height / 2);
    if (visible < required) continue;
    const seq = Number(row.dataset.readSeq);
    if (!Number.isSafeInteger(seq)) continue;
    highest = highest === undefined ? seq : Math.max(highest, seq);
  }
  return highest;
}

// harn:assume continuation-writer-follows-journaled-output-ownership ref=continuation-web-rendering
export function messageReadSeq(message: Message, mine: boolean): number | undefined {
  if (mine || message.deleted === true || message.ack === true) return undefined;
  if (message.kind === 'chat') return message.seq;
  if (message.kind === 'run' && message.run_parent_id !== undefined) return message.seq;
  if (message.kind === 'run' && message.run !== undefined && message.run.status !== 'running') {
    return message.seq;
  }
  return undefined;
}

// harn:assume cross-worktree-output-stays-in-origin ref=qualified-author-rendering
/** Foreign execution authors keep their persisted scope in the origin row. */
export function qualifiedAuthorLabel(message: Message, author?: Member): string {
  const handle = author?.handle ?? message.author_target?.handle ?? '…';
  return message.author_target === undefined
    ? `@${handle}`
    : `~${message.author_target.alias}:@${handle}`;
}
// harn:end cross-worktree-output-stays-in-origin

export function continuationVisibleMessages(
  ordered: readonly Message[],
  messages: Readonly<Record<number, Message>>,
  pendingInteractions?: readonly Message[],
): Message[] {
  const pending = new Set(pendingInteractions?.map((message) => message.id) ?? []);
  return ordered.filter((message) => {
    if (
      (message.kind === 'ask' || message.kind === 'approval')
      && pendingInteractions !== undefined
      && !pending.has(message.id)
    ) return false;
    const root = message.run_parent_id === undefined ? message : messages[message.run_parent_id];
    if (root?.ack !== true || root.run?.output_mode !== 'messages') return true;
    return message.id === (root.run.result_message_id ?? root.id);
  });
}
// harn:end continuation-writer-follows-journaled-output-ownership

// harn:assume actionable-interactions-remain-support-owned-outside-history ref=interaction-cold-suppression
export function coldMessageSuppressed(
  message: Message,
  coldMessageIds: Readonly<Record<number, true>> | undefined,
  actionableInteractionIds: ReadonlySet<number>,
): boolean {
  if (
    (message.kind === 'ask' || message.kind === 'approval')
    && actionableInteractionIds.has(message.id)
  ) return false;
  return coldMessageIds?.[message.id] === true;
}
// harn:end actionable-interactions-remain-support-owned-outside-history

export function Transcript(props: { room: string; token: () => string; connection: Connection }) {
  const slice = useClientStore((state) => roomSlice(state, props.room));
  const messages = slice.messages;
  const members = slice.members;
  const selfId = slice.selfMemberId;
  const hydrated = slice.hydrated;
  const support = slice.support;
  const history = slice.transcriptHistory;
  const connected = useClientStore((state) => state.connected);

  useEffect(() => activateRunJournalRoom(props.room), [props.room]);
  useEffect(() => {
    // A persisted last-good page is intentionally readable before connection,
    // but it is not current truth. Wait for this source store's current server
    // evidence and token, then let the shared head controller deduplicate the
    // authenticated revalidation with resume/settlement signals.
    if (!hydrated || !connected) return;
    void ensureTranscriptHistory(useClientStore, props.room, props.token);
  }, [connected, hydrated, props.room, props.token]);


  const scrollerRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const upwardScrollRef = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const maxSeenIdRef = useRef<number>();
  const [historyBusy, setHistoryBusy] = useState(false);
  const historyRequestRef = useRef(false);
  const historyRestoreRef = useRef<HistoryRestore>();
  const historySettleTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const inbox = slice.inbox;
  const heldMessageIds = useMemo(() => [...new Set(Object.values(inbox)
    .filter((delivery) => delivery.state === 'held')
    .map((delivery) => delivery.message_id))], [inbox]);
  const heldTargetRequestsRef = useRef(new Set<number>());
  useEffect(() => {
    if (!connected || !history.initialized) return;
    for (const id of heldMessageIds) {
      if (messages[id] !== undefined || history.messages[id] !== undefined
        || heldTargetRequestsRef.current.has(id)) continue;
      heldTargetRequestsRef.current.add(id);
      void revealTranscriptTarget(useClientStore, props.room, id, props.token)
        .finally(() => heldTargetRequestsRef.current.delete(id));
    }
  }, [connected, heldMessageIds, history.initialized, history.messages, messages, props.room, props.token]);
  const ordered = useMemo(() => transcriptMessages(messages), [messages]);
  // Support state owns actionability; transcript messages stay the exact
  // contiguous history window and never absorb old correctness outliers.
  const visible = useMemo(() => continuationVisibleMessages(
    ordered,
    messages,
    support?.interactions,
  ), [messages, ordered, support]);
  const detachedInteractions = useMemo(
    () => support?.interactions.filter((message) => messages[message.id] === undefined) ?? [],
    [messages, support],
  );
  const actionableInteractionIds = useMemo(
    () => new Set(support?.interactions.map((message) => message.id) ?? []),
    [support],
  );

  const historicalTargets = useMemo(() => {
    const ids = new Set<number>();
    for (const unit of history.units) {
      ids.add(unit.kind === 'message' ? unit.message_id : unit.output_message_id);
    }
    return ids;
  }, [history.units]);
  const historicalRoots = useMemo(() => new Set(history.units.flatMap(
    (unit) => unit.kind === 'message' ? [] : [unit.root_message_id],
  )), [history.units]);
  // harn:assume live-runs-settle-beside-paged-history-once ref=live-history-settlement-cache
  const observedLiveRootsRef = useRef(new Set<number>());
  for (const message of visible) {
    const rootId = message.run_parent_id ?? message.id;
    const root = messages[rootId] ?? support?.active_runs.find((candidate) => candidate.id === rootId);
    if (root?.kind === 'run' && root.run?.status === 'running') {
      observedLiveRootsRef.current.add(rootId);
    }
  }
  for (const rootId of [...observedLiveRootsRef.current]) {
    const storedRoot = messages[rootId]
      ?? support?.active_runs.find((candidate) => candidate.id === rootId);
    const pageRoot = history.messages[rootId];
    // The combined page can observe settlement even when the replacement
    // socket has no missed message frame to replay. Prefer that immutable
    // terminal truth over a stale locally-running root.
    const root = pageRoot?.run?.status !== undefined && pageRoot.run.status !== 'running'
      ? pageRoot
      : storedRoot;
    if (root?.run?.status === undefined || root.run.status === 'running') continue;
    const journalComplete = getRunJournal(props.room, rootId)?.some((event) => event.type === 'run.completed') === true;
    const liveComplete = slice.runEvents[rootId]?.events.some((event) => event.type === 'run.completed') === true;
    const headHasFamily = history.units.some(
      (unit) => unit.kind !== 'message' && unit.root_message_id === rootId,
    );
    // A complete observed family remains frozen in place. If the tab missed its
    // terminal evidence, the combined head becomes authoritative once it lands.
    if (!journalComplete && !liveComplete && headHasFamily) observedLiveRootsRef.current.delete(rootId);
  }
  const renderedHistory = useMemo(() => ({
    ...history,
    units: history.units.filter((unit) => unit.kind === 'message'
      || !observedLiveRootsRef.current.has(unit.root_message_id)),
  }), [history]);
  const liveVisible = useMemo(() => visible.filter((message) => {
    if (history.legacyFallback) return !coldMessageSuppressed(message, history.coldMessageIds, actionableInteractionIds);
    if (message.kind !== 'run') {
      return !historicalTargets.has(message.id)
        && !coldMessageSuppressed(message, history.coldMessageIds, actionableInteractionIds);
    }
    const rootId = message.run_parent_id ?? message.id;
    if (historicalRoots.has(rootId) && !observedLiveRootsRef.current.has(rootId)) return false;
    const root = messages[rootId] ?? support?.active_runs.find((candidate) => candidate.id === rootId);
    return root?.run?.status === 'running' || observedLiveRootsRef.current.has(rootId);
  }), [actionableInteractionIds, historicalRoots, historicalTargets, history.coldMessageIds, history.legacyFallback, messages, support, visible]);
  const preservedSettledRoots = useMemo(() => new Set(
    [...observedLiveRootsRef.current].filter((rootId) => {
      const root = messages[rootId] ?? support?.active_runs.find((candidate) => candidate.id === rootId);
      return root?.run?.status !== undefined && root.run.status !== 'running';
    }),
  ), [messages, support]);
  const terminalRefreshRef = useRef(new Set<number>());
  useEffect(() => {
    for (const rootId of observedLiveRootsRef.current) {
      const root = messages[rootId] ?? support?.active_runs.find((candidate) => candidate.id === rootId);
      if (root?.run?.status === undefined || root.run.status === 'running') continue;
      const journalComplete = getRunJournal(props.room, rootId)?.some((event) => event.type === 'run.completed') === true;
      const liveComplete = slice.runEvents[rootId]?.events.some((event) => event.type === 'run.completed') === true;
      if (journalComplete || liveComplete || terminalRefreshRef.current.has(rootId)) continue;
      terminalRefreshRef.current.add(rootId);
      void refreshTranscriptHistoryHead(useClientStore, props.room, props.token).then((ok) => {
        if (!ok) terminalRefreshRef.current.delete(rootId);
      });
    }
  }, [messages, props.room, props.token, slice.runEvents, support]);
  // harn:end live-runs-settle-beside-paged-history-once

  // Pins older than the loaded page are invisible from loaded messages alone, so
  // hydrate the whole pinned set at room load and union it with loaded truth.
  const [hydratedPins, setHydratedPins] = useState<Message[]>([]);
  useEffect(() => {
    let live = true;
    setHydratedPins([]);
    void relayFetch(`/api/rooms/${encodeURIComponent(props.room)}/messages?pinned=1`, {
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

  // Combined pages own every cold finalized unit. The legacy renderer is kept
  // only for current live material, so it can never trigger a cold finalized
  // journal read.
  const journalVersion = useRunJournalVersion();
  const liveToolOnlyOutputs = useMemo(() => {
    const selected = new Set<number>();
    for (const message of liveVisible) {
      if (message.kind !== 'run') continue;
      const rootId = message.run_parent_id ?? message.id;
      const root = messages[rootId]
        ?? support?.active_runs.find((candidate) => candidate.id === rootId);
      if (root?.run?.status === 'failed' || root?.run?.status === 'interrupted') continue;
      const outputMessages = message.run_parent_id !== undefined
        || root?.run?.output_mode === 'messages';
      const merged = mergeRunEvents(
        getRunJournal(props.room, rootId),
        slice.runEvents[rootId] ?? { events: [], dropped_count: 0 },
      );
      const targeted = outputMessages
        ? merged.filter(({ event }) => {
            const target = event.type === 'run.item'
              || event.type === 'timeline'
              || event.type === 'run.completed'
              ? event.output_message_id
              : undefined;
            return (target ?? rootId) === message.id;
          })
        : merged;
      const segments = segmentTimeline(presentRunTimeline(targeted));
      if (segments.length === 0 || !segments.every((segment) => segment.kind === 'tools')) continue;
      if (root?.run?.status !== 'running') {
        const finalText = outputMessages
          ? message.body
          : message.run?.final_text ?? message.body;
        if (finalText.length > 0 || (root?.run?.error ?? '').length > 0) continue;
      }
      selected.add(message.id);
    }
    return selected;
  }, [journalVersion, liveVisible, messages, props.room, slice.runEvents, support]);
  const entries = useMemo(() => buildTimelineEntries(liveVisible, new Map()), [liveVisible]);
  const initialBarrier = useRef({ room: props.room, ready: false });
  if (initialBarrier.current.room !== props.room) {
    initialBarrier.current = { room: props.room, ready: false };
  }
  if (hydrated && history.initialized) initialBarrier.current.ready = true;
  const transcriptReady = hydrated
    && (history.initialized || history.legacyFallback)
    && initialBarrier.current.ready;
  const historyBlocked = hydrated && !history.initialized && history.failed && !history.loadingHead;

  const cancelHistorySettle = useCallback((): void => {
    if (historySettleTimerRef.current !== undefined) clearTimeout(historySettleTimerRef.current);
    historySettleTimerRef.current = undefined;
  }, []);
  const restoreHistoryAnchor = useCallback((): void => {
    const pending = historyRestoreRef.current;
    const node = scrollerRef.current;
    if (pending === undefined || !pending.merged || pending.room !== props.room || node === null) return;
    const anchor = pending.anchorUnit.startsWith('unit:')
      ? [...node.querySelectorAll<HTMLElement>('[data-transcript-unit]')]
          .find((candidate) => candidate.dataset.transcriptUnit === pending.anchorUnit.slice(5)) ?? null
      : document.getElementById(pending.anchorUnit.slice(3));
    if (anchor !== null && node.contains(anchor)) {
      const offset = anchor.getBoundingClientRect().top - node.getBoundingClientRect().top;
      node.scrollTop += offset - pending.anchorOffset;
    } else {
      node.scrollTop = pending.fallbackTop + node.scrollHeight - pending.fallbackHeight;
    }
    lastScrollTopRef.current = node.scrollTop;
    upwardScrollRef.current = 0;
  }, [props.room]);
  const settleHistoryAfterQuiet = useCallback((): void => {
    cancelHistorySettle();
    historySettleTimerRef.current = setTimeout(() => {
      restoreHistoryAnchor();
      historyRestoreRef.current = undefined;
      historyRequestRef.current = false;
      historySettleTimerRef.current = undefined;
      setHistoryBusy(false);
    }, 120);
  }, [cancelHistorySettle, restoreHistoryAnchor]);

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

  // When each working agent's CURRENT lifecycle started. The support projection
  // carries active roots even when they sit outside the hydrated window, so the
  // pill's clock survives both interjections and a root scrolled out of reach.
  const runningSince = useMemo(
    () => resolveRunningSince(support?.active_runs ?? [], Object.values(messages)),
    [support, messages],
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

  const lastId = visible.at(-1)?.id;

  // Durable read edges are about observation, not delivery. A substantive row
  // must occupy meaningful viewport space for a short dwell while the page is
  // focused; being delivered, mounted offscreen, or flown past does not count.
  const lastMarkedSeqRef = useRef(0);
  const pendingReadSeqRef = useRef<number>();
  const readTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const cancelReadTimer = useCallback((): void => {
    if (readTimerRef.current !== undefined) clearTimeout(readTimerRef.current);
    readTimerRef.current = undefined;
    pendingReadSeqRef.current = undefined;
  }, []);
  const markVisibleRowsRead = useCallback((): void => {
    const node = scrollerRef.current;
    if (
      !transcriptReady
      || !connected
      || support === undefined
      || document.visibilityState !== 'visible'
      || !document.hasFocus()
      || node === null
    ) {
      cancelReadTimer();
      return;
    }
    const target = highestVisibleReadSeq(node);
    if (target === undefined || target <= lastMarkedSeqRef.current) {
      cancelReadTimer();
      return;
    }
    if (pendingReadSeqRef.current === target && readTimerRef.current !== undefined) return;
    cancelReadTimer();
    pendingReadSeqRef.current = target;
    readTimerRef.current = setTimeout(() => {
      readTimerRef.current = undefined;
      pendingReadSeqRef.current = undefined;
      const liveNode = scrollerRef.current;
      if (
        liveNode === null
        || document.visibilityState !== 'visible'
        || !document.hasFocus()
        || highestVisibleReadSeq(liveNode) !== target
        || target <= lastMarkedSeqRef.current
      ) return;
      lastMarkedSeqRef.current = target;
      props.connection.act({ act: 'mark_room_read', through_seq: target });
    }, READ_DWELL_MS);
  }, [cancelReadTimer, connected, props.connection, support, transcriptReady]);

  useEffect(() => {
    lastMarkedSeqRef.current = 0;
    cancelReadTimer();
    cancelHistorySettle();
    pinnedRef.current = true;
    historyRequestRef.current = false;
    historyRestoreRef.current = undefined;
    terminalRefreshRef.current.clear();
    setHistoryBusy(false);
    return () => {
      cancelHistorySettle();
      historyRequestRef.current = false;
      historyRestoreRef.current = undefined;
    };
  }, [cancelHistorySettle, cancelReadTimer, props.room]);

  useEffect(() => {
    if (!connected) {
      lastMarkedSeqRef.current = 0;
      cancelReadTimer();
    }
  }, [cancelReadTimer, connected]);

  useEffect(() => {
    const onVisible = (): void => markVisibleRowsRead();
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    const frame = requestAnimationFrame(markVisibleRowsRead);
    return () => {
      cancelAnimationFrame(frame);
      cancelReadTimer();
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [cancelReadTimer, markVisibleRowsRead]);

  useEffect(() => {
    const frame = requestAnimationFrame(markVisibleRowsRead);
    return () => cancelAnimationFrame(frame);
  }, [entries, journalVersion, markVisibleRowsRead]);

  // Run prose and evidence can grow without creating a new message. While the
  // reader is pinned, follow that column growth too; an upward scroll past the
  // release threshold is the only thing that suspends this observer.
  // harn:assume transcript-tail-follow-has-one-prepaint-owner ref=transcript-prepaint-geometry
  useLayoutEffect(() => {
    const node = scrollerRef.current;
    const column = columnRef.current;
    if (!node || !column) return;
    // A newly mounted tail row needs correction in this commit's layout phase;
    // ResizeObserver owns later column/viewport geometry changes in the same
    // hook, so no second effect or deferred frame can expose an old position.
    if (pinnedRef.current) {
      node.scrollTop = node.scrollHeight;
      lastScrollTopRef.current = node.scrollTop;
      setShowJump(false);
    } else if (!pinnedRef.current) {
      setShowJump(true);
    }
    const reconcileGeometry = (): void => {
      if (historyRestoreRef.current?.merged === true) {
        cancelHistorySettle();
        restoreHistoryAnchor();
        settleHistoryAfterQuiet();
        return;
      }
      if (!pinnedRef.current) return;
      node.scrollTop = node.scrollHeight;
      lastScrollTopRef.current = node.scrollTop;
      setShowJump(false);
      markVisibleRowsRead();
    };
    const observer = new ResizeObserver(reconcileGeometry);
    let disposed = false;
    const onComposerGeometry = (event: Event): void => {
      const delta = (event as CustomEvent<{ delta?: number }>).detail?.delta ?? 0;
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      // Growing the focused composer can emit a browser scroll event before
      // sibling flex geometry settles. Recover the pre-change pinned truth only
      // when the entire new gap is explained by this exact height delta; an
      // intentionally unpinned reader remains untouched.
      const shouldFollow = pinnedRef.current || (delta > 0 && distance <= delta + 2);
      if (!shouldFollow) return;
      pinnedRef.current = true;
      // Composer mutates its height from a child layout effect. Finish the
      // current React commit before reading the resulting sibling flex size,
      // while staying ahead of the next animation frame and paint.
      queueMicrotask(() => {
        if (disposed || scrollerRef.current !== node) return;
        reconcileGeometry();
      });
    };
    observer.observe(column);
    observer.observe(node);
    window.addEventListener('codor:composer-geometry', onComposerGeometry);
    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener('codor:composer-geometry', onComposerGeometry);
    };
  }, [
    cancelHistorySettle,
    entries,
    journalVersion,
    lastId,
    markVisibleRowsRead,
    restoreHistoryAnchor,
    settleHistoryAfterQuiet,
  ]);
  // harn:end transcript-tail-follow-has-one-prepaint-owner

  // A permalink jump means the reader is deliberately looking away from the tail.
  // Bounded hydration made this load-bearing: an old target now pages in, and the
  // growth that paging causes would otherwise snap the tail-follow straight back
  // over the message they just jumped to.
  useEffect(() => {
    const release = (): void => {
      pinnedRef.current = false;
      setShowJump(true);
    };
    window.addEventListener('hashchange', release);
    return () => window.removeEventListener('hashchange', release);
  }, []);

  useEffect(() => {
    const holdTarget = (event: Event): void => {
      const detail = (event as CustomEvent<{ room: string; id: number }>).detail;
      const node = scrollerRef.current;
      const target = document.getElementById(String(detail.id));
      if (detail.room !== props.room || node === null || target === null || !node.contains(target)) return;
      cancelHistorySettle();
      const viewport = node.getBoundingClientRect();
      const unit = target.closest<HTMLElement>('[data-transcript-unit]');
      historyRestoreRef.current = {
        room: props.room,
        anchorUnit: unit?.dataset.transcriptUnit === undefined
          ? `id:${target.id}`
          : `unit:${unit.dataset.transcriptUnit}`,
        anchorOffset: target.getBoundingClientRect().top - viewport.top,
        fallbackHeight: node.scrollHeight,
        fallbackTop: node.scrollTop,
        merged: true,
      };
      restoreHistoryAnchor();
      settleHistoryAfterQuiet();
    };
    window.addEventListener(JUMP_ANCHOR_EVENT, holdTarget);
    return () => window.removeEventListener(JUMP_ANCHOR_EVENT, holdTarget);
  }, [
    cancelHistorySettle,
    props.room,
    restoreHistoryAnchor,
    settleHistoryAfterQuiet,
  ]);

  // A prepended page is allowed to grow as its run journals settle. Keep the
  // same pre-existing row at the same viewport offset after every such commit,
  // and only release the request latch once those heights are final.
  useLayoutEffect(() => {
    const pending = historyRestoreRef.current;
    if (pending === undefined || !pending.merged || pending.room !== props.room) return;
    cancelHistorySettle();
    restoreHistoryAnchor();
    settleHistoryAfterQuiet();
  }, [
    cancelHistorySettle,
    history.units,
    journalVersion,
    messages,
    props.room,
    restoreHistoryAnchor,
    settleHistoryAfterQuiet,
  ]);

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
      requestAnimationFrame(markVisibleRowsRead);
    } else if (pinnedRef.current && upwardScrollRef.current >= RELEASE_PIN_DISTANCE_PX) {
      pinnedRef.current = false;
    }
    setShowJump(!pinnedRef.current);
    markVisibleRowsRead();
    if (
      node.scrollTop < 80
      && !pinnedRef.current
      && upwardScrollRef.current > 0
      && !historyRequestRef.current
      && history.hasMore
      && history.beforeCursor !== undefined
      && history.beforeCursor !== null
    ) {
      cancelHistorySettle();
      historyRequestRef.current = true;
      setHistoryBusy(true);
      pinnedRef.current = false;
      setShowJump(true);
      const viewport = node.getBoundingClientRect();
      const firstVisible = [...columnRef.current?.querySelectorAll<HTMLElement>('[data-transcript-unit]') ?? []]
        .find((row) => row.getBoundingClientRect().bottom > viewport.top);
      const pending: HistoryRestore = {
        room: props.room,
        anchorUnit: firstVisible?.dataset.transcriptUnit === undefined
          ? 'id:'
          : `unit:${firstVisible.dataset.transcriptUnit}`,
        anchorOffset: firstVisible === undefined
          ? 0
          : firstVisible.getBoundingClientRect().top - viewport.top,
        fallbackHeight: node.scrollHeight,
        fallbackTop: node.scrollTop,
        merged: false,
      };
      historyRestoreRef.current = pending;
      void loadOlderTranscriptHistory(useClientStore, props.room, props.token)
        .then((loaded) => {
          if (historyRestoreRef.current !== pending) return;
          if (!loaded) {
            cancelHistorySettle();
            historyRestoreRef.current = undefined;
            historyRequestRef.current = false;
            setHistoryBusy(false);
            return;
          }
          pending.merged = true;
          requestAnimationFrame(() => {
            if (historyRestoreRef.current !== pending) return;
            restoreHistoryAnchor();
            settleHistoryAfterQuiet();
          });
        })
        .catch(() => {
          if (historyRestoreRef.current !== pending) return;
          cancelHistorySettle();
          historyRestoreRef.current = undefined;
          historyRequestRef.current = false;
          setHistoryBusy(false);
        });
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
                  <span className="nx-pinned-who">{qualifiedAuthorLabel(message, members[message.author])}</span>
                  <span className="nx-pinned-snippet">{pinnedSnippet(message)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div
        ref={scrollerRef}
        className="nx-transcript"
        data-testid="timeline"
        aria-busy={historyBusy}
        onScroll={onScroll}
        onWheel={(event) => {
          const node = scrollerRef.current;
          if (node === null || event.deltaY >= 0 || node.scrollTop >= 80) return;
          // A short first page may not overflow, so an upward wheel at its top
          // produces no native scroll event. It is still an explicit top reach.
          pinnedRef.current = false;
          upwardScrollRef.current += Math.abs(event.deltaY);
          onScroll();
        }}
        tabIndex={0}
      >
        <div ref={columnRef} className="nx-column">
          {/* The skeleton holds until hydration COMMITS. `connected` flips at
              socket-open, before a single frame lands, so gating on it flashed an
              empty transcript and then crawled rows in one at a time. */}
          {historyBlocked && (
            <div className="nx-transcript-history-error" data-testid="transcript-history-error">
              <p className="nx-field-note is-error" role="alert">
                Could not load this channel&apos;s transcript. Retry, or update the host if combined history is unavailable.
              </p>
              <Button
                variant="quiet"
                type="button"
                data-testid="transcript-history-retry"
                onClick={() => {
                  void refreshTranscriptHistoryHead(useClientStore, props.room, props.token);
                }}
              >
                Retry
              </Button>
            </div>
          )}
          {!transcriptReady && !historyBlocked && <TranscriptSkeleton />}
          {transcriptReady && history.units.length === 0 && liveVisible.length === 0 && (
            <p className="nx-empty" data-testid="timeline-empty">No messages yet — say something.</p>
          )}
          {/* harn:assume finalized-browser-history-is-combined-page-owned ref=combined-history-rendering */}
          {transcriptReady && renderHistoricalTimeline(renderedHistory, {
            members, selfId, selfHandle, inbox,
            room: props.room, token: props.token, connection: props.connection,
            canPin, canDelete, canRetry,
            actionErrorCount: slice.errorRefs.act ?? 0,
            actionError: slice.errors.at(-1),
          })}
          {transcriptReady && renderTimeline(entries, {
            members, selfId, selfHandle, inbox,
            room: props.room, token: props.token, connection: props.connection,
            canPin, canDelete, canRetry,
            actionErrorCount: slice.errorRefs.act ?? 0,
            actionError: slice.errors.at(-1),
            preservedRoots: preservedSettledRoots,
            liveToolOnlyOutputs,
          })}
          {/* harn:end finalized-browser-history-is-combined-page-owned */}
          {transcriptReady && detachedInteractions.length > 0 && (
            <section className="nx-action-tray" aria-label="Needs your response" data-testid="interaction-tray">
              <p className="nx-action-tray-label">Needs your response</p>
              {renderTimeline(buildTimelineEntries(detachedInteractions, new Map()), {
                members, selfId, selfHandle, inbox,
                room: props.room, token: props.token, connection: props.connection,
                canPin, canDelete, canRetry,
                actionErrorCount: slice.errorRefs.act ?? 0,
                actionError: slice.errors.at(-1),
              })}
            </section>
          )}
          {workingAgents.length > 0 && (
            // Sticky floor of the scroller: visible at any scroll position, one
            // chip per working agent, present only while someone is working.
            <div className="nx-typing-bar" data-testid="live-activity">
              {workingAgents.map((agent) => (
                <span key={agent.id} className="nx-typing-agent" data-testid={`typing-${agent.handle}`}>
                  <Chip name={agent.handle} accent={memberAccent(agent)} size={24} />
                  <TypingDots label={`@${agent.handle} is working`} />
                  {/* The pill is the ONE activity surface, so the clock lives
                      here rather than inside a transcript row. It counts from
                      the lifecycle root's start, so interjections and
                      continuations never restart it. */}
                  {runningSince[agent.id] !== undefined && (
                    <ElapsedSince ts={runningSince[agent.id]!} />
                  )}
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
            if (node) {
              node.scrollTop = node.scrollHeight;
              lastScrollTopRef.current = node.scrollTop;
            }
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
  preserveJournal?: boolean;
  liveFamilyMessages?: Message[];
  actionErrorCount: number;
  actionError: string | undefined;
  historical?: {
    units: { unit: TranscriptHistoryUnit; events: TranscriptHistoryIndexedEvent[] }[];
    root: Message | undefined;
    targetIds: number[];
  };
}) {
  const { message, author } = props;
  const isMobile = useIsMobile();
  const held = Object.values(props.deliveries).filter(
    (delivery) => delivery.message_id === message.id
      && delivery.state === 'held'
      && props.members[delivery.recipient]?.kind === 'agent',
  );
  const [heldOpen, setHeldOpen] = useState(false);
  // harn:assume held-delivery-release-is-one-shot-and-recoverable ref=one-shot-held-release
  const heldReleasePendingRef = useRef(new Set<string>());
  const [heldReleaseAttempts, setHeldReleaseAttempts] = useState<Record<string, {
    errorCount: number;
    error?: string;
  }>>({});
  const heldIds = held.map((delivery) => delivery.id).sort().join(',');
  useEffect(() => {
    const retained = new Set(held.map((delivery) => delivery.id));
    setHeldReleaseAttempts((current) => {
      let changed = false;
      const next = { ...current };
      for (const [deliveryId, attempt] of Object.entries(current)) {
        if (!retained.has(deliveryId)) {
          heldReleasePendingRef.current.delete(deliveryId);
          delete next[deliveryId];
          changed = true;
          continue;
        }
        if (attempt.error === undefined && props.actionErrorCount > attempt.errorCount) {
          heldReleasePendingRef.current.delete(deliveryId);
          next[deliveryId] = {
            errorCount: props.actionErrorCount,
            error: props.actionError ?? 'Could not retry delivery',
          };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [heldIds, props.actionError, props.actionErrorCount]);
  const releaseHeld = (deliveryId: string): void => {
    if (heldReleasePendingRef.current.has(deliveryId)) return;
    heldReleasePendingRef.current.add(deliveryId);
    setHeldReleaseAttempts((current) => ({
      ...current,
      [deliveryId]: { errorCount: props.actionErrorCount },
    }));
    props.connection.act({ act: 'release_hold', delivery_id: deliveryId });
  };
  // harn:end held-delivery-release-is-one-shot-and-recoverable
  const historicalId = props.historical?.targetIds[0];
  const articleUnit = props.historical?.units.length === 1
    && props.historical.units[0]?.unit.kind === 'message'
    ? props.historical.units[0].unit
    : undefined;
  const historyTargets = props.historical?.targetIds.slice(1).map((id) => (
    <span key={id} id={String(id)} aria-hidden="true" />
  ));
  const liveTargets = props.liveFamilyMessages?.slice(1).map((target) => (
    <span key={target.id} id={String(target.id)} aria-hidden="true" />
  ));
  // A message that @-mentions the viewer is highlighted so it stands out.
  const mentionsMe = props.viewerId !== undefined
    && message.mentions.some((mention) => mention.member_id === props.viewerId);

  if (message.kind === 'system') {
    return (
      <p
        id={props.historical === undefined ? String(message.id) : historicalId === undefined ? undefined : String(historicalId)}
        data-transcript-unit={articleUnit === undefined ? undefined : transcriptUnitKey(articleUnit)}
        data-testid={`msg-${message.id}`}
        className="nx-system"
      >
        {historyTargets}
        {message.body}
      </p>
    );
  }

  const handle = author?.handle ?? message.author_target?.handle ?? '…';
  const authorLabel = qualifiedAuthorLabel(message, author);

  // Acknowledgements collapse to one quiet line — the ack IS the content.
  if (message.ack === true) {
    return (
      <p
        id={props.historical === undefined ? String(message.id) : historicalId === undefined ? undefined : String(historicalId)}
        data-transcript-unit={articleUnit === undefined ? undefined : transcriptUnitKey(articleUnit)}
        data-testid={`ack-${handle}`}
        className="nx-system nx-ack"
      >
        {historyTargets}
        <Check size={13} aria-hidden="true" /> {authorLabel} acknowledged
      </p>
    );
  }

  // A purged message keeps its place, author, and time but shows only a
  // tombstone — no body, no actions (its pin was cleared server-side too).
  if (message.deleted === true) {
    return (
      <article
        id={props.historical === undefined ? String(message.id) : historicalId === undefined ? undefined : String(historicalId)}
        data-transcript-unit={articleUnit === undefined ? undefined : transcriptUnitKey(articleUnit)}
        data-testid={`msg-${message.id}`}
        className={`nx-turn is-deleted ${props.grouped ? 'is-grouped' : ''} ${props.mine ? 'is-mine' : ''}`}
      >
        {historyTargets}
        {!props.grouped && !isMobile && (
          <Chip name={handle} accent={author ? memberAccent(author) : 'indigo'} size={34} />
        )}
        <div className="nx-turn-main">
          {!props.grouped && (
            <div className="nx-turn-meta">
              {isMobile && (
                <Chip name={handle} accent={author ? memberAccent(author) : 'indigo'} size={24} />
              )}
              <strong className="nx-turn-author">{authorLabel}</strong>
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
    window.dispatchEvent(new CustomEvent('nx-quote', {
      detail: { text: `${authorLabel} > ${line}`, replyTo: message.id },
    }));
  };

  return (
    <article
      id={props.historical === undefined ? String(message.id) : historicalId === undefined ? undefined : String(historicalId)}
      data-transcript-unit={articleUnit === undefined ? undefined : transcriptUnitKey(articleUnit)}
      data-testid={message.kind === 'run' ? `run-${message.id}` : `msg-${message.id}`}
      data-read-seq={messageReadSeq(message, props.mine)}
      data-mentions-me={mentionsMe ? 'true' : undefined}
      className={`nx-turn ${props.grouped ? 'is-grouped' : ''} ${props.mine ? 'is-mine' : ''} ${message.pinned === true ? 'is-pinned' : ''} ${mentionsMe ? 'is-mentioned' : ''}`}
    >
      {historyTargets}
      {liveTargets}
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
            <strong className="nx-turn-author">{authorLabel}</strong>
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
              <SeenTicks
                message={message}
                deliveries={props.deliveries}
                members={props.members}
                heldOpen={heldOpen}
                onHeldToggle={() => setHeldOpen((open) => !open)}
              />
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
          ? <RunContent
              message={message}
              room={props.room}
              token={props.token}
              historical={props.historical === undefined ? undefined : {
                units: props.historical.units,
                root: props.historical.root,
              }}
              preserveJournal={props.preserveJournal}
              liveFamilyMessages={props.liveFamilyMessages}
            />
          : message.kind === 'ask' || message.kind === 'approval'
            ? <AskCardView message={message} connection={props.connection} />
            : message.voice !== undefined
              ? <VoiceCard voice={message.voice} messageId={message.id} body={message.body} highlightHandle={mentionsMe ? props.viewerHandle : undefined} />
              : <MessageProse body={message.body} highlightHandle={mentionsMe ? props.viewerHandle : undefined} />}
        {message.attachments !== undefined && message.attachments.length > 0 && (
          <MessageAttachments room={props.room} token={props.token} attachments={message.attachments} />
        )}
        {/* harn:assume held-delivery-recovery-stays-on-origin-message ref=message-owned-held-recovery */}
        {heldOpen && held.length > 0 && (
          <div className="nx-held-recovery" data-testid={`msg-${message.id}-held-recovery`}>
            {held.map((delivery) => (
              <div key={delivery.id} className="nx-held-recovery-row" data-testid={`hold-${delivery.id}`}>
                <span>
                  Delivery to <strong>@{props.members[delivery.recipient]?.handle ?? '…'}</strong>
                  {' '}stopped after reconnecting
                </span>
                <Button
                  variant="secondary"
                  data-testid={`hold-${delivery.id}-release`}
                  disabled={heldReleaseAttempts[delivery.id] !== undefined
                    && heldReleaseAttempts[delivery.id]?.error === undefined}
                  onClick={() => releaseHeld(delivery.id)}
                >
                  {heldReleaseAttempts[delivery.id] !== undefined
                    && heldReleaseAttempts[delivery.id]?.error === undefined
                    ? 'Retrying…'
                    : 'Retry delivery'}
                </Button>
                <button
                  type="button"
                  className="nx-iconbtn is-quiet"
                  aria-label={`Dismiss delivery error for @${props.members[delivery.recipient]?.handle ?? 'recipient'}`}
                  onClick={() => setHeldOpen(false)}
                >
                  <X size={13} aria-hidden="true" />
                </button>
                {heldReleaseAttempts[delivery.id]?.error !== undefined && (
                  <span className="nx-held-recovery-error" role="alert">
                    {heldReleaseAttempts[delivery.id]!.error}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {/* harn:end held-delivery-recovery-stays-on-origin-message */}
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
      {props.attachments.map((attachment) => (
        <MessageAttachment
          key={attachment.id}
          room={props.room}
          token={props.token()}
          attachment={attachment}
        />
      ))}
    </div>
  );
}

function MessageAttachment(props: { room: string; token: string; attachment: Attachment }) {
  return isImageAttachment(props.attachment.mime)
    ? <RasterMessageAttachment {...props} />
    : <DownloadMessageAttachment {...props} />;
}

function RasterMessageAttachment(props: { room: string; token: string; attachment: Attachment }) {
  const { attachment } = props;
  const [nearRef, near] = useNearViewport();
  const url = useAttachmentObjectUrl(props.room, attachment.id, attachment.mime, props.token, near);
  if (url === undefined) return (
    <span
      ref={nearRef}
      className="nx-attach-image is-loading"
      role="img"
      aria-label={`${attachment.name} image loading`}
      data-testid={`attachment-${attachment.id}`}
    />
  );
  return (
    <a ref={nearRef} className="nx-attach-image" href={url} target="_blank" rel="noreferrer" data-testid={`attachment-${attachment.id}`}>
      <img src={url} alt={attachment.name} loading="lazy" />
    </a>
  );
}

function DownloadMessageAttachment(props: { room: string; token: string; attachment: Attachment }) {
  const { attachment } = props;
  const download = useAttachmentDownload(
    props.room,
    attachment.id,
    attachment.mime,
    props.token,
    attachment.name,
  );
  const contents = (
    <>
      <Paperclip size={14} aria-hidden="true" />
      <span className="nx-attach-name">{attachment.name}</span>
      <span className="nx-attach-size">{formatAttachmentSize(attachment.size)}</span>
    </>
  );
  return (
    <button
      type="button"
      className="nx-attach-download"
      disabled={download.busy}
      data-testid={`attachment-${attachment.id}`}
      onClick={() => { void download.download(); }}
    >
      {contents}
    </button>
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
// harn:assume agent-delivery-lifecycle-streams-v2 ref=steering-delivery-indicator
export function deliveryIndicator(deliveries: readonly Delivery[]): {
  seen: boolean;
  disposition: 'queued' | 'delivered' | 'steered';
  title: string;
} {
  const seen = deliveries.every((delivery) =>
    delivery.state === 'delivering' || delivery.state === 'consumed');
  if (!seen) {
    return { seen: false, disposition: 'queued', title: 'Queued for the next turn' };
  }
  if (deliveries.length > 0 && deliveries.every((delivery) => delivery.steered_ts !== undefined)) {
    return { seen: true, disposition: 'steered', title: 'Steered into the active turn' };
  }
  return { seen: true, disposition: 'delivered', title: 'Delivered to its agents' };
}

function SeenTicks(props: {
  message: Message;
  deliveries: Record<string, Delivery>;
  members: Record<string, Member>;
  heldOpen: boolean;
  onHeldToggle: () => void;
}) {
  const relevant = Object.values(props.deliveries).filter(
    (d) => d.message_id === props.message.id && props.members[d.recipient]?.kind === 'agent',
  );
  if (relevant.length === 0) return null;
  // delivering means the turn already carries the payload — the agent has it.
  const indicator = deliveryIndicator(relevant);
  const held = relevant.filter((delivery) => delivery.state === 'held');
  return (
    <span className="nx-delivery-state">
      <span
        className={`nx-seen ${indicator.seen ? 'is-seen' : ''}`}
        title={indicator.title}
        data-testid={`msg-${props.message.id}-seen`}
        data-seen={indicator.seen}
        data-delivery-disposition={indicator.disposition}
      >
        {indicator.seen ? <CheckCheck size={13} aria-hidden="true" /> : <Clock3 size={12} aria-hidden="true" />}
      </span>
      {held.length > 0 && (
        <button
          type="button"
          className="nx-held-trigger"
          aria-label={`${String(held.length)} held ${held.length === 1 ? 'delivery' : 'deliveries'}`}
          aria-expanded={props.heldOpen}
          data-testid={`msg-${props.message.id}-held`}
          onClick={props.onHeldToggle}
        >
          <CircleAlert size={13} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
// harn:end agent-delivery-lifecycle-streams-v2

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

/** A dictated message: a voice header (icon + static waveform + duration) above
 *  the transcript, drawn from the message's real recording metadata. */
function VoiceCard(props: {
  voice: { duration_seconds: number; levels: number[] };
  messageId: number;
  body: string;
  highlightHandle?: string;
}) {
  return (
    <div className="nx-voice-card" data-testid={`voice-card-${String(props.messageId)}`}>
      <div className="nx-voice-card-head">
        <AudioLines size={16} className="nx-voice-card-icon" aria-hidden="true" />
        <MiniWaveform levels={props.voice.levels} className="nx-voice-card-wave" />
        <span className="nx-voice-card-duration">{formatElapsed(Math.round(props.voice.duration_seconds))}</span>
      </div>
      <MessageProse body={props.body} highlightHandle={props.highlightHandle} />
    </div>
  );
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

function segmentDiffs(segments: readonly RunSegment[]): RunItemDiff[] {
  return segments.flatMap((segment) => segment.kind === 'tools'
    ? segment.rows.flatMap((row) => row.diff === undefined ? [] : [row.diff])
    : []);
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
): { segments: Map<number, RunSegment[]>; version: number } {
  const version = useRunJournalVersion();
  const key = runIds.join(',');
  useEffect(() => {
    for (const id of runIds) requestRunJournal(room, token, id, { terminal: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, token, key]);

  // Segments are memoized per run: a journal commit recomputes only that run,
  // not every run in the room (which would be quadratic in a large transcript).
  const segmentsRef = useRef(
    new Map<string, Map<number, { events: WireEvent[]; segments: RunSegment[] }>>(),
  );
  const segments = useMemo(() => {
    let roomSegments = segmentsRef.current.get(room);
    if (roomSegments === undefined) {
      roomSegments = new Map();
    } else {
      segmentsRef.current.delete(room);
    }
    segmentsRef.current.set(room, roomSegments);
    while (segmentsRef.current.size > SEGMENT_CACHE_ROOMS) {
      const oldest = segmentsRef.current.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      segmentsRef.current.delete(oldest);
    }
    const map = new Map<number, RunSegment[]>();
    for (const id of runIds) {
      const events = getRunJournal(room, id);
      if (events === undefined) continue;
      const cached = roomSegments.get(id);
      if (cached?.events === events) {
        map.set(id, cached.segments);
        continue;
      }
      const segments = segmentTimeline(
        presentRunTimeline(events.map((event, index) => ({ index, event }))),
      );
      roomSegments.set(id, { events, segments });
      map.set(id, segments);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, key, version]);
  return { segments, version };
}

// harn:assume continuation-writer-follows-journaled-output-ownership ref=continuation-web-rendering
export function continuationTrailingText(
  finalText: string,
  streamedText: string,
  outputMessages: boolean,
  hasProse: boolean,
): string {
  return outputMessages && hasProse && finalText.startsWith(streamedText)
    ? finalText.slice(streamedText.length)
    : '';
}

/**
 * When each running agent's CURRENT lifecycle started, keyed by author.
 *
 * The support projection is authoritative: it names the active root for each
 * running agent, including roots outside the hydrated window. Loaded rows are
 * consulted only for authors support did not name, and there the NEWEST start
 * wins — an older running row that never settled would otherwise freeze the
 * clock at a stale lifecycle's start.
 *
 * Pure and exported so both rules can be pinned directly. The authority set is
 * tracked separately because "support already answered for this author" and
 * "some loaded row answered first" are different facts; conflating them made
 * the newest-wins comparison unreachable and silently kept the oldest root.
 */
export function resolveRunningSince(
  activeRuns: Message[],
  loaded: Message[],
): Record<string, string> {
  const roots: Record<string, string> = {};
  const authoritative = new Set<string>();

  for (const message of activeRuns) {
    if (message.run?.status !== 'running') continue;
    authoritative.add(message.author);
    roots[message.author] = message.run.started_ts ?? message.ts;
  }

  for (const message of loaded) {
    if (message.kind !== 'run' || message.run?.status !== 'running') continue;
    if (authoritative.has(message.author)) continue;
    const started = message.run.started_ts ?? message.ts;
    const known = roots[message.author];
    if (known === undefined || started > known) roots[message.author] = started;
  }
  return roots;
}

/**
 * One place decides what a run FAMILY says about itself, so RunContent and
 * RunStretch cannot drift into disagreeing about who owns the status.
 *
 * A family is a lifecycle root plus its continuations. Its terminal marker
 * belongs on the durable result row — the newest row it produced — after that
 * row's own content, never on the root merely because the root holds the
 * lifecycle summary. The live shapes make the difference concrete: #833 kept
 * its prose and tools on the root with an empty result, and #856 was the
 * inverse. Attaching the marker to `isRoot` gets exactly one of those right.
 */
function runFamilyOwners(
  familyIds: number[],
  rootId: number,
  journalOwner: number | undefined,
): { newestId: number; terminalOwnerId: number } {
  const newestId = familyIds.length > 0 ? Math.max(...familyIds) : rootId;
  // The journal is authoritative when it has spoken: run.completed names the
  // row that owns the result, which is what a root outside the hydration
  // window leaves us with.
  return { newestId, terminalOwnerId: journalOwner ?? newestId };
}

function RunContent(props: {
  message: Message;
  room: string;
  token: () => string;
  historical?: {
    units: { unit: TranscriptHistoryUnit; events: TranscriptHistoryIndexedEvent[] }[];
    root: Message | undefined;
  };
  preserveJournal?: boolean;
  liveFamilyMessages?: Message[];
}) {
  const rootId = props.message.run_parent_id ?? props.message.id;
  const storedRoot = useClientStore((state) => {
    const slice = roomSlice(state, props.room);
    return slice.messages[rootId]
      ?? slice.support?.active_runs.find((message) => message.id === rootId);
  });
  const root = props.historical?.root ?? storedRoot;
  // Every row of this family that the client currently holds. A continuation
  // arriving later moves ownership without anything being re-fetched.
  const familyIds = useClientStore((state) => {
    const slice = roomSlice(state, props.room);
    return Object.values(slice.messages)
      .filter((message) => message.id === rootId || message.run_parent_id === rootId)
      .map((message) => message.id)
      .sort((left, right) => left - right)
      .join(',');
  });
  const rootRun = root?.run ?? props.message.run;
  const outputMessages = props.liveFamilyMessages !== undefined
    || props.message.run_parent_id !== undefined
    || rootRun?.output_mode === 'messages';
  const liveOutputIds = props.liveFamilyMessages === undefined
    ? undefined
    : new Set(props.liveFamilyMessages.map((message) => message.id));
  const live = useClientStore(
    (state) => roomSlice(state, props.room).runEvents[rootId],
  );
  const running = rootRun?.status === 'running';
  const isRoot = rootId === props.message.id;
  const version = useRunJournalVersion();

  // The journal covers whatever the live buffer missed (late joins, trimmed
  // buffers) — for running runs too, so a fresh viewer sees the evidence so far.
  // A live run jumps the queue; when it settles, the effect re-runs once with
  // terminal=true so the cache picks up the completed journal exactly once.
  useEffect(() => {
    if (props.historical !== undefined || props.preserveJournal === true) return;
    requestRunJournal(props.room, props.token, rootId, {
      terminal: !running,
      priority: running,
    });
  }, [props.historical, props.preserveJournal, props.room, props.token, rootId, running]);

  const journalEvents = props.historical === undefined
    ? getRunJournal(props.room, rootId)
    : props.historical.units.flatMap((selected) => selected.events.map((indexed) => indexed.event));
  const timeline = useMemo(() => {
    if (props.historical !== undefined) return [];
    const merged = mergeRunEvents(journalEvents, live ?? { events: [], dropped_count: 0 });
    const targeted = outputMessages
      ? merged.filter(({ event }) => {
          const target = event.type === 'run.item'
            || event.type === 'timeline'
            || event.type === 'run.completed'
            ? event.output_message_id
            : undefined;
          return liveOutputIds?.has(target ?? rootId) ?? (target ?? rootId) === props.message.id;
        })
      : merged;
    return presentRunTimeline(targeted);
    // The cached journal is a stable reference, so identity keying is correct
    // here; `live` is a fresh object per streamed frame, so it stays keyed on
    // counts to avoid re-presenting an unchanged list on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journalEvents, live?.events.length, live?.dropped_count, liveOutputIds, outputMessages, props.historical, props.message.id, rootId, version]);
  // harn:assume live-runs-settle-beside-paged-history-once ref=live-history-settlement-renderer
  const historicalSegments = useMemo(() => props.historical?.units.map((selected) => ({
    ...selected,
    segments: segmentTimeline(presentRunTimeline(selected.events)),
  })) ?? [], [props.historical]);
  const segments = useMemo(
    () => props.historical === undefined
      ? segmentTimeline(timeline)
      : historicalSegments.flatMap((selected) => selected.segments),
    [historicalSegments, props.historical, timeline],
  );
  const storedDiffs = useMemo(() => segmentDiffs(segments), [segments]);

  // The prose already streams through text rows; only a run that produced no
  // prose at all (e.g. a failure) falls back to the settled final text.
  const hasProse = segments.some((s) => s.kind === 'prose');
  const settledTail = props.historical === undefined
    || props.historical.units.some((selected) => selected.unit.kind === 'settled_tail');
  const finalText = settledTail && outputMessages
    ? props.message.body
    : settledTail ? props.message.run?.final_text ?? props.message.body : '';
  const streamedText = segments
    .filter((segment): segment is Extract<RunSegment, { kind: 'prose' }> => segment.kind === 'prose')
    .map((segment) => segment.row.text ?? '')
    .join('');
  const trailingText = continuationTrailingText(finalText, streamedText, outputMessages, hasProse);
  // harn:assume run-failure-evidence-is-surfaced ref=web-next-run-error-evidence
  // Failed/interrupted runs have empty bodies by design — their reason lives
  // on run.error and must render, or failures are silently blank.
  const runError = settledTail ? rootRun?.error : undefined;
  // harn:end run-failure-evidence-is-surfaced

  // Who owns the family's terminal marker, and what it may claim.
  const terminal = useMemo(() => {
    const completed = (journalEvents ?? []).find(
      (event) => event.type === 'run.completed',
    ) as { status?: string; output_message_id?: number } | undefined;
    const ids = familyIds === '' ? [] : familyIds.split(',').map(Number);
    // Durable ownership first: when the root is loaded it already NAMES its
    // result row, so guessing "newest" over it would be inventing an answer we
    // were handed. The journal is the fallback for an out-of-window root.
    const { newestId, terminalOwnerId } = runFamilyOwners(
      ids,
      rootId,
      rootRun?.result_message_id ?? completed?.output_message_id,
    );
    // Lifecycle truth comes from the root when we hold it, and otherwise from
    // the terminal journal. With neither, we say NOTHING: a root outside the
    // hydration window is missing evidence, not evidence of success.
    const status = rootRun?.status ?? completed?.status;
    return { newestId, terminalOwnerId, status };
  }, [journalEvents, familyIds, rootId, rootRun?.status, rootRun?.result_message_id]);

  const ownsTerminalMarker = settledTail && (props.historical !== undefined
    || props.message.id === terminal.terminalOwnerId)
    && (terminal.status === 'interrupted' || terminal.status === 'failed');
  // A running turn says nothing in the transcript: the sticky typing pill is
  // the one activity surface, with the one continuous clock. An in-row
  // "running…" line was a second indicator that had to be kept in sync with it,
  // and an empty bubble for a run that has produced nothing yet is noise.

  // Nothing to show yet: no streamed evidence, no settled text. The row still
  // exists (its id and permalink are permanent) but must not paint an empty
  // numbered bubble; CSS hides the whole article until evidence arrives.
  const evidenceFree = running && segments.length === 0
    && finalText.length === 0 && trailingText.length === 0;

  const renderSegments = (selected: readonly RunSegment[], keyPrefix: string): ReactNode[] =>
    selected.map((segment, index) => segment.kind === 'compaction'
      ? (
          <CompactionMarker
            key={`${keyPrefix}-${segment.item.id}`}
            status={segment.item.status}
            trigger={segment.item.trigger}
            preTokens={segment.item.preTokens}
          />
        )
      : segment.kind === 'prose'
      ? (
          <RunTextBlock
            key={`${keyPrefix}-${String(segment.row.eventIndex)}`}
            messageId={props.message.id}
            blockId={segment.row.eventIndex}
            text={segment.row.text ?? ''}
          />
        )
      : <ToolBatch
          key={`${keyPrefix}-tools-${String(segment.rows[0]?.eventIndex ?? index)}`}
          rows={segment.rows}
          diffs={storedDiffs}
        />);

  const settledEvidence = !running && (
    <>
      {!hasProse && finalText.length > 0 && (
        <RunTextBlock messageId={props.message.id} blockId="final" text={finalText} />
      )}
      {trailingText.length > 0 && (
        <RunTextBlock messageId={props.message.id} blockId="final" text={trailingText} />
      )}
      {/* harn:assume run-failure-evidence-is-surfaced ref=web-next-run-error-evidence */}
      {runError !== undefined && runError !== '' && (
        <p className="nx-field-note is-error" role="alert" data-testid="run-error">
          {runError}
        </p>
      )}
      {/* harn:end run-failure-evidence-is-surfaced */}
      {ownsTerminalMarker && (
        <p className={`nx-run-status is-${terminal.status ?? ''}`} data-testid={`run-${props.message.id}-status`}>
          run {terminal.status}
        </p>
      )}
    </>
  );

  const historicalEvidence: ReactNode[] = [];
  for (let index = 0; index < historicalSegments.length;) {
    const selected = historicalSegments[index]!;
    const onlyTools = selected.segments.length > 0
      && selected.segments.every((segment) => segment.kind === 'tools');
    if (onlyTools) {
      const batch = [selected];
      while (index + batch.length < historicalSegments.length) {
        const candidate = historicalSegments[index + batch.length]!;
        if (
          candidate.segments.length === 0
          || !candidate.segments.every((segment) => segment.kind === 'tools')
        ) break;
        batch.push(candidate);
      }
      const rows = batch.flatMap((entry) => entry.segments.flatMap(
        (segment) => segment.kind === 'tools' ? segment.rows : [],
      ));
      historicalEvidence.push(
        <div
          key={batch.map((entry) => transcriptUnitKey(entry.unit)).join('|')}
          data-transcript-unit={transcriptUnitKey(selected.unit)}
        >
          {batch.slice(1).map((entry) => (
            <span key={transcriptUnitKey(entry.unit)} data-transcript-unit={transcriptUnitKey(entry.unit)} />
          ))}
          <ToolBatch rows={rows} diffs={storedDiffs} />
        </div>,
      );
      index += batch.length;
      continue;
    }
    historicalEvidence.push(
      <div
        key={transcriptUnitKey(selected.unit)}
        data-transcript-unit={transcriptUnitKey(selected.unit)}
      >
        {renderSegments(selected.segments, transcriptUnitKey(selected.unit))}
        {selected.unit.kind === 'settled_tail' && settledEvidence}
      </div>,
    );
    index += 1;
  }
  // harn:end live-runs-settle-beside-paged-history-once

  return (
    <div
      className={`nx-run ${evidenceFree ? 'is-evidence-free' : ''}`}
      // Only ever the status we can actually establish. The old
      // `isRoot ? 'running' : 'completed'` fallback made every continuation
      // whose root sat outside the window claim success it had no evidence for.
      {...(terminal.status !== undefined && { 'data-run-status': terminal.status })}
    >
      {props.historical === undefined
        ? <>{renderSegments(segments, 'live')}{settledEvidence}</>
        : historicalEvidence}
    </div>
  );
}
// harn:end continuation-writer-follows-journaled-output-ownership
// harn:end web-compaction-markers-upgrade-in-place

// ── Timeline flattening: a finalized run's segments become top-level entries
// ordered by their journal time, so a human message posted mid-run lands between
// the run's blocks. A non-interrupted run's segments stay contiguous and render
// as one stretch, identical to before. Running/empty runs stay whole turns. ──

type TimelineEntry =
  | { kind: 'turn'; message: Message; ts: number; order: number }
  | { kind: 'runseg'; message: Message; segment: RunSegment; isLast: boolean; ts: number; order: number };

function buildTimelineEntries(visible: Message[], runSegments: Map<number, RunSegment[]>): TimelineEntry[] {
  const floor = continuationFloor(visible);
  const legacy = floor === undefined ? visible : visible.filter((message) => message.id < floor);
  const strict = floor === undefined
    ? []
    : visible.filter((message) => message.id >= floor).sort((left, right) => left.id - right.id);
  const list: TimelineEntry[] = [];
  legacy.forEach((message, index) => {
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
  const legacyEntries = list.sort((left, right) => (left.ts - right.ts) || (left.order - right.order));
  return [
    ...legacyEntries,
    ...strict.map((message, index): TimelineEntry => ({
      kind: 'turn',
      message,
      ts: Date.parse(message.ts),
      order: (legacy.length + index) * 1000,
    })),
  ];
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
  actionErrorCount: number;
  actionError: string | undefined;
  preservedRoots?: ReadonlySet<number>;
  liveToolOnlyOutputs?: ReadonlySet<number>;
}

function renderHistoricalTimeline(
  history: TranscriptHistoryState,
  ctx: TimelineCtx,
): ReactNode[] {
  const out: ReactNode[] = [];
  const anchoredOutputs = new Set<number>();
  const anchoredRoots = new Set<number>();
  const visibleIds = new Set(continuationVisibleMessages(
    Object.values(history.messages),
    history.messages,
  ).map((message) => message.id));
  let previousAuthor: string | undefined;
  let previousTs = Number.NEGATIVE_INFINITY;

  const presentationGroups = groupHistoricalPresentationUnits(history.units);
  for (const groupedUnits of presentationGroups) {
    const unit = groupedUnits[0]!;
    const message = unit.kind === 'message'
      ? history.messages[unit.message_id]
      : history.messages[unit.output_message_id];
    if (message === undefined || !visibleIds.has(message.id)) {
      continue;
    }
    const root = unit.kind === 'message' ? undefined : history.messages[unit.root_message_id];
    const outputIds = groupedUnits.flatMap((selected) => selected.kind === 'message'
      ? [selected.message_id]
      : [selected.output_message_id]);
    const firstOutput = outputIds.some((outputId) => !anchoredOutputs.has(outputId));
    const targetIds: number[] = [];
    for (const outputId of outputIds) {
      if (anchoredOutputs.has(outputId)) continue;
      anchoredOutputs.add(outputId);
      targetIds.push(outputId);
    }
    if (
      unit.kind !== 'message'
      && root?.ack !== true
      && !anchoredRoots.has(unit.root_message_id)
    ) {
      anchoredRoots.add(unit.root_message_id);
      if (!targetIds.includes(unit.root_message_id)) targetIds.push(unit.root_message_id);
    }
    const ts = transcriptTime(message);
    const standaloneRun = message.kind === 'run'
      && (root?.run?.status === 'failed' || root?.run?.status === 'interrupted');
    const grouped = !standaloneRun && (!firstOutput || (
      previousAuthor === message.author
      && message.kind !== 'system'
      && Number.isFinite(ts)
      && Number.isFinite(previousTs)
      && ts - previousTs < GROUP_WINDOW_MS
    ));
    out.push(
      <TurnBlock
        key={groupedUnits.map(transcriptUnitKey).join('|')}
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
        actionErrorCount={ctx.actionErrorCount}
        actionError={ctx.actionError}
        viewerId={ctx.selfId}
        viewerHandle={ctx.selfHandle}
        historical={{
          units: groupedUnits.map((selected) => ({
            unit: selected,
            events: selected.kind === 'message' ? [] : indexedEventsForUnit(history, selected),
          })),
          root,
          targetIds,
        }}
      />,
    );
    previousAuthor = message.kind === 'system' ? undefined : message.author;
    previousTs = ts;
  }
  return out;
}

// harn:assume tool-only-evidence-batches-across-invisible-output-boundaries ref=cross-output-tool-batch-presentation
export function groupHistoricalPresentationUnits(
  units: readonly TranscriptHistoryUnit[],
): TranscriptHistoryUnit[][] {
  const groups: TranscriptHistoryUnit[][] = [];
  for (let index = 0; index < units.length;) {
    const first = units[index]!;
    const group = [first];
    if (first.kind !== 'message') {
      while (index + group.length < units.length) {
        const candidate = units[index + group.length]!;
        if (candidate.kind === 'message' || candidate.output_message_id !== first.output_message_id) break;
        group.push(candidate);
      }
      if (group.every((unit) => unit.kind === 'tool')) {
        while (index + group.length < units.length) {
          const candidate = units[index + group.length]!;
          if (candidate.kind !== 'tool' || candidate.root_message_id !== first.root_message_id) break;
          group.push(candidate);
        }
      }
    }
    groups.push(group);
    index += group.length;
  }
  return groups;
}
// harn:end tool-only-evidence-batches-across-invisible-output-boundaries

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
      const storedDiffs = entries.flatMap((candidate) =>
        candidate.kind === 'runseg' && candidate.message.id === runId
          ? segmentDiffs([candidate.segment])
          : []);
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
          diffs={storedDiffs}
        />,
      );
      prevAuthor = entry.message.author;
    } else {
      const message = entry.message;
      const liveFamilyMessages = message.kind === 'run'
        && ctx.liveToolOnlyOutputs?.has(message.id) === true
        ? collectAdjacentToolOnlyLiveMessages(entries, index, ctx.liveToolOnlyOutputs)
        : [message];
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
          actionErrorCount={ctx.actionErrorCount}
          actionError={ctx.actionError}
          viewerId={ctx.selfId}
          viewerHandle={ctx.selfHandle}
          liveFamilyMessages={liveFamilyMessages.length > 1 ? liveFamilyMessages : undefined}
          preserveJournal={message.kind === 'run'
            && ctx.preservedRoots?.has(message.run_parent_id ?? message.id)}
        />,
      );
      prevAuthor = message.kind === 'system' ? undefined : message.author;
      prevTs = entry.ts;
      index += liveFamilyMessages.length;
    }
  }
  return out;
}

export function groupAdjacentToolOnlyLiveMessages(
  messages: readonly Message[],
  toolOnlyOutputIds: ReadonlySet<number>,
): Message[][] {
  const groups: Message[][] = [];
  for (let index = 0; index < messages.length;) {
    const first = messages[index]!;
    const rootId = first.kind === 'run' ? first.run_parent_id ?? first.id : undefined;
    const group = [first];
    if (rootId !== undefined && toolOnlyOutputIds.has(first.id)) {
      while (index + group.length < messages.length) {
        const candidate = messages[index + group.length]!;
        if (
          candidate.kind !== 'run'
          || (candidate.run_parent_id ?? candidate.id) !== rootId
          || !toolOnlyOutputIds.has(candidate.id)
        ) break;
        group.push(candidate);
      }
    }
    groups.push(group);
    index += group.length;
  }
  return groups;
}

function collectAdjacentToolOnlyLiveMessages(
  entries: readonly TimelineEntry[],
  start: number,
  toolOnlyOutputIds: ReadonlySet<number>,
): Message[] {
  const messages: Message[] = [];
  for (let index = start; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.kind !== 'turn') break;
    const candidate = entry.message;
    const first = messages[0];
    if (
      candidate.kind !== 'run'
      || !toolOnlyOutputIds.has(candidate.id)
      || (first !== undefined
        && (candidate.run_parent_id ?? candidate.id) !== (first.run_parent_id ?? first.id))
    ) break;
    messages.push(candidate);
  }
  return messages;
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
  diffs: RunItemDiff[];
}) {
  const { message, author } = props;
  const isMobile = useIsMobile();
  const handle = author?.handle ?? message.author_target?.handle ?? '…';
  const authorLabel = qualifiedAuthorLabel(message, author);
  const status = message.run?.status;
  const runError = message.run?.error;
  const quote = (): void => {
    const line = message.body.split('\n', 1)[0] ?? '';
    window.dispatchEvent(new CustomEvent('nx-quote', {
      detail: { text: `${authorLabel} > ${line}`, replyTo: message.id },
    }));
  };
  return (
    <article
      id={props.anchored ? String(message.id) : undefined}
      data-testid={`run-${message.id}`}
      data-read-seq={messageReadSeq(message, props.mine)}
      className={`nx-turn ${props.mine ? 'is-mine' : ''}`}
    >
      {!isMobile && <Chip name={handle} accent={author ? memberAccent(author) : 'indigo'} size={34} />}
      <div className="nx-turn-main">
        <div className="nx-turn-meta">
          {isMobile && <Chip name={handle} accent={author ? memberAccent(author) : 'indigo'} size={24} />}
          <strong className="nx-turn-author">{authorLabel}</strong>
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
                : <ToolBatch key={`tools-${segment.rows[0]?.eventIndex ?? index}`} rows={segment.rows} diffs={props.diffs} />,
          )}
          {/* Legacy one-row families split into stretches: the marker belongs on
              the FINAL stretch, after everything that survived, so preserved
              prose and tools still read as what happened before it stopped.
              Same rule RunContent applies to modern families — stated once in
              each renderer rather than left to diverge. */}
          {props.isLastStretch && runError !== undefined && runError !== '' && (
            <p className="nx-field-note is-error" role="alert" data-testid="run-error">{runError}</p>
          )}
          {props.isLastStretch && (status === 'interrupted' || status === 'failed') && (
            <p className={`nx-run-status is-${status}`} data-testid={`run-${message.id}-status`}>
              run {status}
            </p>
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

/** Ticking elapsed value inside a working agent's typing pill. */
function ElapsedSince(props: { ts: string }) {
  const [, force] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsedMs = Math.max(0, Date.now() - Date.parse(props.ts));
  const seconds = Math.floor(elapsedMs / 1000);
  return (
    // Lives in the typing pill, beside the dots that already announce the agent
    // is working — so this is decoration for that label and must not re-announce
    // itself every second. The raw duration is exposed for tests, since the
    // rendered text is too coarse to prove the clock never restarted.
    <span
      className="nx-typing-elapsed"
      data-testid="typing-elapsed"
      data-elapsed-ms={String(elapsedMs)}
      aria-hidden="true"
    >
      {formatRunDuration(seconds * 1000)}
    </span>
  );
}

/** One aggregate line per tool batch — "Ran 4 tools · wrote 3 files +34 −76 ›" —
 *  expanding to the one-line rows. Counts update live while the batch runs. */
function ToolBatch(props: { rows: RunRow[]; diffs: RunItemDiff[] }) {
  const [expanded, setExpanded] = useState(false);
  // A lone tool is its own line on every form factor — no "Ran 1 tool" wrapper.
  if (props.rows.length === 1) return <ToolRow row={props.rows[0]!} diffs={props.diffs} />;

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
          {props.rows.map((row) => <ToolRow key={row.eventIndex} row={row} diffs={props.diffs} />)}
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
 *  spinner. The whole row opens its typed evidence — no bordered card anywhere. */
// harn:assume normalized-run-evidence-dialogs ref=transcript-evidence-dialog-routing
// harn:assume compact-one-line-tool-rows-v2 ref=compact-transcript-tool-row
function ToolRow(props: { row: RunRow; diffs: RunItemDiff[] }) {
  const [inspecting, setInspecting] = useState(false);
  const [showingDiff, setShowingDiff] = useState(false);
  const compact = compactRunRow(props.row);
  const Icon = ROW_ICONS[compact.icon];
  const diff = DIFF_LABEL.exec(compact.label);
  // A file-edit chip opens only this run's persisted evidence. Every other tool
  // keeps the bounded input/output inspector.
  const diffPath = props.row.diff?.path;
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
        onClick={diffPath !== undefined ? () => setShowingDiff(true) : () => setInspecting(true)}
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
      {showingDiff && (
        // harn:assume transcript-diffs-use-immutable-run-evidence ref=historical-diff-dialog
        <RunDiffDialog diffs={props.diffs} initialPath={diffPath} onClose={() => setShowingDiff(false)} />
        // harn:end transcript-diffs-use-immutable-run-evidence
      )}
    </>
  );
}
// harn:end compact-one-line-tool-rows-v2
// harn:end normalized-run-evidence-dialogs

// ── Interaction cards: options answer durably; the resolved card leaves the
// timeline once the server marks its delivery resolved. ─────────────────────

function AskCardView(props: { message: Message; connection: Connection }) {
  const ask = props.message.ask;
  const [picked, setPicked] = useState<string[]>([]);
  // Per-question selections for a multi-question AskUserQuestion, keyed by index.
  const [picks, setPicks] = useState<Record<number, string[]>>({});
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

  // A single AskUserQuestion call may carry several questions; each must be
  // answered before one combined answers object (keyed by question text) is
  // sent. A single question or an approval keeps the original inline behavior.
  const questions = ask.questions;
  if (questions !== undefined && questions.length > 1) {
    const toggle = (qi: number, multi: boolean, label: string): void => {
      setPicks((prior) => {
        const current = prior[qi] ?? [];
        if (!multi) return { ...prior, [qi]: [label] };
        return {
          ...prior,
          [qi]: current.includes(label)
            ? current.filter((value) => value !== label)
            : [...current, label],
        };
      });
    };
    const allAnswered = questions.every((_, qi) => (picks[qi]?.length ?? 0) > 0);
    const submit = (): void => {
      answer(Object.fromEntries(questions.map((question, qi) => {
        const selected = picks[qi] ?? [];
        return [question.question, question.multi === true ? selected : (selected[0] ?? '')];
      })));
    };
    return (
      <div className="nx-ask" data-testid={`ask-${props.message.id}`}>
        <div className="nx-ask-head">
          <span className="nx-ask-kind">Question</span>
        </div>
        {questions.map((question, qi) => (
          <div className="nx-ask-question" key={qi} data-testid={`ask-${props.message.id}-q${String(qi)}`}>
            {question.header !== undefined && <span className="nx-ask-qhead">{question.header}</span>}
            <p className="nx-ask-prompt">{question.question}</p>
            {question.options !== undefined && question.options.length > 0 && (
              <div className="nx-ask-options">
                {question.options.map((option) => (
                  <button
                    key={option.label}
                    className={`nx-btn ${(picks[qi] ?? []).includes(option.label) ? 'is-primary' : ''}`}
                    disabled={sent}
                    title={option.description}
                    data-testid={`ask-${props.message.id}-q${String(qi)}-${option.label}`}
                    onClick={() => toggle(qi, question.multi === true, option.label)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        <button
          className="nx-btn is-primary"
          disabled={sent || !allAnswered}
          data-testid={`ask-${props.message.id}-submit`}
          onClick={submit}
        >
          Send answers
        </button>
        {sent && <p className="nx-ask-sent">Answered — waiting for the agent…</p>}
      </div>
    );
  }

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
