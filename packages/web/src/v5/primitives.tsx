// harn:assume web-v5-primitives-consume-only-tokens ref=v5-primitive-components
// The v5 primitive library. Presentation flows entirely through the anchored classes in
// primitives.css - no inline style prop, no palette utility, no hand-authored svg. Icons
// are Lucide components at allowlisted sizes with currentColor paint. No live surface
// imports this yet; the room phase adopts it.
import type { LucideIcon } from 'lucide-react';
import {
  forwardRef,
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

// Button and IconButton forward a ref to the native <button>, so a room surface can focus a
// trigger after closing the dialog it opened (the create-channel and spawn triggers do this).
export const Button = forwardRef<
  HTMLButtonElement,
  NativeButtonProps & { variant: ButtonVariant; children: ReactNode }
>(function Button({ variant, type, children, ...rest }, ref): JSX.Element {
  return (
    <button
      {...stripControlled(rest)}
      ref={ref}
      type={type ?? 'button'}
      className={`cd-button cd-button-${variant}`}
    >
      {children}
    </button>
  );
});

export const IconButton = forwardRef<
  HTMLButtonElement,
  NativeButtonProps & { icon: LucideIcon; label: string }
>(function IconButton({ icon, label, type, ...rest }, ref): JSX.Element {
  const Icon = icon;
  return (
    <button
      {...stripControlled(rest)}
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      className="cd-button cd-button-icon"
    >
      <Icon aria-hidden size={17} />
    </button>
  );
});

// Input forwards a ref to the native element (a room surface that must focus or measure the
// field), and accepts a caller-supplied `id` so a surface can keep a fixed, referenced id
// (the room's `room-search`); when none is given it falls back to a generated one. The label
// binds to whichever id is used.
export const Input = forwardRef<
  HTMLInputElement,
  NativeInputProps & {
    label: string;
    id?: string;
    value?: string;
    onChange?: (value: string) => void;
  }
>(function Input({ label, onChange, value, id, ...rest }, ref): JSX.Element {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <>
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <input
        {...stripControlled(rest)}
        ref={ref}
        id={inputId}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        className="cd-input"
      />
    </>
  );
});

// Badge/Pill carry a status word or count; both forward a data-testid so a room surface can
// target the chip, and Badge takes an optional tone for an attention count.
export function Badge(props: {
  children: ReactNode;
  tone?: 'attention';
  'data-testid'?: string;
}): JSX.Element {
  return (
    <span data-testid={props['data-testid']} className={`cd-badge${props.tone ? ` cd-badge-${props.tone}` : ''}`}>
      {props.children}
    </span>
  );
}

export function Pill(props: { children: ReactNode; 'data-testid'?: string }): JSX.Element {
  return (
    <span data-testid={props['data-testid']} className="cd-pill">
      {props.children}
    </span>
  );
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

// Each tab may carry a caller-supplied `tabId` (so a panel can be labelled by it), an
// `aria-controls` panel id, and a `disabled` flag (the room's Run tab, disabled until a run
// is selected). Roving focus and arrow navigation skip disabled tabs, and a disabled tab
// cannot be selected by click or keyboard.
export function SegmentedTabs<T extends string>(props: {
  label: string;
  tabs: readonly { id: T; label: ReactNode; tabId?: string; controls?: string; disabled?: boolean }[];
  selected: T;
  onSelect: (id: T) => void;
}): JSX.Element {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const enabled = props.tabs.filter((tab) => !tab.disabled);
  const move = (delta: number): void => {
    if (enabled.length === 0) return;
    const index = enabled.findIndex((tab) => tab.id === props.selected);
    // From an unselected/disabled origin, step from the first enabled tab.
    const base = index === -1 ? 0 : index;
    const next = enabled[(base + delta + enabled.length) % enabled.length];
    if (!next) return;
    props.onSelect(next.id);
    refs.current.get(next.id)?.focus();
  };
  // The roving tabindex lands on the selected tab, or the first enabled tab when the
  // selection is disabled/absent, so a disabled tab never traps keyboard focus.
  const rovingId = props.tabs.some((tab) => tab.id === props.selected && !tab.disabled)
    ? props.selected
    : enabled[0]?.id;
  return (
    <div role="tablist" aria-label={props.label} className="cd-segmented">
      {props.tabs.map((tab) => (
        <button
          key={tab.id}
          {...(tab.tabId !== undefined && { id: tab.tabId })}
          {...(tab.controls !== undefined && { 'aria-controls': tab.controls })}
          ref={(element) => {
            if (element) refs.current.set(tab.id, element);
            else refs.current.delete(tab.id);
          }}
          type="button"
          role="tab"
          aria-selected={tab.id === props.selected}
          disabled={tab.disabled}
          tabIndex={tab.id === rovingId ? 0 : -1}
          onClick={() => {
            if (tab.disabled) return;
            props.onSelect(tab.id);
          }}
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

// Announces the truthful active-member working state - the room hands it the handle of a member
// whose turn is actually running, and it reads "@alpha is working". It is not a typing protocol:
// there is no keystroke signal behind it, only the live run state the room already tracks.
export function TypingIndicator(props: { who: string }): JSX.Element {
  return (
    <span role="status" className="cd-typing">
      <span className="sr-only">{props.who} is working</span>
      <span aria-hidden className="cd-typing-dot" />
      <span aria-hidden className="cd-typing-dot" />
      <span aria-hidden className="cd-typing-dot" />
    </span>
  );
}

export function CodeChip(props: { children: ReactNode; 'data-testid'?: string }): JSX.Element {
  return (
    <code data-testid={props['data-testid']} className="cd-code">
      {props.children}
    </code>
  );
}
// harn:end web-v5-primitives-consume-only-tokens
