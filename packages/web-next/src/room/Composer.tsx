import { ArrowUp } from 'lucide-react';
import { useRef, useState } from 'react';

import { useRoomStore } from '@legacy/state.js';
import type { Connection } from '@legacy/ws.js';

import { IconButton } from '../primitives/primitives.js';

const MAX_ROWS = 8;

/** Docked composer bar: auto-grow textarea (bounded), Enter sends, Shift+Enter breaks,
 *  send disabled while empty or disconnected. Mention popover and addressing rules
 *  arrive with the interactions phase. */
export function Composer(props: { room: string; connection: Connection }) {
  const connected = useRoomStore((s) => s.connected);
  const [draft, setDraft] = useState('');
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const canSend = connected && draft.trim().length > 0;

  const autoGrow = (): void => {
    const node = areaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    const line = parseFloat(getComputedStyle(node).lineHeight) || 24;
    node.style.height = `${Math.min(node.scrollHeight, Math.round(line * MAX_ROWS))}px`;
  };

  const send = (): void => {
    const body = draft.trim();
    if (!canSend || body.length === 0) return;
    props.connection.post(body);
    setDraft('');
    requestAnimationFrame(autoGrow);
  };

  return (
    <footer className="nx-composer">
      <div className="nx-composer-bar">
        <textarea
          ref={areaRef}
          className="nx-composer-input"
          data-testid="composer-input"
          placeholder={connected ? `Message ${props.room}…` : 'Reconnecting…'}
          aria-label="Message"
          rows={1}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            autoGrow();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
        />
        <IconButton
          icon={ArrowUp}
          label="Send message"
          variant="solid"
          data-testid="composer-send"
          disabled={!canSend}
          onClick={send}
        />
      </div>
    </footer>
  );
}
