// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { Connection } from '@runtime/ws.js';
import { useComposerMemory } from './composer-memory.js';

describe('composition ownership across connector handover', () => {
  it('preserves edited-empty body, reply, uploaded media and pending state under the same session only', async () => {
    const a = {}; const b = {};
    const connection = (compositionOwner: object): Connection => ({ compositionOwner, post: () => false,
      act() {}, disconnect() {}, reconnect() {} });
    const initial = { body: '', edited: false, reply: undefined as number | undefined,
      attachments: [] as string[], voice: undefined as { duration_seconds: number; levels: number[] } | undefined,
      pending: undefined as string | undefined };
    let observed = initial;
    let change!: (state: typeof initial) => void;
    function Probe(props: { owner: Connection; room: string }) {
      const [value, set] = useComposerMemory(props.owner, props.room, 'composition', initial);
      observed = value; change = set;
      return <span>{value.body}</span>;
    }
    const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
    try {
      await act(async () => root.render(<Probe owner={connection(a)} room="eng" />));
      const edited = { body: '', edited: true, reply: 42, attachments: ['existing-upload'],
        voice: { duration_seconds: 1, levels: [2, 4] }, pending: 'same-intent' };
      await act(async () => change(edited));
      await act(async () => root.render(<Probe owner={connection(a)} room="eng" />));
      expect(observed).toBe(edited);
      await act(async () => root.render(<Probe owner={connection(b)} room="eng" />)); expect(observed).toBe(initial);
      await act(async () => root.render(<Probe owner={connection(a)} room="other" />)); expect(observed).toBe(initial);
      await act(async () => root.render(<Probe owner={connection(a)} room="eng" />)); expect(observed).toBe(edited);
      await act(async () => root.render(<Probe owner={connection({})} room="eng" />)); expect(observed).toBe(initial);
    } finally { await act(async () => root.unmount()); node.remove(); }
  });
});
