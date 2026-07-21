import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react';

import { Button } from '../primitives/primitives.js';

const CODE_LENGTH = 8;
const CODE_CHARACTER = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]$/;

export function normalizePairingCode(value: string): string {
  return [...value.toUpperCase()]
    .filter((character) => CODE_CHARACTER.test(character))
    .slice(0, CODE_LENGTH)
    .join('');
}

export function PairingCodeInput(props: {
  initialCode?: string;
  busy?: boolean;
  error?: string;
  submitLabel?: string;
  onSubmit: (code: string) => void;
}) {
  const initial = normalizePairingCode(props.initialCode ?? '');
  const [characters, setCharacters] = useState<string[]>(() =>
    Array.from({ length: CODE_LENGTH }, (_, index) => initial[index] ?? ''));
  const [localError, setLocalError] = useState<string>();
  const inputs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    const next = normalizePairingCode(props.initialCode ?? '');
    setCharacters(Array.from({ length: CODE_LENGTH }, (_, index) => next[index] ?? ''));
  }, [props.initialCode]);

  const setCode = (code: string, focus = true): void => {
    const normalized = normalizePairingCode(code);
    setCharacters(Array.from({ length: CODE_LENGTH }, (_, index) => normalized[index] ?? ''));
    setLocalError(undefined);
    if (focus) inputs.current[Math.min(normalized.length, CODE_LENGTH - 1)]?.focus();
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const code = characters.join('');
    if (code.length !== CODE_LENGTH) {
      setLocalError('Enter the complete 8-character pairing code.');
      inputs.current[characters.findIndex((character) => character === '')]?.focus();
      return;
    }
    setLocalError(undefined);
    props.onSubmit(code);
  };

  const paste = (event: ClipboardEvent<HTMLInputElement>): void => {
    const value = normalizePairingCode(event.clipboardData.getData('text'));
    if (value === '') return;
    event.preventDefault();
    setCode(value);
  };

  const keyDown = (index: number, event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault();
      inputs.current[index - 1]?.focus();
    } else if (event.key === 'ArrowRight' && index < CODE_LENGTH - 1) {
      event.preventDefault();
      inputs.current[index + 1]?.focus();
    } else if (event.key === 'Backspace' && characters[index] === '' && index > 0) {
      event.preventDefault();
      const next = [...characters];
      next[index - 1] = '';
      setCharacters(next);
      inputs.current[index - 1]?.focus();
    }
  };

  const error = props.error ?? localError;
  return (
    <form className="nx-code-form" onSubmit={submit} data-testid="pairing-code-form">
      <div className="nx-code-cells" role="group" aria-label="Pairing code">
        {characters.map((character, index) => (
          <input
            key={index}
            ref={(node) => { inputs.current[index] = node; }}
            className="nx-code-cell"
            data-testid={`pairing-code-${String(index)}`}
            value={character}
            inputMode="text"
            autoComplete="off"
            autoCapitalize="characters"
            maxLength={1}
            disabled={props.busy}
            aria-label={`Pairing code character ${String(index + 1)}`}
            aria-invalid={error !== undefined}
            onPaste={paste}
            onKeyDown={(event) => keyDown(index, event)}
            onChange={(event) => {
              const nextCharacter = normalizePairingCode(event.target.value).at(-1) ?? '';
              const next = [...characters];
              next[index] = nextCharacter;
              setCharacters(next);
              setLocalError(undefined);
              if (nextCharacter !== '' && index < CODE_LENGTH - 1) inputs.current[index + 1]?.focus();
            }}
          />
        ))}
      </div>
      <Button type="submit" variant="primary" disabled={props.busy} data-testid="pairing-code-submit">
        {props.busy ? 'Checking…' : props.submitLabel ?? 'Pair this browser'}
      </Button>
      {error !== undefined && <p className="nx-code-error" role="alert">{error}</p>}
    </form>
  );
}
