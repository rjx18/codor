// harn:assume web-v5-primitives-consume-only-tokens ref=v5-primitive-components
// The v5 primitive library. Presentation flows entirely through the anchored classes in
// primitives.css - no inline style prop, no palette utility, no hand-authored svg. Icons
// are Lucide components at allowlisted sizes with currentColor paint. No live surface
// imports this yet; the room phase adopts it.
import type { LucideIcon } from 'lucide-react';
import {
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

import './primitives.css';

// A caller may forward any native attribute a room surface needs - data-testid, aria-*,
// name, title, disabled - but never `style` (presentation flows through the anchored
// class) nor `className` (the primitive controls it). Stripping them at the type level and
// again at runtime means a caller cannot smuggle in an inline style or override the class.
type NativeButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style' | 'className'>;
type NativeInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'style' | 'className' | 'id' | 'value' | 'onChange'
>;

function stripControlled<T extends Record<string, unknown>>(props: T): T {
  const { style: _style, className: _className, ...safe } = props as Record<string, unknown>;
  return safe as T;
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'revive' | 'remove';

export function Button({
  variant,
  type,
  children,
  ...rest
}: NativeButtonProps & { variant: ButtonVariant; children: ReactNode }): JSX.Element {
  return (
    <button {...stripControlled(rest)} type={type ?? 'button'} className={`cd-button cd-button-${variant}`}>
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  type,
  ...rest
}: NativeButtonProps & { icon: LucideIcon; label: string }): JSX.Element {
  const Icon = icon;
  return (
    <button
      {...stripControlled(rest)}
      type={type ?? 'button'}
      aria-label={label}
      className="cd-button cd-button-icon"
    >
      <Icon aria-hidden size={17} />
    </button>
  );
}

export function Input({
  label,
  onChange,
  value,
  ...rest
}: NativeInputProps & {
  label: string;
  value?: string;
  onChange?: (value: string) => void;
}): JSX.Element {
  const id = useId();
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        {...stripControlled(rest)}
        id={id}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        className="cd-input"
      />
    </>
  );
}

export function Badge(props: { children: ReactNode }): JSX.Element {
  return <span className="cd-badge">{props.children}</span>;
}

export function Pill(props: { children: ReactNode }): JSX.Element {
  return <span className="cd-pill">{props.children}</span>;
}

type Status = 'live' | 'idle' | 'error';
const STATUS_LABEL: Record<Status, string> = { live: 'Live', idle: 'Idle', error: 'Error' };

export function Avatar(props: { initials: string; status?: Status }): JSX.Element {
  return (
    <span className="cd-avatar">
      {props.initials}
      {props.status && (
        <span className={`cd-status-dot cd-status-${props.status}`}>
          <span className="sr-only">{STATUS_LABEL[props.status]}</span>
        </span>
      )}
    </span>
  );
}

export function SegmentedTabs<T extends string>(props: {
  label: string;
  tabs: readonly { id: T; label: string }[];
  selected: T;
  onSelect: (id: T) => void;
}): JSX.Element {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const move = (delta: number): void => {
    const index = props.tabs.findIndex((tab) => tab.id === props.selected);
    const next = props.tabs[(index + delta + props.tabs.length) % props.tabs.length];
    if (!next) return;
    props.onSelect(next.id);
    refs.current.get(next.id)?.focus();
  };
  return (
    <div role="tablist" aria-label={props.label} className="cd-segmented">
      {props.tabs.map((tab) => (
        <button
          key={tab.id}
          ref={(element) => {
            if (element) refs.current.set(tab.id, element);
            else refs.current.delete(tab.id);
          }}
          type="button"
          role="tab"
          aria-selected={tab.id === props.selected}
          tabIndex={tab.id === props.selected ? 0 : -1}
          onClick={() => props.onSelect(tab.id)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
              event.preventDefault();
              move(1);
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
              event.preventDefault();
              move(-1);
            }
          }}
          className="cd-tab"
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function TypingIndicator(props: { who: string }): JSX.Element {
  return (
    <span role="status" className="cd-typing">
      <span className="sr-only">{props.who} is typing</span>
      <span aria-hidden className="cd-typing-dot" />
      <span aria-hidden className="cd-typing-dot" />
      <span aria-hidden className="cd-typing-dot" />
    </span>
  );
}

export function CodeChip(props: { children: ReactNode }): JSX.Element {
  return <code className="cd-code">{props.children}</code>;
}
// harn:end web-v5-primitives-consume-only-tokens
