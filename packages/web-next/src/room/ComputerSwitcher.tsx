import { Check, Plus, Shuffle } from 'lucide-react';
import {
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import { PAIRING_TIME_COPY, SESSION_COPY } from '../app/connection-state.js';
import {
  computerSessions,
  type ComputerSessionView,
  type ComputerSessionsSnapshot,
} from '../app/computer-sessions.js';
import { Button, Code, Modal } from '../primitives/primitives.js';
import { relayUrlConfigured } from '../runtime/relay-mode.js';
import { PairingCodeInput } from '../surfaces/PairingCodeInput.js';
import {
  COMPUTER_COLORS,
  COMPUTER_GLYPHS,
  computerAppearance,
  ComputerChoice,
  readComputerAppearances,
  writeComputerAppearances,
  type ComputerAppearance,
} from './ComputerChoice.js';

const EMPTY: ComputerSessionsSnapshot = { computers: [] };
const noSubscription = (): (() => void) => () => undefined;
const PAIR_COMMAND = 'codor pair';
const LONG_PRESS_MS = 550;

function fallbackCopy(value: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  input.remove();
  return copied;
}

/** Functional hosted-only avatar rail over already-warm managed sessions. */
export function ComputerSwitcher({ mobile = false }: { mobile?: boolean } = {}): ReactNode {
  // harn:assume hosted-computer-avatar-rail-is-local-and-accessible ref=computer-avatar-rail-presentation
  const relayUrl = relayUrlConfigured();
  const manager = computerSessions();
  const list = useSyncExternalStore(
    manager?.subscribe ?? noSubscription,
    manager?.getSnapshot ?? (() => EMPTY),
    () => EMPTY,
  );
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string>();
  const [customizing, setCustomizing] = useState<string>();
  const [rename, setRename] = useState('');
  const [appearances, setAppearances] = useState<Record<string, ComputerAppearance>>(
    () => readComputerAppearances(),
  );
  const longPressTimer = useRef<number | undefined>(undefined);
  const suppressClick = useRef(false);

  if (!relayUrl || !manager || list.computers.length === 0) return null;

  const openCustomization = (computer: ComputerSessionView): void => {
    setCustomizing(computer.id);
    setRename(computer.label);
  };

  const closeCustomization = (): void => {
    suppressClick.current = false;
    setCustomizing(undefined);
  };

  const saveAppearance = (computerId: string, appearance: ComputerAppearance): void => {
    setAppearances((current) => {
      const next = { ...current, [computerId]: appearance };
      writeComputerAppearances(next);
      return next;
    });
  };

  const removeAppearance = (computerId: string): void => {
    setAppearances((current) => {
      const next = { ...current };
      delete next[computerId];
      writeComputerAppearances(next);
      return next;
    });
  };

  const select = (computer: ComputerSessionView): void => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (computer.active || !computer.ready) return;
    void manager.activate(computer.id);
  };

  const beginLongPress = (computer: ComputerSessionView, event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    window.clearTimeout(longPressTimer.current);
    longPressTimer.current = window.setTimeout(() => {
      suppressClick.current = true;
      openCustomization(computer);
    }, LONG_PRESS_MS);
  };

  const cancelLongPress = (): void => {
    window.clearTimeout(longPressTimer.current);
  };

  const handleKeyDown = (computer: ComputerSessionView, event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
      event.preventDefault();
      openCustomization(computer);
    }
  };

  const handleContextMenu = (computer: ComputerSessionView, event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    suppressClick.current = true;
    openCustomization(computer);
  };

  const add = (code: string): void => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setError(SESSION_COPY['device-offline'].body);
      return;
    }
    setPairing(true);
    setError(undefined);
    void manager.add(code, relayUrl).then(
      (ready) => {
        setPairing(false);
        if (ready) setAdding(false);
        else setError(SESSION_COPY['agent-offline'].body);
      },
      () => {
        setPairing(false);
        setError(typeof navigator !== 'undefined' && !navigator.onLine
          ? SESSION_COPY['device-offline'].body
          : PAIRING_TIME_COPY['code-bad'].body);
      },
    );
  };

  const openAdd = (): void => {
    setAdding(true);
    setCopied(false);
    setPairing(false);
    setError(undefined);
  };

  const closeAdd = (): void => {
    setAdding(false);
    setCopied(false);
    setPairing(false);
    setError(undefined);
  };

  const copyPairCommand = (): void => {
    if (fallbackCopy(PAIR_COMMAND)) {
      setCopied(true);
      setError(undefined);
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setError('Copy is unavailable here. Run codor pair manually on the other computer.');
      return;
    }
    void navigator.clipboard.writeText(PAIR_COMMAND).then(
      () => { setCopied(true); setError(undefined); },
      () => setError('Copy is unavailable here. Run codor pair manually on the other computer.'),
    );
  };

  const customizingComputer = customizing === undefined
    ? undefined
    : list.computers.find((computer) => computer.id === customizing);

  return (
    <div
      className={`nx-computer-switcher nx-computer-rail${mobile ? ' is-mobile-strip' : ''}`}
      data-testid="computer-switcher"
      aria-label="Paired computers"
    >
      <div className="nx-computer-avatar-list" role="list" aria-label="Paired computers">
        {list.computers.map((computer) => {
          const avatar = computerAppearance(computer.id, appearances);
          return (
            <div key={computer.id} role="listitem" className="nx-computer-avatar-item">
              <ComputerChoice
                computer={computer}
                variant="avatar"
                appearance={avatar}
                testid={computer.active ? 'computer-current' : `computer-avatar-${computer.id}`}
                disabled={!computer.active && !computer.ready}
                onSelect={() => select(computer)}
                onDoubleClick={() => openCustomization(computer)}
                onContextMenu={(event) => handleContextMenu(computer, event)}
                onKeyDown={(event) => handleKeyDown(computer, event)}
                onPointerDown={(event) => beginLongPress(computer, event)}
                onPointerUp={cancelLongPress}
                onPointerCancel={cancelLongPress}
                onPointerLeave={cancelLongPress}
              />
            </div>
          );
        })}
      </div>
      <Button
        type="button"
        variant="quiet"
        className="nx-computer-add"
        data-testid="computer-add"
        aria-label="Add a computer"
        title="Add a computer"
        onClick={openAdd}
      >
        <Plus size={18} aria-hidden="true" />
        <span className="nx-computer-add-label">Add</span>
      </Button>

      {customizingComputer ? (
        <Modal
          label={`Customize ${customizingComputer.label}`}
          onClose={closeCustomization}
          testid="computer-customize-modal"
        >
          <h2 className="nx-dialog-title">Customize {customizingComputer.label}</h2>
          <p className="nx-dialog-body">Choose a local icon and color for this computer. It never leaves this browser.</p>
          <fieldset className="nx-computer-customize-group">
            <legend>Computer icon</legend>
            <div className="nx-computer-glyph-grid">
              {COMPUTER_GLYPHS.map((glyph) => {
                const current = computerAppearance(customizingComputer.id, appearances);
                const selected = current.glyph === glyph;
                return (
                  <button
                    key={glyph}
                    type="button"
                    className="nx-computer-glyph"
                    aria-label={`Use ${glyph} icon`}
                    aria-pressed={selected}
                    data-testid={`computer-glyph-${glyph}`}
                    onClick={() => saveAppearance(customizingComputer.id, { ...current, glyph })}
                  >
                    {glyph}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <fieldset className="nx-computer-customize-group">
            <legend>Avatar color</legend>
            <div className="nx-computer-color-grid">
              {COMPUTER_COLORS.map((color) => {
                const current = computerAppearance(customizingComputer.id, appearances);
                const selected = current.color === color;
                return (
                  <button
                    key={color}
                    type="button"
                    className="nx-computer-color"
                    style={{ '--nx-computer-color': color } as CSSProperties}
                    aria-label={`Use ${color} avatar color`}
                    aria-pressed={selected}
                    data-testid={`computer-color-${color.slice(1)}`}
                    onClick={() => saveAppearance(customizingComputer.id, { ...current, color })}
                  >
                    {selected ? <Check size={15} aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <label className="nx-computer-rename-label">
            Display name
            <input
              value={rename}
              aria-label={`Rename ${customizingComputer.label}`}
              data-testid={`computer-rename-${customizingComputer.id}`}
              onChange={(event) => setRename(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                void manager.rename(customizingComputer.id, rename.trim() || customizingComputer.label);
              }}
            />
          </label>
          <div className="nx-computer-customize-actions">
            <Button
              type="button"
              variant="quiet"
              data-testid="computer-randomize"
              onClick={() => {
                const current = computerAppearance(customizingComputer.id, appearances);
                const glyph = COMPUTER_GLYPHS[Math.floor(Math.random() * COMPUTER_GLYPHS.length)]!;
                const color = COMPUTER_COLORS[Math.floor(Math.random() * COMPUTER_COLORS.length)]!;
                saveAppearance(customizingComputer.id, { glyph, color });
                if (glyph === current.glyph && color === current.color) {
                  saveAppearance(customizingComputer.id, { glyph: COMPUTER_GLYPHS[(COMPUTER_GLYPHS.indexOf(glyph) + 1) % COMPUTER_GLYPHS.length]!, color });
                }
              }}
            >
              <Shuffle size={15} aria-hidden="true" /> Randomize
            </Button>
            <Button
              type="button"
              variant="quiet"
              data-testid="computer-save-name"
              onClick={() => { void manager.rename(customizingComputer.id, rename.trim() || customizingComputer.label); }}
            >
              Save name
            </Button>
            <Button
              type="button"
              variant="quiet"
              data-testid={`computer-forget-${customizingComputer.id}`}
              onClick={() => {
                removeAppearance(customizingComputer.id);
                void manager.forget(customizingComputer.id).then((keptMounted) => {
                  closeCustomization();
                  if (!keptMounted) window.location.assign('/');
                });
              }}
            >
              Forget computer
            </Button>
          </div>
        </Modal>
      ) : null}

      {adding ? (
        <Modal label="Add a computer" onClose={closeAdd} testid="computer-add-modal">
          <h2 className="nx-dialog-title">Add a computer</h2>
          <p className="nx-dialog-body">Pair another computer through your existing private relay.</p>
          <div className="nx-computer-add-grid">
            <section className="nx-computer-add-step" data-testid="computer-add-step-1">
              <h3>1. Run codor pair</h3>
              <p>On the other computer, run this command and keep the terminal open:</p>
              <div className="nx-computer-pair-command">
                <Code>{PAIR_COMMAND}</Code>
                <Button type="button" variant="quiet" data-testid="computer-add-copy" onClick={copyPairCommand}>
                  {copied ? 'Copied' : 'Copy command'}
                </Button>
              </div>
              <p className="nx-field-note">The code is single-use, expires after ten minutes, and stays inside the existing private relay.</p>
            </section>
            <section className="nx-computer-add-step" data-testid="computer-add-step-2">
              <h3>2. Enter the eight-character code</h3>
              <p>Enter the single-use code printed by <Code>{PAIR_COMMAND}</Code> on the other computer.</p>
              <PairingCodeInput busy={pairing} error={error} submitLabel="Add this computer" onSubmit={add} />
            </section>
          </div>
        </Modal>
      ) : null}
    </div>
  );
  // harn:end hosted-computer-avatar-rail-is-local-and-accessible
}
