// harn:assume web-v5-primitives-consume-only-tokens ref=v5-primitive-components
// The v5 primitive library. Presentation flows entirely through the anchored classes in
// primitives.css - no inline style prop, no palette utility, no hand-authored svg. Icons
// are Lucide components at allowlisted sizes with currentColor paint. No live surface
// imports this yet; the room phase adopts it.
import type { LucideIcon } from 'lucide-react';
import { useId, useRef, type ReactNode } from 'react';

import './primitives.css';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'revive' | 'remove';

export function Button(props: {
  variant: ButtonVariant;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type={props.type ?? 'button'}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`cd-button cd-button-${props.variant}`}
    >
      {props.children}
    </button>
  );
}

export function IconButton(props: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
}): JSX.Element {
  const Icon = props.icon;
  return (
    <button type="button" aria-label={props.label} onClick={props.onClick} className="cd-button-icon">
      <Icon aria-hidden size={17} />
    </button>
  );
}

export function Input(props: {
  label: string;
  value?: string;
  placeholder?: string;
  onChange?: (value: string) => void;
}): JSX.Element {
  const id = useId();
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {props.label}
      </label>
      <input
        id={id}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange?.(event.target.value)}
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
