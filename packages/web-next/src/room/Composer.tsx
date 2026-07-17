import type { Member } from '@codor/protocol';
import { ArrowUp, AtSign } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { effectiveDefaultRecipient, useRoomStore } from '@legacy/state.js';
import type { Connection } from '@legacy/ws.js';

import { useIsMobile } from '../app/session.js';
import { Chip, IconButton } from '../primitives/primitives.js';
import { memberAccent } from '../primitives/identity.js';

const MAX_ROWS = 8;

/** Transcript quote buttons talk to the composer through this event. */
export const QUOTE_EVENT = 'nx-quote';

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
export function Composer(props: { room: string; connection: Connection }) {
  const isMobile = useIsMobile();
  const connected = useRoomStore((s) => s.connected);
  const members = useRoomStore((s) => s.members);
  const room = useRoomStore((s) => s.room);
  const latestFinalizedAgentId = useRoomStore((s) => s.latestFinalizedAgentId);
  const [draft, setDraft] = useState('');
  const [hint, setHint] = useState<string>();
  const [mention, setMention] = useState<{ start: number; query: string }>();
  const [highlighted, setHighlighted] = useState(0);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const seededRef = useRef(false);
  const pendingCaretRef = useRef<number>();

  // Programmatic inserts restore the caret synchronously with the DOM update —
  // an rAF here loses keystrokes racing in from a fast typist.
  useLayoutEffect(() => {
    const caret = pendingCaretRef.current;
    if (caret === undefined) return;
    pendingCaretRef.current = undefined;
    const node = areaRef.current;
    if (!node) return;
    node.setSelectionRange(caret, caret);
    node.focus();
    autoGrow();
    refreshMention();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const roster = useMemo(
    () => Object.values(members).filter((m) => m.removed_ts === undefined),
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
    () => effectiveDefaultRecipient({ room, members, latestFinalizedAgentId }),
    [room, members, latestFinalizedAgentId],
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
      const text = (event as CustomEvent<string>).detail;
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

  const canSend = connected && draft.trim().length > 0;

  const autoGrow = (): void => {
    const node = areaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    const line = parseFloat(getComputedStyle(node).lineHeight) || 24;
    node.style.height = `${Math.min(node.scrollHeight, Math.round(line * MAX_ROWS))}px`;
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
    const body = draft.trim();
    if (!canSend || body.length === 0) return;
    const addressed = roster.some((m) => new RegExp(`@${m.handle}\\b`, 'i').test(body));
    if (!addressed && roster.some((m) => m.kind === 'agent')) {
      setHint(
        defaultRecipient
          ? `Say who this is for — try @${defaultRecipient.handle}`
          : 'Say who this is for — mention someone with @',
      );
      return;
    }
    props.connection.post(body);
    setDraft('');
    setHint(undefined);
    seededRef.current = false; // the next draft re-seeds its recipient
    setMention(undefined);
    requestAnimationFrame(autoGrow);
  };

  return (
    <footer className="nx-composer">
      {hint !== undefined && (
        <p className="nx-composer-hint" role="alert" data-testid="composer-hint">{hint}</p>
      )}
      <div className="nx-composer-bar">
        {mention && mentionables.length > 0 && (
          <ul className="nx-mentions" role="listbox" aria-label="Mention someone" data-testid="mention-popover">
            {mentionables.map((member, index) => (
              <li key={member.id}>
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
        />
        {isMobile ? (
          <div className="nx-composer-row2">
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
            <button
              type="button"
              className="nx-send"
              aria-label="Send message"
              data-testid="composer-send"
              disabled={!canSend}
              onClick={send}
            >
              <ArrowUp size={17} aria-hidden="true" strokeWidth={2} />
            </button>
          </div>
        ) : (
          <IconButton
            icon={ArrowUp}
            label="Send message"
            variant="solid"
            data-testid="composer-send"
            disabled={!canSend}
            onClick={send}
          />
        )}
      </div>
    </footer>
  );
}
