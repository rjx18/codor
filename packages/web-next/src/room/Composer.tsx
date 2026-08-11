import { parseBody, type Member, type WorktreeRoutingCatalog, type WorktreeRoutingMember, type WorktreeRoutingTarget } from '@codor/protocol';
import { ArrowUp, AtSign, Mic, Paperclip, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { Connection } from '@runtime/ws.js';
import { fetchRoutingCatalog } from '@runtime/api.js';

import { useIsMobile } from '../app/session.js';
import { effectiveDefaultRecipient, roomSlice, useClientStore } from '../app/store.js';
import { Chip, IconButton } from '../primitives/primitives.js';
import { memberAccent } from '../primitives/identity.js';
import {
  formatAttachmentSize,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  uploadAttachment,
  type UploadedAttachment,
} from './attachments.js';
import {
  DictationSession,
  downsampleLevels,
  fetchVoiceProviders,
  formatElapsed,
  LONG_PRESS_MS,
  transcribeVoice,
  type DictationTake,
} from './voice.js';
import { MiniWaveform } from './MiniWaveform.js';

const MAX_ROWS = 8;

/** Transcript quote buttons talk to the composer through this event. */
export const QUOTE_EVENT = 'nx-quote';
export interface QuoteRequest { text: string; replyTo: number }

function mentionQuery(draft: string, caret: number): { start: number; query: string } | undefined {
  const upToCaret = draft.slice(0, caret);
  const at = upToCaret.lastIndexOf('@');
  if (at === -1) return undefined;
  if (at > 0 && !/[\s(]/.test(upToCaret[at - 1] ?? '')) return undefined;
  const query = upToCaret.slice(at + 1);
  if (!/^[a-z0-9_-]*$/i.test(query)) return undefined;
  return { start: at, query };
}

export interface QualifiedMentionQuery {
  start: number;
  aliasQuery: string;
  handleQuery: string;
}

export function qualifiedMentionQuery(draft: string, caret: number): QualifiedMentionQuery | undefined {
  const upToCaret = draft.slice(0, caret);
  const match = /(^|[\s(])~([a-z0-9._-]*):@([a-z0-9-]*)$/i.exec(upToCaret);
  if (!match) return undefined;
  return {
    start: match.index + match[1]!.length,
    aliasQuery: match[2]!,
    handleQuery: match[3]!,
  };
}

export interface QualifiedCompletion {
  target: WorktreeRoutingTarget;
  member: WorktreeRoutingMember;
}

// harn:assume qualified-completion-lists-registered-targets-only ref=qualified-composer-completion
/** Pure completion/filtering keeps keyboard and pointer insertion on one path. */
export function qualifiedCompletionCandidates(
  catalog: WorktreeRoutingCatalog,
  query: QualifiedMentionQuery,
): QualifiedCompletion[] {
  const aliasQuery = query.aliasQuery.toLowerCase();
  const handleQuery = query.handleQuery.toLowerCase();
  return catalog.targets
    .filter((target) => target.alias.startsWith(aliasQuery))
    .flatMap((target) => target.members
      .filter((member) => (member.kind === 'human' || member.kind === 'agent')
        && member.handle.startsWith(handleQuery))
      .map((member) => ({ target, member })))
    .slice(0, 8);
}

export function insertQualifiedMentionText(
  value: string,
  query: QualifiedMentionQuery,
  completion: QualifiedCompletion,
  caret: number,
): { text: string; caret: number } {
  const token = `~${completion.target.alias}:@${completion.member.handle}`;
  return {
    text: `${value.slice(0, query.start)}${token} ${value.slice(caret)}`,
    caret: query.start + token.length + 1,
  };
}
// harn:end qualified-completion-lists-registered-targets-only

// harn:assume exact-trailing-mentions-send-before-completion ref=exact-trailing-mention-keydown
export function exactQualifiedMention(
  query: QualifiedMentionQuery | undefined,
  candidates: readonly QualifiedCompletion[],
): boolean {
  if (query === undefined) return false;
  return candidates.some(({ target, member }) =>
    target.alias.toLowerCase() === query.aliasQuery.toLowerCase()
    && member.handle.toLowerCase() === query.handleQuery.toLowerCase());
}

export function exactLocalMention(
  query: { query: string } | undefined,
  candidates: readonly Member[],
): boolean {
  if (query === undefined) return false;
  return candidates.some((member) =>
    member.handle.toLowerCase() === query.query.toLowerCase());
}
// harn:end exact-trailing-mentions-send-before-completion

/** The spoken-message body: mention prefix (omitted when unaddressed — never a
 *  dangling `@`), then the plain newline-joined transcript. No marker glyphs —
 *  the voice-ness rides the message's `voice` metadata, rendered as a card. */
export function composeVoiceBody(recipientHandle: string | undefined, texts: string[]): string {
  const body = texts.join('\n');
  return recipientHandle ? `@${recipientHandle} ${body}` : body;
}

/** The voice recipient when the panel opens: the first roster member @-mentioned
 *  in the draft, else the composer's effective default, else unaddressed. */
export function deriveVoiceRecipientHandle(
  draft: string,
  rosterHandles: readonly string[],
  fallbackHandle: string | undefined,
): string | undefined {
  for (const match of draft.matchAll(/@([a-z0-9_-]+)/gi)) {
    const handle = rosterHandles.find((candidate) => candidate.toLowerCase() === match[1]!.toLowerCase());
    if (handle) return handle;
  }
  return fallbackHandle;
}

/** Docked composer: auto-grow, Enter sends, Shift+Enter breaks. Drafts start
 *  addressed to the effective default recipient, an @ opens the mention popover,
 *  and a send that addresses nobody is blocked with an inline hint instead of
 *  leaving the room to guess (Richard #302). */
export function Composer(props: { room: string; token: () => string; connection: Connection }) {
  const isMobile = useIsMobile();
  const connected = useClientStore((state) => state.connected);
  const slice = useClientStore((state) => roomSlice(state, props.room));
  const members = slice.members;
  const room = slice.room;
  const hydrated = slice.hydrated;
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<number>();
  const [hint, setHint] = useState<string>();
  const [mention, setMention] = useState<{ start: number; query: string }>();
  const [highlighted, setHighlighted] = useState(0);
  const [pending, setPending] = useState<UploadedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const seededRef = useRef(false);
  const pendingCaretRef = useRef<number>();
  const [routingCatalog, setRoutingCatalog] = useState<WorktreeRoutingCatalog>();
  const [qualifiedMention, setQualifiedMention] = useState<QualifiedMentionQuery>();
  const [pendingSend, setPendingSend] = useState<{
    body: string;
    targetRoom: string;
    knownMessageKeys: Set<string>;
    authorId: string | undefined;
    errorCount: number;
  }>();
  const roomSlices = useClientStore((state) => state.rooms);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [takes, setTakes] = useState<DictationTake[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [sending, setSending] = useState(false);
  const [voiceRecipient, setVoiceRecipient] = useState<string>();
  const [recipientPicker, setRecipientPicker] = useState(false);
  const sessionRef = useRef<DictationSession>();
  const levelsRef = useRef<number[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const suppressClickRef = useRef(false);
  const recording = takes.some((take) => take.state === 'recording');

  // harn:assume readable-reconnecting-room-never-admits-mutation ref=offline-composer-http-boundary
  // Event-level disabling is presentation, not authority: paste/drop and a
  // hidden input can invoke uploads without a visible button, while a dictation
  // session opened online can reach transcription after the socket drops.
  const mediaMutationReadyRef = useRef(false);
  mediaMutationReadyRef.current = connected && hydrated;
  const mediaMutationAllowed = (kind: 'attachment' | 'voice'): boolean => {
    if (mediaMutationReadyRef.current) return true;
    setHint(kind === 'attachment'
      ? 'Reconnect before uploading files'
      : 'Reconnect before using voice');
    return false;
  };
  // harn:end readable-reconnecting-room-never-admits-mutation

  // Programmatic inserts restore the caret synchronously with the DOM update —
  // an rAF here loses keystrokes racing in from a fast typist.
  // Size against the COMMITTED draft, not the keystroke that caused it: quoting,
  // mention insertion and clearing after send all change the value without an
  // input event, and each must land on a correctly sized box. Clearing shrinks
  // it back to one row for the same reason.
  useLayoutEffect(() => {
    autoGrow();
  }, [draft]);

  useLayoutEffect(() => {
    const caret = pendingCaretRef.current;
    if (caret === undefined) return;
    pendingCaretRef.current = undefined;
    const node = areaRef.current;
    if (!node) return;
    node.setSelectionRange(caret, caret);
    node.focus();
    refreshMention();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const roster = useMemo(
    () => Object.values(members)
      .filter((member) => member.removed_ts === undefined && member.kind !== 'extension'),
    [members],
  );
  const mentionables = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.toLowerCase();
    return roster
      .filter((m) => m.handle.toLowerCase().startsWith(query))
      .slice(0, 6);
  }, [mention, roster]);

  const qualifiedMentionables = useMemo<QualifiedCompletion[]>(() => (
    qualifiedMention === undefined || routingCatalog === undefined
      ? []
      : qualifiedCompletionCandidates(routingCatalog, qualifiedMention)
  ), [qualifiedMention, routingCatalog]);

  const defaultRecipient = useMemo(
    () => effectiveDefaultRecipient(slice),
    [slice],
  );

  // harn:assume qualified-completion-lists-registered-targets-only ref=qualified-target-catalog-client
  // Completion receives a path-free persisted projection. A missing/non-Git
  // catalog is an ordinary empty completion set, never a discovery trigger.
  useEffect(() => {
    let live = true;
    setRoutingCatalog(undefined);
    void fetchRoutingCatalog(props.room, { token: props.token() })
      .then((catalog) => { if (live) setRoutingCatalog(catalog); })
      .catch(() => {
        if (live) setRoutingCatalog({ room: props.room, targets: [], tombstones: [] });
      });
    return () => { live = false; };
  }, [props.room, props.token]);
  // harn:end qualified-completion-lists-registered-targets-only

  // harn:assume invalid-qualified-targets-never-fallback ref=qualified-composer-refusal
  // Keep a post draft until the own-message echo commits or the existing error
  // frame arrives. A lifecycle race therefore remains visible and retryable.
  useEffect(() => {
    if (pendingSend === undefined) return;
    const committed = Object.entries(roomSlices).some(([roomId, roomState]) =>
      roomId === pendingSend.targetRoom
      && Object.values(roomState.messages).some((message) =>
        !pendingSend.knownMessageKeys.has(`${roomId}:${String(message.id)}`)
        && (message.author === pendingSend.authorId || pendingSend.targetRoom !== props.room)
        && message.kind === 'chat'
        && message.body === pendingSend.body));
    if (committed) {
      setPendingSend(undefined);
      if ((areaRef.current?.value ?? draft) === pendingSend.body) {
        setDraft('');
        setReplyTo(undefined);
        setPending([]);
        seededRef.current = false;
        setMention(undefined);
        setQualifiedMention(undefined);
        requestAnimationFrame(autoGrow);
      }
      return;
    }
    if (slice.errors.length > pendingSend.errorCount) {
      setHint(slice.errors.at(-1) ?? 'Message was refused');
      setPendingSend(undefined);
    }
  }, [draft, pendingSend, props.room, roomSlices, slice.errors]);
  // harn:end invalid-qualified-targets-never-fallback

  // Until the operator edits, the seeded draft follows hydration as the latest
  // agent chain becomes known. The first manual change locks that draft.
  useEffect(() => {
    if (seededRef.current || defaultRecipient === undefined) return;
    const seededDraft = `@${defaultRecipient.handle} `;
    if (draft !== seededDraft) setDraft(seededDraft);
  }, [draft, defaultRecipient]);

  // Quote buttons in the transcript prepend their text into the draft.
  useEffect(() => {
    const onQuote = (event: Event): void => {
      const detail = (event as CustomEvent<QuoteRequest | string>).detail;
      const text = typeof detail === 'string' ? detail : detail.text;
      if (typeof detail !== 'string') setReplyTo(detail.replyTo);
      seededRef.current = true;
      setDraft((prior) => {
        const lead = prior !== '' && !prior.endsWith('\n') ? `${prior}\n` : prior;
        return `${lead}${text}\n`;
      });
      areaRef.current?.focus();
      requestAnimationFrame(autoGrow);
    };
    window.addEventListener(QUOTE_EVENT, onQuote);
    return () => window.removeEventListener(QUOTE_EVENT, onQuote);
  }, []);

  // Discover dictation once: a disabled or unreachable catalog renders no mic.
  useEffect(() => {
    let live = true;
    void fetchVoiceProviders(props.token())
      .then((catalog) => { if (live) setVoiceEnabled(catalog.enabled); })
      .catch(() => { if (live) setVoiceEnabled(false); });
    return () => { live = false; };
  }, []);

  // Unmounting mid-dictation (channel switch) must release the microphone —
  // discardAll cancels any live recording handle and drops the queue.
  useEffect(() => () => { sessionRef.current?.discardAll(); }, []);

  // The elapsed clock ticks only while a take is recording; it resets each take.
  useEffect(() => {
    if (!recording) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250);
    return () => window.clearInterval(id);
  }, [recording]);

  // Left-scrolling waveform: newest level bars enter at the right, the trail
  // slides left as the buffer grows. Reduced-motion draws the recent levels once.
  useEffect(() => {
    if (!panelOpen || !recording) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    const draw = (): void => {
      const w = canvas.width = canvas.clientWidth || 320;
      const h = canvas.height = canvas.clientHeight || 44;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = getComputedStyle(canvas).color || '#d33';
      const barW = 3;
      const gap = 2;
      const slots = Math.max(1, Math.floor(w / (barW + gap)));
      const recent = levelsRef.current.slice(-slots);
      recent.forEach((level, index) => {
        const barH = Math.max(2, level * h);
        const x = w - (recent.length - index) * (barW + gap);
        ctx.fillRect(x, (h - barH) / 2, barW, barH);
      });
      if (!reduced) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [panelOpen, recording]);

  const canSend = connected && hydrated && !uploading && (draft.trim().length > 0 || pending.length > 0);

  // Attach files: enforce the caps with plain messaging, then upload each so the
  // post frame can reference server ids. Chips show what will ride the message.
  const addFiles = (files: File[]): void => {
    if (files.length === 0) return;
    if (!mediaMutationAllowed('attachment')) return;
    let batch = files;
    if (batch.some((file) => file.size > MAX_ATTACHMENT_BYTES)) {
      setHint('Files must be under 25 MB');
      batch = batch.filter((file) => file.size <= MAX_ATTACHMENT_BYTES);
    }
    const slotsLeft = MAX_ATTACHMENTS_PER_MESSAGE - pending.length;
    if (batch.length > slotsLeft) {
      setHint(`Up to ${String(MAX_ATTACHMENTS_PER_MESSAGE)} files per message`);
      batch = batch.slice(0, Math.max(0, slotsLeft));
    }
    if (batch.length === 0) return;
    setUploading(true);
    void (async () => {
      try {
        for (const file of batch) {
          if (!mediaMutationAllowed('attachment')) break;
          const uploaded = await uploadAttachment(props.room, props.token(), file);
          setPending((prior) => [...prior, uploaded]);
        }
      } catch (error) {
        setHint(error instanceof Error ? error.message : 'Upload failed');
      } finally {
        setUploading(false);
      }
    })();
  };

  const removePending = (id: string): void => {
    setPending((prior) => prior.filter((attachment) => attachment.id !== id));
  };

  const autoGrow = (): void => {
    const node = areaRef.current;
    if (!node) return;
    const previousHeight = node.style.height;
    node.style.height = 'auto';
    const style = getComputedStyle(node);
    const line = parseFloat(style.lineHeight) || 24;
    // The cap is a HEIGHT, and height here includes the box's own vertical
    // padding. Capping at `line * 8` alone left the eighth row clipped by
    // exactly that padding — eight rows of text never fit in an "eight row" box.
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const cap = Math.round(line * MAX_ROWS + (Number.isFinite(padding) ? padding : 0));
    const nextHeight = `${Math.min(node.scrollHeight, cap)}px`;
    node.style.height = nextHeight;
    // The transcript remains the sole geometry owner. This synchronous signal
    // only tells it that its viewport changed, so a pinned reader is corrected
    // before the browser can paint the composer-induced gap.
    if (nextHeight !== previousHeight) {
      const previousPixels = Number.parseFloat(previousHeight);
      window.dispatchEvent(new CustomEvent('codor:composer-geometry', {
        detail: {
          delta: Number.isFinite(previousPixels)
            ? Number.parseFloat(nextHeight) - previousPixels
            : 0,
        },
      }));
    }
  };

  const refreshMention = (): void => {
    const node = areaRef.current;
    if (!node) return;
    const caret = node.selectionStart ?? node.value.length;
    setQualifiedMention(qualifiedMentionQuery(node.value, caret));
    setMention(mentionQuery(node.value, caret));
    setHighlighted(0);
  };

  const insertMention = (member: Member): void => {
    if (!mention) return;
    seededRef.current = true;
    const node = areaRef.current;
    const caret = node?.selectionStart ?? draft.length;
    const next = `${draft.slice(0, mention.start)}@${member.handle} ${draft.slice(caret)}`;
    setDraft(next);
    setMention(undefined);
    pendingCaretRef.current = mention.start + member.handle.length + 2;
  };

  const insertQualifiedMention = (
    completion: QualifiedCompletion,
    query = qualifiedMention,
  ): void => {
    if (query === undefined) return;
    seededRef.current = true;
    const node = areaRef.current;
    const value = node?.value ?? draft;
    const caret = node?.selectionStart ?? value.length;
    const next = insertQualifiedMentionText(value, query, completion, caret);
    setDraft(next.text);
    setMention(undefined);
    setQualifiedMention(undefined);
    pendingCaretRef.current = next.caret;
  };

  const closeDictation = (): void => {
    sessionRef.current = undefined;
    levelsRef.current = [];
    suppressClickRef.current = false;
    setPanelOpen(false);
    setTakes([]);
    setSending(false);
    setRecipientPicker(false);
    requestAnimationFrame(() => areaRef.current?.focus());
  };

  const openDictation = (): void => {
    if (!mediaMutationAllowed('voice')) return;
    const derived = deriveVoiceRecipientHandle(
      areaRef.current?.value ?? draft,
      roster.map((member) => member.handle),
      defaultRecipient?.handle,
    );
    setVoiceRecipient(derived);
    setHint(undefined);
    levelsRef.current = [];
    const session = new DictationSession({
      transcribe: async (wav) => {
        if (!mediaMutationAllowed('voice')) throw new Error('Reconnect before using voice');
        return transcribeVoice(props.token(), wav);
      },
      onChange: setTakes,
      onLevel: (level) => {
        levelsRef.current.push(level);
        if (levelsRef.current.length > 512) levelsRef.current.shift();
      },
    });
    sessionRef.current = session;
    setPanelOpen(true);
    // The bar (and the clicked mic) unmounts, so move focus onto the panel or
    // the spec'd Enter/Esc keys land on <body> and do nothing.
    requestAnimationFrame(() => panelRef.current?.focus());
    void session.startTake();
  };

  // Cancel/remove that empties the take list closes the panel; a live recording
  // is decided from the session snapshot, which onChange has already emitted.
  const cancelRecording = (): void => {
    const session = sessionRef.current;
    if (!session) return;
    session.cancelTake();
    if (session.snapshot().length === 0) closeDictation();
  };
  const removeSegment = (id: string): void => {
    const session = sessionRef.current;
    if (!session) return;
    session.removeTake(id);
    if (session.snapshot().length === 0) closeDictation();
  };
  const discardDictation = (): void => {
    sessionRef.current?.discardAll();
    closeDictation();
  };
  const sendDictation = (): void => {
    const session = sessionRef.current;
    if (!session || sending || !mediaMutationAllowed('voice')) return;
    setSending(true); // single-slot: a second press is impossible
    setHint(undefined);
    session.sendWhenReady()
      .then((texts) => {
        const done = session.snapshot().filter((take) => take.state === 'done');
        const duration = done.reduce((sum, take) => sum + take.durationSeconds, 0);
        const voice = {
          duration_seconds: Math.min(600, Math.max(0.1, duration)),
          levels: downsampleLevels(done.flatMap((take) => take.levels)),
        };
        props.connection.post(composeVoiceBody(voiceRecipient, texts), { voice });
        closeDictation();
      })
      .catch(() => {
        // A failed take keeps its inline error on the chip; the panel stays open
        // so the operator can remove it or retry Send (done takes never re-upload).
        setSending(false);
      });
  };

  // Long-press the mic to hold-to-record: pointerdown opens the panel in the
  // recording state; a release ≥350 ms performs Add, a shorter tap leaves it
  // recording (today's behavior). The synthetic click after a pointer press is
  // swallowed so it never re-opens; keyboard activation still routes to click.
  const onMicPointerDown = (event: { pointerType: string; button: number }): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const started = Date.now();
    suppressClickRef.current = true; // a pointer press opens the panel; swallow its click
    openDictation();
    // The mic unmounts when the panel takes over, so catch the release on the
    // window: a hold ≥350 ms performs Add; a quick tap leaves the take recording.
    const onUp = (): void => {
      window.removeEventListener('pointerup', onUp);
      if (Date.now() - started >= LONG_PRESS_MS) void sessionRef.current?.addTake();
    };
    window.addEventListener('pointerup', onUp);
  };
  const onMicClick = (): void => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    openDictation(); // keyboard activation (no pointerdown fired)
  };

  const voiceHasAgents = roster.some((member) => member.kind === 'agent');
  const recipientChip = voiceHasAgents ? (
    <div className="nx-dictation-recipient-wrap">
      <button
        type="button"
        className="nx-dictation-recipient"
        data-testid="dictation-recipient"
        aria-haspopup="listbox"
        onClick={() => setRecipientPicker((open) => !open)}
      >
        → {voiceRecipient ? `@${voiceRecipient}` : 'no recipient'}
      </button>
      {recipientPicker && (
        <ul className="nx-dictation-recipient-list" role="listbox" aria-label="Choose recipient" data-testid="dictation-recipient-list">
          {roster.map((member) => (
            <li key={member.id} role="presentation">
              <button
                role="option"
                aria-selected={member.handle === voiceRecipient}
                className={`nx-mention ${member.handle === voiceRecipient ? 'is-active' : ''}`}
                onClick={() => { setVoiceRecipient(member.handle); setRecipientPicker(false); }}
              >
                <Chip name={member.handle} accent={memberAccent(member)} size={20} />
                <span className="nx-mention-handle">@{member.handle}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  ) : null;

  const dictationPanel = (
    <div
      ref={panelRef}
      className="nx-dictation-panel"
      data-testid="composer-dictation-panel"
      role="group"
      aria-label="Voice dictation"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (recording && event.key === 'Enter') {
          event.preventDefault();
          void sessionRef.current?.addTake();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          if (recording) cancelRecording(); else discardDictation();
        }
      }}
    >
      <div className="nx-dictation-head">
        {recipientChip}
        {recording && (
          <span className="nx-dictation-clock" data-testid="dictation-clock">
            <span className="nx-dictation-dot" aria-hidden="true" /> Recording {formatElapsed(elapsed)}
          </span>
        )}
      </div>

      {recording ? (
        <>
          <canvas ref={canvasRef} className="nx-dictation-wave" data-testid="dictation-wave" aria-hidden="true" />
          <div className="nx-dictation-controls">
            <span className="nx-composer-spacer" />
            <IconButton icon={X} label="Cancel dictation" variant="quiet" data-testid="dictation-cancel" onClick={cancelRecording} />
            <button type="button" className="nx-btn is-primary nx-dictation-add" data-testid="dictation-add" onClick={() => void sessionRef.current?.addTake()}>
              Add
            </button>
          </div>
        </>
      ) : (
        <>
          <ul className="nx-dictation-memos" data-testid="dictation-segments">
            {takes.map((take, index) => (
              <li key={take.id} className={`nx-memo-chip is-${take.state}`} data-testid={`dictation-segment-${String(index)}`}>
                <MiniWaveform levels={take.levels} className="nx-memo-wave" />
                <span className="nx-memo-duration">{formatElapsed(Math.round(take.durationSeconds))}</span>
                {take.state === 'transcribing' && <span className="nx-dictation-spinner" aria-hidden="true" />}
                {take.state === 'done' && <span className="nx-memo-ok" aria-hidden="true">✓</span>}
                {take.state === 'failed' && (
                  <span className="nx-memo-error" data-testid={`dictation-segment-${String(index)}-error`}>{take.error}</span>
                )}
                <button
                  type="button"
                  className="nx-attach-remove"
                  aria-label={`Remove take ${String(index + 1)}`}
                  data-testid={`dictation-segment-${String(index)}-remove`}
                  onClick={() => removeSegment(take.id)}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <div className="nx-dictation-controls">
            <IconButton icon={Mic} label="Record another" variant="quiet" data-testid="dictation-record-another" onClick={() => void sessionRef.current?.startTake()} />
            <IconButton icon={X} label="Discard all" variant="quiet" data-testid="dictation-discard" onClick={discardDictation} />
            <span className="nx-composer-spacer" />
            {sending ? (
              <span className="nx-dictation-loader" role="status" aria-label="Transcribing" data-testid="dictation-waiting" />
            ) : (
              <button type="button" className="nx-btn is-primary nx-dictation-send" data-testid="dictation-send" onClick={sendDictation}>
                Send
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );

  const micButton = voiceEnabled ? (
    <IconButton
      icon={Mic}
      label="Start dictation (hold to record)"
      variant="quiet"
      className="nx-composer-mic"
      data-testid="composer-mic"
      onPointerDown={onMicPointerDown}
      onClick={onMicClick}
    />
  ) : null;

  const send = (): void => {
    // Enter can follow an input event before React has committed the matching
    // state render under load. Read the controlled element at the action edge
    // so an overwritten seeded @mention can never be submitted from a stale
    // closure.
    const body = (areaRef.current?.value ?? draft).trim();
    if (pendingSend !== undefined || !connected || !hydrated || uploading || (body.length === 0 && pending.length === 0)) return;
    const parsed = parseBody(body, roster, {
      qualifiedTargets: routingCatalog,
    });
    if ((parsed.qualified_issues?.length ?? 0) > 0) {
      setHint(parsed.qualified_issues!.map((issue) =>
        `${issue.token}: ${issue.reason.replaceAll('-', ' ')}`).join('; '));
      return;
    }
    const addressed = parsed.mentions.length > 0
      || roster.some((m) => new RegExp(`@${m.handle}\\b`, 'i').test(body));
    if (!addressed && roster.some((m) => m.kind === 'agent')) {
      setHint(
        defaultRecipient
          ? `Say who this is for — try @${defaultRecipient.handle}`
          : 'Say who this is for — mention someone with @',
      );
      return;
    }
    const targetRoom = parsed.qualified?.[0]?.target?.conversation_id ?? props.room;
    const knownMessageKeys = new Set(Object.entries(useClientStore.getState().rooms).flatMap(
      ([roomId, roomState]) => Object.keys(roomState.messages)
        .map((id) => `${roomId}:${id}`),
    ));
    setPendingSend({
      body,
      targetRoom,
      knownMessageKeys,
      authorId: slice.selfMemberId,
      errorCount: slice.errors.length,
    });
    props.connection.post(body, {
      ...(replyTo !== undefined && { replyTo }),
      ...(pending.length > 0 && { attachments: pending.map((attachment) => attachment.id) }),
    });
    setHint(undefined);
  };

  return (
    <footer
      className="nx-composer"
      onDragOver={(event) => { event.preventDefault(); }}
      onDrop={(event) => {
        event.preventDefault();
        addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {replyTo !== undefined && (
        <p className="nx-composer-reply" data-testid="composer-reply">
          Replying to #{replyTo}
          <button type="button" aria-label="Cancel reply" onClick={() => setReplyTo(undefined)}>
            <X size={12} aria-hidden="true" />
          </button>
        </p>
      )}
      {hint !== undefined && (
        <p className="nx-composer-hint" role="alert" data-testid="composer-hint">{hint}</p>
      )}
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        data-testid="composer-file"
        onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []));
          event.target.value = ''; // let the same file be picked again
        }}
      />
      {pending.length > 0 && (
        <ul className="nx-attach-tray" data-testid="attach-tray">
          {pending.map((attachment) => (
            <li key={attachment.id} className="nx-attach-chip" data-testid={`pending-${attachment.id}`}>
              <span className="nx-attach-name">{attachment.name}</span>
              <span className="nx-attach-size">{formatAttachmentSize(attachment.size)}</span>
              <button
                type="button"
                className="nx-attach-remove"
                aria-label={`Remove ${attachment.name}`}
                data-testid={`pending-${attachment.id}-remove`}
                onClick={() => removePending(attachment.id)}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {panelOpen ? dictationPanel : (
      <div className="nx-composer-bar">
        {qualifiedMention !== undefined && qualifiedMentionables.length > 0 && (
          <ul className="nx-mentions" role="listbox" aria-label="Mention a worktree member" data-testid="qualified-mention-popover">
            {qualifiedMentionables.map((completion, index) => (
              <li key={`${completion.target.worktree_id}:${completion.member.member_id}`} role="presentation">
                <button
                  role="option"
                  aria-selected={index === highlighted}
                  className={`nx-mention ${index === highlighted ? 'is-active' : ''}`}
                  onMouseEnter={() => setHighlighted(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    insertQualifiedMention(completion);
                  }}
                >
                  <Chip name={completion.member.handle} accent="indigo" size={24} />
                  <span className="nx-mention-handle">~{completion.target.alias}:@{completion.member.handle}</span>
                  <span className="nx-mention-kind">{completion.member.kind}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {qualifiedMention === undefined && mention && mentionables.length > 0 && (
          <ul className="nx-mentions" role="listbox" aria-label="Mention someone" data-testid="mention-popover">
            {mentionables.map((member, index) => (
              // The li is presentational: a listbox's only permitted children
              // are options, and the button below is the option. Leaving it a
              // real listitem put a non-option child inside the listbox and
              // stripped the li of its own list semantics — three axe
              // violations that never surfaced because axe only ever ran on the
              // resting screen, with this popover closed.
              <li key={member.id} role="presentation">
                <button
                  role="option"
                  aria-selected={index === highlighted}
                  className={`nx-mention ${index === highlighted ? 'is-active' : ''}`}
                  onMouseEnter={() => setHighlighted(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    insertMention(member);
                  }}
                >
                  <Chip name={member.handle} accent={memberAccent(member)} size={24} />
                  <span className="nx-mention-handle">@{member.handle}</span>
                  <span className="nx-mention-kind">{member.kind}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={areaRef}
          className="nx-composer-input"
          data-testid="composer-input"
          placeholder={connected ? `Message ${room?.name ?? props.room}…` : 'Reconnecting…'}
          aria-label="Message"
          rows={1}
          value={draft}
          onBeforeInput={() => { seededRef.current = true; }}
          onChange={(event) => {
            // The operator touched the draft: late hydration must never
            // re-seed over what they typed or deliberately cleared.
            seededRef.current = true;
            setDraft(event.target.value);
            setHint(undefined);
            requestAnimationFrame(refreshMention);
          }}
          onClick={refreshMention}
          onKeyDown={(event) => {
            // harn:assume composer-enter-uses-live-draft-state ref=composer-live-mention-keydown
            // On a phone keyboard, Enter is the newline key. Nothing here may
            // consume it: not sending, and not selecting a mention — a caret
            // sitting after "@ri" must still be able to start a new line.
            // Sending is the explicit button, which is also the only control
            // that can be aimed at reliably with a thumb.
            if (isMobile && event.key === 'Enter') return;
            // Input updates schedule the popover refresh on the next animation
            // frame. Enter can land first (notably just after a warm computer
            // switch), so React's `mention`/`mentionables` state may describe an
            // earlier draft. Re-read the action edge before deciding whether
            // Enter selects a name or submits the completed message.
            const liveQualified = qualifiedMentionQuery(
              event.currentTarget.value,
              event.currentTarget.selectionStart ?? event.currentTarget.value.length,
            );
            const liveQualifiedMentionables = liveQualified === undefined || routingCatalog === undefined
              ? []
              : qualifiedCompletionCandidates(routingCatalog, liveQualified);
            const sendIntent = event.key === 'Enter'
              && !event.shiftKey
              && !event.nativeEvent.isComposing;
            if (liveQualified && liveQualifiedMentionables.length > 0) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setHighlighted((prior) => {
                  const delta = event.key === 'ArrowDown' ? 1 : -1;
                  return (prior + delta + liveQualifiedMentionables.length) % liveQualifiedMentionables.length;
                });
                return;
              }
              if ((event.key === 'Enter' && !(sendIntent && exactQualifiedMention(
                liveQualified,
                liveQualifiedMentionables,
              ))) || event.key === 'Tab') {
                event.preventDefault();
                insertQualifiedMention(
                  liveQualifiedMentionables[highlighted] ?? liveQualifiedMentionables[0]!,
                  liveQualified,
                );
                return;
              }
              if (event.key === 'Escape') {
                setQualifiedMention(undefined);
                return;
              }
            }
            const liveMention = mentionQuery(
              event.currentTarget.value,
              event.currentTarget.selectionStart ?? event.currentTarget.value.length,
            );
            const liveMentionables = liveMention === undefined
              ? []
              : roster
                .filter((member) => member.handle.toLowerCase().startsWith(liveMention.query.toLowerCase()))
                .slice(0, 6);
            if (liveMention && liveMentionables.length > 0) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setHighlighted((prior) => {
                  const delta = event.key === 'ArrowDown' ? 1 : -1;
                  return (prior + delta + liveMentionables.length) % liveMentionables.length;
                });
                return;
              }
              if ((event.key === 'Enter' && !(sendIntent && exactLocalMention(
                liveMention,
                liveMentionables,
              ))) || event.key === 'Tab') {
                event.preventDefault();
                const member = liveMentionables[highlighted] ?? liveMentionables[0]!;
                const value = event.currentTarget.value;
                const caret = event.currentTarget.selectionStart ?? value.length;
                const next = `${value.slice(0, liveMention.start)}@${member.handle} ${value.slice(caret)}`;
                seededRef.current = true;
                setDraft(next);
                setMention(undefined);
                pendingCaretRef.current = liveMention.start + member.handle.length + 2;
                return;
              }
              if (event.key === 'Escape') {
                setMention(undefined);
                return;
              }
            }
            if (sendIntent) {
              event.preventDefault();
              send();
            }
            // harn:end composer-enter-uses-live-draft-state
          }}
          onBlur={() => setMention(undefined)}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length > 0) {
              event.preventDefault();
              addFiles(files);
            }
          }}
        />
        {isMobile ? (
          <div className="nx-composer-row2">
            <IconButton
              icon={Paperclip}
              label="Attach files"
              variant="quiet"
              data-testid="composer-attach"
              onClick={() => fileRef.current?.click()}
            />
            <IconButton
              icon={AtSign}
              label="Mention someone"
              variant="quiet"
              data-testid="composer-at"
              onClick={() => {
                const node = areaRef.current;
                if (!node) return;
                seededRef.current = true;
                const caret = node.selectionStart ?? draft.length;
                const lead = caret === 0 || /\s/.test(draft[caret - 1] ?? '') ? '' : ' ';
                setDraft(`${draft.slice(0, caret)}${lead}@${draft.slice(caret)}`);
                pendingCaretRef.current = caret + lead.length + 1;
              }}
            />
            {micButton}
            <span className="nx-composer-spacer" />
            {/* The same primitive desktop sends with, so the two surfaces cannot
                drift in theme or shape; the mobile class only widens the hit
                target for a thumb. */}
            <IconButton
              icon={ArrowUp}
              label="Send message"
              variant="solid"
              className="nx-composer-send"
              data-testid="composer-send"
              disabled={!canSend}
              onClick={send}
            />
          </div>
        ) : (
          // harn:assume desktop-composer-groups-attach-and-send-bottom-right ref=composer-actions-group
          // Attach and Send are one bottom-right action group sharing a centre
          // line, not two controls floating to the growing bar's optical middle.
          <div className="nx-composer-actions" data-testid="composer-actions">
            {micButton}
            <IconButton
              icon={Paperclip}
              label="Attach files"
              variant="quiet"
              className="nx-composer-attach"
              data-testid="composer-attach"
              onClick={() => fileRef.current?.click()}
            />
            <IconButton
              icon={ArrowUp}
              label="Send message"
              variant="solid"
              className="nx-composer-send"
              data-testid="composer-send"
              disabled={!canSend}
              onClick={send}
            />
          </div>
          // harn:end desktop-composer-groups-attach-and-send-bottom-right
        )}
      </div>
      )}
    </footer>
  );
}
