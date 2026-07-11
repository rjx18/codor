import {
  parseRunItemPayload,
  type RunItemDiff,
  type RunItemType,
  type WireEvent,
} from '@wireroom/protocol';

export type RunRowIcon =
  | 'terminal'
  | 'edit'
  | 'search'
  | 'web'
  | 'commit'
  | 'reasoning'
  | 'text'
  | 'tool'
  | 'generic';

export type RunRowStatus = 'running' | 'ok' | 'error' | 'info';

export interface IndexedRunEvent {
  index: number;
  event: WireEvent;
}

export interface RunRow {
  id: string;
  eventIndex: number;
  resultEventIndex?: number;
  kind: 'tool' | 'prose';
  icon: RunRowIcon;
  title: string;
  detail?: string;
  text?: string;
  status: RunRowStatus;
  duration_ms?: number;
  diff?: RunItemDiff;
  image?: { media_type: string; data_b64: string };
  event: WireEvent;
}

const ITEM_LABELS: Record<RunItemType, string> = {
  tool_call: 'Tool call',
  tool_result: 'Tool result',
  reasoning_summary: 'Reasoning',
  text_delta: 'Response',
  commit: 'Commit',
  file_change: 'File change',
};

const boundedDetail = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  if (rendered === undefined || rendered === '') return undefined;
  return rendered.length > 220 ? `${rendered.slice(0, 217)}...` : rendered;
};

const toolIcon = (tool: string): RunRowIcon => {
  const normalized = tool.toLowerCase();
  if (/bash|shell|terminal|command|exec/.test(normalized)) return 'terminal';
  if (/edit|write|patch|notebook/.test(normalized)) return 'edit';
  if (/grep|glob|search|find|read/.test(normalized)) return 'search';
  if (/web|browser|fetch|http/.test(normalized)) return 'web';
  return 'tool';
};

const diffSummary = (diff: RunItemDiff | undefined): string | undefined => {
  if (!diff) return undefined;
  let added = 0;
  let removed = 0;
  for (const line of diff.unified.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return `+${String(added)} -${String(removed)}`;
};

const fallbackRow = (item: IndexedRunEvent): RunRow => {
  const event = item.event;
  const itemType = event.type === 'run.item' ? event.item_type : undefined;
  return {
    id: `event-${String(item.index)}`,
    eventIndex: item.index,
    kind: 'tool',
    icon: 'generic',
    title: itemType ? ITEM_LABELS[itemType] : 'Run event',
    detail: event.type === 'run.item' ? boundedDetail(event.payload) : undefined,
    status: 'info',
    event,
  };
};

// harn:assume normalized-run-items-presented-live ref=normalized-run-presenter
export function presentRunEvents(items: readonly IndexedRunEvent[]): RunRow[] {
  const rows: RunRow[] = [];
  const calls = new Map<string, number>();

  for (const item of items) {
    const event = item.event;
    if (event.type !== 'run.item') continue;

    if (event.item_type === 'tool_call') {
      const parsed = parseRunItemPayload('tool_call', event.payload);
      if (!parsed.success) {
        rows.push(fallbackRow(item));
        continue;
      }
      calls.set(parsed.data.call_id, rows.length);
      rows.push({
        id: `call-${parsed.data.call_id}`,
        eventIndex: item.index,
        kind: 'tool',
        icon: toolIcon(parsed.data.tool),
        title: parsed.data.tool,
        detail: parsed.data.title,
        status: 'running',
        event,
      });
      continue;
    }

    if (event.item_type === 'tool_result') {
      const parsed = parseRunItemPayload('tool_result', event.payload);
      if (!parsed.success) {
        rows.push(fallbackRow(item));
        continue;
      }
      const rowIndex = calls.get(parsed.data.call_id);
      if (rowIndex === undefined) {
        rows.push({
          ...fallbackRow(item),
          status: parsed.data.status,
          duration_ms: parsed.data.duration_ms,
          diff: parsed.data.diff,
          image: parsed.data.image,
        });
        continue;
      }
      const row = rows[rowIndex]!;
      rows[rowIndex] = {
        ...row,
        resultEventIndex: item.index,
        status: parsed.data.status,
        duration_ms: parsed.data.duration_ms,
        diff: parsed.data.diff,
        image: parsed.data.image,
        detail: [row.detail, diffSummary(parsed.data.diff)].filter(Boolean).join(' · '),
        event,
      };
      continue;
    }

    if (event.item_type === 'text_delta') {
      const parsed = parseRunItemPayload('text_delta', event.payload);
      if (!parsed.success) {
        rows.push(fallbackRow(item));
        continue;
      }
      const previous = rows.at(-1);
      if (previous?.kind === 'prose' && previous.icon === 'text') {
        previous.text = `${previous.text ?? ''}${parsed.data.text}`;
        previous.event = event;
      } else {
        rows.push({
          id: `text-${String(item.index)}`,
          eventIndex: item.index,
          kind: 'prose',
          icon: 'text',
          title: 'Response',
          text: parsed.data.text,
          status: 'info',
          event,
        });
      }
      continue;
    }

    if (event.item_type === 'reasoning_summary') {
      const parsed = parseRunItemPayload('reasoning_summary', event.payload);
      if (!parsed.success) {
        rows.push(fallbackRow(item));
        continue;
      }
      rows.push({
        id: `reasoning-${String(item.index)}`,
        eventIndex: item.index,
        kind: 'prose',
        icon: 'reasoning',
        title: 'Reasoning',
        text: parsed.data.text,
        status: 'info',
        event,
      });
      continue;
    }

    if (event.item_type === 'file_change') {
      const parsed = parseRunItemPayload('file_change', event.payload);
      if (!parsed.success) {
        rows.push(fallbackRow(item));
        continue;
      }
      const title = parsed.data.change === 'created'
        ? 'Write'
        : parsed.data.change === 'deleted'
          ? 'Delete'
          : 'Edit';
      rows.push({
        id: `file-${String(item.index)}`,
        eventIndex: item.index,
        kind: 'tool',
        icon: 'edit',
        title,
        detail: [parsed.data.path, diffSummary(parsed.data.diff)].filter(Boolean).join(' · '),
        status: 'ok',
        diff: parsed.data.diff,
        event,
      });
      continue;
    }

    const parsed = parseRunItemPayload('commit', event.payload);
    if (!parsed.success) {
      rows.push(fallbackRow(item));
      continue;
    }
    rows.push({
      id: `commit-${String(item.index)}`,
      eventIndex: item.index,
      kind: 'tool',
      icon: 'commit',
      title: 'Commit',
      detail: parsed.data.message ?? parsed.data.sha ?? 'Recorded',
      status: 'ok',
      event,
    });
  }

  return rows;
}
// harn:end normalized-run-items-presented-live

export function mergeRunEvents(
  journal: readonly WireEvent[] | undefined,
  live: { events: readonly WireEvent[]; dropped_count: number },
): IndexedRunEvent[] {
  const merged = new Map<number, WireEvent>();
  journal?.forEach((event, index) => merged.set(index, event));
  live.events.forEach((event, index) => merged.set(live.dropped_count + index, event));
  return [...merged.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, event]) => ({ index, event }));
}

export function formatRunDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${String(minutes)}m${String(remainder).padStart(2, '0')}s` : `${String(remainder)}s`;
}
