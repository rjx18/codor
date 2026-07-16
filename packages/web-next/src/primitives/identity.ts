import type { Member } from '@codor/protocol';

/** The spec's identity tints: agents cycle indigo/green/violet by handle so each agent
 *  keeps one colour everywhere; humans get the inverse deep-green "user" chip. */
export type AccentName = 'indigo' | 'green' | 'violet' | 'user';

const AGENT_ORDER: AccentName[] = ['indigo', 'green', 'violet'];

export function memberAccent(member: Pick<Member, 'kind' | 'handle'>): AccentName {
  if (member.kind === 'human') return 'user';
  let hash = 0;
  for (const ch of member.handle) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AGENT_ORDER[hash % AGENT_ORDER.length] ?? 'indigo';
}

/** Two-letter initials for the squircle chip: '@code-reviewer' -> 'cr', 'Richard' -> 'Ri'. */
export function initials(nameOrHandle: string): string {
  const clean = nameOrHandle.replace(/^@/, '');
  const parts = clean.split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`;
  return clean.slice(0, 2);
}

export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 45) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d}d`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function clockTime(iso: string): string {
  const then = new Date(iso);
  return Number.isNaN(then.getTime())
    ? ''
    : then.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

const COMPACT = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

export function compactCount(value: number): string {
  return COMPACT.format(value);
}

export function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}
