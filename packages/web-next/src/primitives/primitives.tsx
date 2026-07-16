import type { LucideIcon } from 'lucide-react';
import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
  type ReactPortal,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

import { initials, type AccentName } from './identity.js';

/** Squircle identity chip: tinted rounded square with two-letter initials, the uniform
 *  actor mark of the whole system (38 rail / 34 message / 32 roster / 26 mobile). An
 *  optional presence dot anchors bottom-right, 2px-ringed in the parent surface. */
export function Chip(props: {
  name: string;
  accent: AccentName;
  size?: number;
  presence?: 'live' | 'idle' | 'error';
  surface?: 'surface' | 'raised' | 'muted';
  title?: string;
}) {
  const size = props.size ?? 34;
  return (
    <span
      className={`nx-chip is-${props.accent}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.35) }}
      title={props.title}
      aria-hidden="true"
    >
      {initials(props.name)}
      {props.presence && (
        <span className={`nx-presence is-${props.presence} on-${props.surface ?? 'surface'}`} />
      )}
    </span>
  );
}

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  children: ReactNode;
}) {
  const { variant = 'secondary', className, children, ...rest } = props;
  return (
    <button {...rest} className={`nx-btn is-${variant} ${className ?? ''}`}>
      {children}
    </button>
  );
}

export function IconButton(props: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
  size?: 'md' | 'sm';
  variant?: 'outline' | 'quiet' | 'solid';
}) {
  const { icon: Icon, label, size = 'md', variant = 'outline', className, ...rest } = props;
  return (
    <button
      {...rest}
      aria-label={label}
      title={rest.title ?? label}
      className={`nx-iconbtn is-${variant} is-${size} ${className ?? ''}`}
    >
      <Icon aria-hidden="true" size={size === 'sm' ? 15 : 17} strokeWidth={1.75} />
    </button>
  );
}

export function Eyebrow(props: { children: ReactNode; className?: string }) {
  return <span className={`nx-eyebrow ${props.className ?? ''}`}>{props.children}</span>;
}

/** Live pill / status pill: dot + word on a tint. */
export function StatusPill(props: { tone: 'live' | 'warn' | 'error' | 'neutral'; children: ReactNode }) {
  return (
    <span className={`nx-status is-${props.tone}`}>
      <span className="nx-status-dot" aria-hidden="true" />
      {props.children}
    </span>
  );
}

export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: string; testid?: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={props.label} className="nx-segmented">
      {props.options.map((option) => (
        <button
          key={option.value}
          role="tab"
          aria-selected={props.value === option.value}
          data-testid={option.testid}
          className="nx-segment"
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function TypingDots(props: { label?: string }) {
  return (
    <span className="nx-typing" role="img" aria-label={props.label ?? 'typing'}>
      <span /><span /><span />
    </span>
  );
}

/** Every modal renders through one body-level portal so panel stacking contexts can
 *  never trap a dialog under page chrome. Escape closes; focus enters on mount and
 *  returns to the opener on unmount; Tab cycles inside. */
export function Modal(props: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  testid?: string;
  initialFocus?: RefObject<HTMLElement | null>;
  wide?: boolean;
  alert?: boolean;
}): ReactPortal | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusables = (): HTMLElement[] =>
      [...(dialog?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [])];
    (props.initialFocus?.current ?? focusables()[0] ?? dialog)?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const items = focusables();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      opener?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="nx-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div
        ref={dialogRef}
        role={props.alert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-label={props.label}
        data-testid={props.testid}
        tabIndex={-1}
        className={`nx-modal ${props.wide ? 'is-wide' : ''}`}
      >
        {props.children}
      </div>
    </div>,
    document.body,
  );
}

/** Mono inline code chip. */
export function Code(props: { children: ReactNode }) {
  return <code className="nx-code">{props.children}</code>;
}
