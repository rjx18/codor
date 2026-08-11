import type { Message, RoomInboxItem } from '@codor/protocol';
import { Inbox as InboxIcon, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { searchMessages } from '@runtime/api.js';
import type { Connection } from '@runtime/ws.js';

import { roomSlice, useClientStore } from '../app/store.js';
import { clockTime } from '../primitives/identity.js';
import { IconButton, Modal } from '../primitives/primitives.js';
import { revealTranscriptTarget } from './transcript-history.js';

const EMPTY_INBOX_ITEMS: RoomInboxItem[] = [];
export const JUMP_ANCHOR_EVENT = 'nx-jump-anchor';

/** Scroll a permalink target into view, paging history back (bounded) until the
 *  message is loaded. */
export async function jumpToMessage(room: string, id: number, token: () => string): Promise<void> {
  await revealTranscriptTarget(useClientStore, room, id, token);
  window.location.hash = `#${id}`;
  // Store merges and React's DOM commit are different steps. Looking up the row
  // in the same microtask intermittently found nothing, leaving a loaded deep
  // link stranded offscreen. Wait a bounded number of paint frames for the
  // committed target, then center it after the hashchange has released tail pinning.
  for (let frame = 0; frame < 30; frame += 1) {
    const target = document.getElementById(String(id));
    if (target !== null) {
      target.scrollIntoView({ block: 'center' });
      window.dispatchEvent(new CustomEvent(JUMP_ANCHOR_EVENT, { detail: { room, id } }));
      break;
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

// ── Inbox: the badge and the panel share one selector ─────────────────────

export function InboxControl(props: { room: string; connection: Connection; token: () => string }) {
  const [open, setOpen] = useState(false);
  const support = useClientStore((state) => roomSlice(state, props.room).support);
  const rows = support?.inbox ?? EMPTY_INBOX_ITEMS;
  const count = rows.length;

  return (
    <span className="nx-inbox-wrap">
      <span className="nx-badge-anchor">
        <IconButton
          icon={InboxIcon}
          label={`Inbox — ${count} unread`}
          data-testid="inbox-toggle"
          onClick={() => setOpen((v) => !v)}
        />
        {count > 0 && <span className="nx-badge" data-testid="inbox-badge">{count > 99 ? '99+' : count}</span>}
      </span>
      {open && (
        <InboxPanel
          rows={rows}
          onClose={() => setOpen(false)}
          onMarkAllRead={() => {
            for (const row of rows) {
              props.connection.act({ act: 'mark_read', delivery_id: row.delivery.id });
            }
            setOpen(false);
          }}
          onOpenRow={(row) => {
            props.connection.act({ act: 'mark_read', delivery_id: row.delivery.id });
            setOpen(false);
            void jumpToMessage(props.room, row.delivery.message_id, props.token);
          }}
        />
      )}
    </span>
  );
}

function InboxPanel(props: {
  rows: RoomInboxItem[];
  onClose: () => void;
  onMarkAllRead: () => void;
  onOpenRow: (row: RoomInboxItem) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (event: PointerEvent): void => {
      if (!panelRef.current?.contains(event.target as Node)) props.onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={panelRef} className="nx-inbox" role="dialog" aria-label="Inbox" data-testid="inbox-panel">
      <header className="nx-inbox-head">
        <strong>Needs you</strong>
        {props.rows.length > 0 && (
          <button className="nx-inbox-clear" data-testid="inbox-mark-all" onClick={props.onMarkAllRead}>
            Mark all read
          </button>
        )}
        <IconButton icon={X} label="Close inbox" size="sm" variant="quiet" onClick={props.onClose} />
      </header>
      {props.rows.length === 0 ? (
        <p className="nx-inbox-empty" data-testid="inbox-empty">Nothing needs you.</p>
      ) : (
        <ul className="nx-inbox-list">
          {props.rows.map((row) => (
            <li key={row.delivery.id}>
              <button
                className="nx-inbox-row"
                data-testid={`inbox-row-${row.delivery.id}`}
                onClick={() => props.onOpenRow(row)}
              >
                <strong>@{row.author_handle}</strong>
                <span className="nx-inbox-preview">{row.preview || row.message_kind}</span>
                <time>{clockTime(row.ts)}</time>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Search overlay: results jump to permalinks ─────────────────────────────

export function SearchOverlay(props: { room: string; token: () => string; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Message[]>();
  const [busy, setBusy] = useState(false);
  const members = useClientStore((state) => roomSlice(state, props.room).members);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults(undefined);
      return;
    }
    setBusy(true);
    const timer = setTimeout(() => {
      void searchMessages(props.room, trimmed, { token: props.token() })
        .then((messages) => setResults(messages))
        .catch(() => setResults([]))
        .finally(() => setBusy(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, props.room, props.token]);

  return (
    <Modal label="Search messages" onClose={props.onClose} testid="search-overlay" initialFocus={inputRef}>
      <div className="nx-search-box">
        <Search size={16} aria-hidden="true" />
        <input
          ref={inputRef}
          data-testid="search-input"
          placeholder="Search this channel…"
          aria-label="Search this channel"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {busy && <p className="nx-search-note">Searching…</p>}
      {results !== undefined && !busy && (
        results.length === 0 ? (
          <p className="nx-search-note" data-testid="search-empty">No matches.</p>
        ) : (
          <ul className="nx-search-results" data-testid="search-results">
            {results.map((message) => (
              <li key={message.id}>
                <button
                  className="nx-search-row"
                  data-testid={`search-hit-${message.id}`}
                  onClick={() => {
                    props.onClose();
                    void jumpToMessage(props.room, message.id, props.token);
                  }}
                >
                  <strong>@{members[message.author]?.handle ?? '…'}</strong>
                  <span className="nx-search-body">{(message.body.split('\n', 1)[0] ?? '').slice(0, 110)}</span>
                  <span className="nx-search-meta">#{message.id} · {clockTime(message.ts)}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      )}
    </Modal>
  );
}
