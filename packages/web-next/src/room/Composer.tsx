import type { Member } from '@codor/protocol';
import { ArrowUp, AtSign, Paperclip, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { Connection } from '@runtime/ws.js';

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

  const defaultRecipient = useMemo(
    () => effectiveDefaultRecipient(slice),
    [slice],
  );

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

  const canSend = connected && hydrated && !uploading && (draft.trim().length > 0 || pending.length > 0);

  // Attach files: enforce the caps with plain messaging, then upload each so the
  // post frame can reference server ids. Chips show what will ride the message.
  const addFiles = (files: File[]): void => {
    if (files.length === 0) return;
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
    node.style.height = 'auto';
    const style = getComputedStyle(node);
    const line = parseFloat(style.lineHeight) || 24;
    // The cap is a HEIGHT, and height here includes the box's own vertical
    // padding. Capping at `line * 8` alone left the eighth row clipped by
    // exactly that padding — eight rows of text never fit in an "eight row" box.
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const cap = Math.round(line * MAX_ROWS + (Number.isFinite(padding) ? padding : 0));
    node.style.height = `${Math.min(node.scrollHeight, cap)}px`;
  };

  const refreshMention = (): void => {
    const node = areaRef.current;
    if (!node) return;
    setMention(mentionQuery(node.value, node.selectionStart ?? node.value.length));
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

  const send = (): void => {
    // Enter can follow an input event before React has committed the matching
    // state render under load. Read the controlled element at the action edge
    // so an overwritten seeded @mention can never be submitted from a stale
    // closure.
    const body = (areaRef.current?.value ?? draft).trim();
    if (!connected || !hydrated || uploading || (body.length === 0 && pending.length === 0)) return;
    const addressed = roster.some((m) => new RegExp(`@${m.handle}\\b`, 'i').test(body));
    if (!addressed && roster.some((m) => m.kind === 'agent')) {
      setHint(
        defaultRecipient
          ? `Say who this is for — try @${defaultRecipient.handle}`
          : 'Say who this is for — mention someone with @',
      );
      return;
    }
    props.connection.post(body, {
      ...(replyTo !== undefined && { replyTo }),
      ...(pending.length > 0 && { attachments: pending.map((attachment) => attachment.id) }),
    });
    setDraft('');
    setReplyTo(undefined);
    setPending([]);
    setHint(undefined);
    seededRef.current = false; // the next draft re-seeds its recipient
    setMention(undefined);
    requestAnimationFrame(autoGrow);
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
      <div className="nx-composer-bar">
        {mention && mentionables.length > 0 && (
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
            autoGrow();
            requestAnimationFrame(refreshMention);
          }}
          onClick={refreshMention}
          onKeyDown={(event) => {
            // On a phone keyboard, Enter is the newline key. Nothing here may
            // consume it: not sending, and not selecting a mention — a caret
            // sitting after "@ri" must still be able to start a new line.
            // Sending is the explicit button, which is also the only control
            // that can be aimed at reliably with a thumb.
            if (isMobile && event.key === 'Enter') return;
            if (mention && mentionables.length > 0) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setHighlighted((prior) => {
                  const delta = event.key === 'ArrowDown' ? 1 : -1;
                  return (prior + delta + mentionables.length) % mentionables.length;
                });
                return;
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                insertMention(mentionables[highlighted] ?? mentionables[0]!);
                return;
              }
              if (event.key === 'Escape') {
                setMention(undefined);
                return;
              }
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
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
          <>
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
          </>
        )}
      </div>
    </footer>
  );
}
