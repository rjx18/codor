import {
  Cat,
  Coffee,
  Cpu,
  Ghost,
  Gamepad2,
  HardDrive,
  Leaf,
  Laptop,
  Monitor,
  Orbit,
  Package,
  Router,
  Server,
  Smartphone,
  Star,
  Tablet,
  Terminal,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { CSSProperties, KeyboardEventHandler, MouseEventHandler, PointerEventHandler, ReactNode } from 'react';

import type { ComputerSessionView } from '../app/computer-sessions.js';

export type ComputerStatusTone = 'connected' | 'reconnecting' | 'repair';

export interface ComputerStatus {
  label: 'Connected' | 'Reconnecting' | 'Repair required';
  tone: ComputerStatusTone;
}

export interface ComputerAppearance {
  glyph: string;
  color: string;
}

/** Small, intentionally finite choices so appearance metadata is harmless to persist. */
export const COMPUTER_GLYPHS = [
  'monitor', 'laptop', 'cpu', 'terminal', 'server', 'router', 'smartphone',
  'tablet', 'gamepad', 'hard-drive', 'cat', 'ghost', 'coffee', 'leaf', 'star',
  'orbit', 'package', 'zap',
] as const;

export const COMPUTER_COLORS = [
  '#3730a3', '#0f766e', '#166534', '#92400e', '#9f1239', '#6b21a8', '#075985',
  '#155e75', '#047857', '#854d0e', '#9a3412', '#9d174d', '#7e22ce', '#1d4ed8',
  '#334155', '#0f172a',
] as const;

export type ComputerGlyph = typeof COMPUTER_GLYPHS[number];

export const COMPUTER_GLYPH_ICONS: Record<ComputerGlyph, LucideIcon> = {
  monitor: Monitor,
  laptop: Laptop,
  cpu: Cpu,
  terminal: Terminal,
  server: Server,
  router: Router,
  smartphone: Smartphone,
  tablet: Tablet,
  gamepad: Gamepad2,
  'hard-drive': HardDrive,
  cat: Cat,
  ghost: Ghost,
  coffee: Coffee,
  leaf: Leaf,
  star: Star,
  orbit: Orbit,
  package: Package,
  zap: Zap,
};

export const COMPUTER_GLYPH_LABELS: Record<ComputerGlyph, string> = {
  monitor: 'Monitor',
  laptop: 'Laptop',
  cpu: 'Processor',
  terminal: 'Terminal',
  server: 'Server',
  router: 'Router',
  smartphone: 'Phone',
  tablet: 'Tablet',
  gamepad: 'Gamepad',
  'hard-drive': 'Hard drive',
  cat: 'Cat',
  ghost: 'Ghost',
  coffee: 'Coffee',
  leaf: 'Leaf',
  star: 'Star',
  orbit: 'Orbit',
  package: 'Package',
  zap: 'Lightning',
};

const APPEARANCE_STORAGE_KEY = 'codor.computer-appearance.v1';

function isComputerGlyph(value: unknown): value is ComputerGlyph {
  return typeof value === 'string' && (COMPUTER_GLYPHS as readonly string[]).includes(value);
}

function isComputerColor(value: unknown): value is ComputerAppearance['color'] {
  return typeof value === 'string' && (COMPUTER_COLORS as readonly string[]).includes(value);
}

function isStoredAppearance(value: unknown): value is ComputerAppearance {
  return typeof value === 'object' && value !== null
    && typeof (value as ComputerAppearance).glyph === 'string'
    && typeof (value as ComputerAppearance).color === 'string';
}

export function readComputerAppearances(): Record<string, ComputerAppearance> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => isStoredAppearance(value))) as Record<string, ComputerAppearance>;
  } catch {
    return {};
  }
}

export function writeComputerAppearances(appearances: Record<string, ComputerAppearance>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(appearances));
  } catch {
    // Private browsing/storage quota failures must never affect pairing or switching.
  }
}

// harn:assume computer-appearance-is-purged-on-forget ref=appearance-forget-cleanup
export function removeComputerAppearance(id: string): void {
  const current = readComputerAppearances();
  if (!(id in current)) return;
  const next = { ...current };
  delete next[id];
  writeComputerAppearances(next);
}
// harn:end computer-appearance-is-purged-on-forget

export function defaultComputerAppearance(id: string): ComputerAppearance {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return {
    glyph: COMPUTER_GLYPHS[hash % COMPUTER_GLYPHS.length]!,
    color: COMPUTER_COLORS[hash % COMPUTER_COLORS.length]!,
  };
}

export function computerAppearance(
  id: string,
  appearances: Record<string, ComputerAppearance>,
): ComputerAppearance {
  const fallback = defaultComputerAppearance(id);
  const saved = appearances[id];
  return {
    // harn:assume hosted-computer-avatar-uses-monochrome-icon-palette ref=legacy-emoji-appearance-fallback
    glyph: normalizedGlyph(saved?.glyph, id),
    color: isComputerColor(saved?.color) ? saved.color : fallback.color,
    // harn:end legacy-emoji-appearance-fallback
  };
}

function normalizedGlyph(value: string | undefined, id: string): ComputerGlyph {
  return isComputerGlyph(value) ? value : defaultComputerAppearance(id).glyph as ComputerGlyph;
}

/** The only status mapping used by the switcher and recovery escape hatch. */
export function computerStatus(computer: ComputerSessionView): ComputerStatus {
  if (computer.authRefused) return { label: 'Repair required', tone: 'repair' };
  if (computer.connected) return { label: 'Connected', tone: 'connected' };
  return { label: 'Reconnecting', tone: 'reconnecting' };
}

function attentionCount(computer: ComputerSessionView): number {
  return computer.attentionCount ?? (computer.attention ? 1 : 0);
}

/** Counts actionable units, deliberately excluding the active computer. */
export function computerActionableCount(computers: ComputerSessionView[]): number {
  return computers
    .filter((computer) => !computer.active)
    .reduce((total, computer) => total + computer.unread + attentionCount(computer) + computer.working, 0);
}

function activity(computer: ComputerSessionView): string[] {
  const attention = attentionCount(computer);
  return [
    computer.unread > 0 ? `${computer.unread} unread` : undefined,
    attention > 0 ? (attention === 1 ? 'Needs attention' : `${attention} need attention`) : undefined,
    computer.working > 0 ? `${computer.working} working` : undefined,
  ].filter((value): value is string => value !== undefined);
}

function statusName(computer: ComputerSessionView, status: ComputerStatus, details: string[]): string {
  return [
    computer.label,
    computer.active ? 'Active' : undefined,
    status.label,
    ...details,
  ].filter((value): value is string => value !== undefined).join(', ');
}

function AvatarBadge({
  kind,
  count,
  computer,
}: {
  kind: 'unread' | 'working' | 'attention';
  count: number;
  computer: ComputerSessionView;
}): ReactNode {
  if (count <= 0) return null;
  const label = kind === 'unread'
    ? `${count} unread message${count === 1 ? '' : 's'}`
    : kind === 'working'
      ? `${count} working channel${count === 1 ? '' : 's'}`
      : `${count} attention channel${count === 1 ? '' : 's'}`;
  return (
    <span
      className={`nx-computer-avatar-badge is-${kind}`}
      data-testid={`computer-avatar-${kind}-${computer.id}`}
      aria-label={label}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

export interface ComputerChoiceProps {
  computer: ComputerSessionView;
  onSelect: () => void;
  disabled?: boolean;
  testid?: string;
  onDoubleClick?: () => void;
  children?: ReactNode;
  variant?: 'choice' | 'avatar';
  appearance?: ComputerAppearance;
  onContextMenu?: MouseEventHandler<HTMLButtonElement>;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
  onPointerUp?: PointerEventHandler<HTMLButtonElement>;
  onPointerCancel?: PointerEventHandler<HTMLButtonElement>;
  onPointerLeave?: PointerEventHandler<HTMLButtonElement>;
}

/**
 * Shared computer presentation. Recovery keeps the readable full-width choice;
 * the hosted rail opts into the compact avatar variant without duplicating the
 * status/activity semantics.
 */
export function ComputerChoice({
  computer,
  onSelect,
  disabled = false,
  testid,
  onDoubleClick,
  children,
  variant = 'choice',
  appearance,
  onContextMenu,
  onKeyDown,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
}: ComputerChoiceProps): ReactNode {
  const status = computerStatus(computer);
  const details = activity(computer);
  const accessibleName = statusName(computer, status, details);
  const attention = attentionCount(computer);

  if (variant === 'avatar') {
    // harn:assume hosted-computer-avatar-badges-are-actionable ref=avatar-badge-presentation
    // harn:assume hosted-computer-avatar-uses-monochrome-icon-palette ref=computer-avatar-icon-palette
    // harn:assume hosted-computer-hostname-tooltip-is-focus-visible ref=hostname-tooltip-presentation
    // harn:assume hosted-avatar-activity-badges-form-bottom-cluster ref=bottom-activity-cluster-presentation
    const avatarStyle = {
      '--nx-computer-avatar-color': isComputerColor(appearance?.color)
        ? appearance.color
        : defaultComputerAppearance(computer.id).color,
    } as CSSProperties;
    const hasBottomActivity = computer.working > 0 || attention > 0;
    const glyph = normalizedGlyph(appearance?.glyph, computer.id);
    const Glyph = COMPUTER_GLYPH_ICONS[glyph];
    return (
      <button
        type="button"
        className={`nx-computer-avatar${computer.active ? ' is-active' : ''} is-${status.tone}`}
        style={avatarStyle}
        data-testid={testid}
        data-computer-avatar="true"
        data-computer-choice="true"
        aria-label={accessibleName}
        title={computer.label}
        aria-current={computer.active ? 'true' : undefined}
        disabled={disabled}
        onClick={onSelect}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerLeave}
      >
        <span className="nx-computer-avatar-glyph" aria-hidden="true">
          <Glyph size={20} strokeWidth={1.8} />
        </span>
        <AvatarBadge kind="unread" count={computer.unread} computer={computer} />
        {hasBottomActivity ? (
          <span
            className="nx-computer-avatar-activity-badges"
            data-testid={`computer-avatar-activity-${computer.id}`}
          >
            <AvatarBadge kind="working" count={computer.working} computer={computer} />
            <AvatarBadge kind="attention" count={attention} computer={computer} />
          </span>
        ) : null}
        <span className="nx-computer-avatar-tooltip" role="tooltip">{computer.label}</span>
      </button>
    );
    // harn:end hosted-avatar-activity-badges-form-bottom-cluster
    // harn:end hosted-computer-hostname-tooltip-is-focus-visible
    // harn:end hosted-computer-avatar-uses-monochrome-icon-palette
    // harn:end hosted-computer-avatar-badges-are-actionable
  }

  return (
    <div className="nx-computer-choice-row">
      <button
        type="button"
        className={`nx-computer-choice is-${status.tone}`}
        data-testid={testid}
        data-computer-choice="true"
        aria-label={accessibleName}
        aria-current={computer.active ? 'true' : undefined}
        disabled={disabled}
        onClick={onSelect}
        onDoubleClick={onDoubleClick}
      >
        <span className="nx-computer-choice-copy">
          <span className="nx-computer-choice-top">
            <span className="nx-computer-choice-label">{computer.label}</span>
            {computer.active ? <span className="nx-computer-choice-active">Active</span> : null}
          </span>
          <span className={`nx-computer-choice-status is-${status.tone}`} data-testid={`computer-connection-${computer.id}`}>
            <span className={`nx-computer-choice-dot is-${status.tone}`} aria-hidden="true" />
            {status.label}
          </span>
          {details.length > 0 ? (
            <span className="nx-computer-choice-activity" aria-label={details.join(', ')}>
              {computer.unread > 0 ? <span data-testid={`computer-unread-${computer.id}`}>{computer.unread} unread</span> : null}
              {attention > 0 ? <span data-testid={`computer-attention-${computer.id}`}>{attention === 1 ? 'Needs attention' : `${attention} need attention`}</span> : null}
              {computer.working > 0 ? <span data-testid={`computer-working-${computer.id}`}>{computer.working} working</span> : null}
            </span>
          ) : null}
        </span>
      </button>
      {children ? <span className="nx-computer-choice-actions">{children}</span> : null}
    </div>
  );
}
