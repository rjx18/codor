import type { Message, RoomInboxItem } from '@codor/protocol';
import { Inbox as InboxIcon, PauseCircle, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { fetchMessageHistory, searchMessages } from '@legacy/api.js';
import type { Connection } from '@legacy/ws.js';

import { HISTORY_PAGE_SIZE, heldDeliveries, roomSlice, useClientStore } from '../app/store.js';
import { clockTime } from '../primitives/identity.js';
import { Button, IconButton, Modal } from '../primitives/primitives.js';

const EMPTY_INBOX_ITEMS: RoomInboxItem[] = [];

/** Scroll a permalink target into view, paging history back (bounded) until the
 *  message is loaded. */
export async function jumpToMessage(room: string, id: number, token: () => string): Promise<void> {
  const store = roomSlice(useClientStore.getState(), room);
  for (let hops = 0; hops < 10; hops++) {
    if (roomSlice(useClientStore.getState(), room).messages[id] !== undefined) break;
    const cursor = roomSlice(useClientStore.getState(), room).historyCursor ?? store.historyCursor;
    if (cursor === undefined || cursor <= 1) break;
    try {
      const page = await fetchMessageHistory(room, { before: cursor, limit: HISTORY_PAGE_SIZE }, { token: token() });
      if (page.messages.length === 0) break;
      useClientStore.getState().mergeHistoryPage(room, page.messages);
    } catch {
      break;
    }
  }
  window.location.hash = `#${id}`;
  document.getElementById(String(id))?.scrollIntoView({ block: 'center' });
}

// ── Hold banner: parked deliveries wait above the transcript ──────────────

export function HoldBanner(props: { room: string; connection: Connection }) {
  const inbox = useClientStore((state) => roomSlice(state, props.room).inbox);
  const members = useClientStore((state) => roomSlice(state, props.room).members);
  const messages = useClientStore((state) => roomSlice(state, props.room).messages);
  const held = useMemo(() => heldDeliveries(inbox), [inbox]);
  if (held.length === 0) return null;

  return (
    <div className="nx-holds" data-testid="hold-banner">
      {held.map((delivery) => {
        const recipient = members[delivery.recipient];
        const message = messages[delivery.message_id];
        return (
          <div key={delivery.id} className="nx-hold">
            <PauseCircle size={16} aria-hidden="true" />
            <span className="nx-hold-text">
              Held for <strong>@{recipient?.handle ?? '…'}</strong>
              {message !== undefined ? ` — “${(message.body.split('\n', 1)[0] ?? '').slice(0, 80)}”` : ''}
            </span>
            <span className="nx-hold-actions">
              <Button
                variant="secondary"
                data-testid={`hold-${delivery.id}-release`}
                onClick={() => props.connection.act({ act: 'release_hold', delivery_id: delivery.id })}
              >
                Release
              </Button>
              <Button
                variant="quiet"
                data-testid={`hold-${delivery.id}-redeliver`}
                onClick={() => props.connection.act({ act: 'redeliver', delivery_id: delivery.id })}
              >
                Redeliver
              </Button>
            </span>
          </div>
        );
      })}
    </div>
  );
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
