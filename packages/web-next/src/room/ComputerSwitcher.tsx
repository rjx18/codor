import { useEffect, useState } from 'react';

import { PAIRING_TIME_COPY, SESSION_COPY } from '../app/connection-state.js';
import { Button, Modal } from '../primitives/primitives.js';
import {
  forgetPairedComputer,
  listPairedComputers,
  pairThroughRelay,
  renamePairedComputer,
  switchComputer,
} from '../runtime/crypto.js';
import { relayUrlConfigured } from '../runtime/relay-mode.js';
import type { RelayComputer } from '../runtime/relay-records.js';
import { PairingCodeInput } from '../surfaces/PairingCodeInput.js';

/**
 * The Connected-box computer switcher (P3), rendered below the user name — the
 * single home for the current computer's label, switching between paired
 * computers, adding one (via the universal-code flow), and per-computer Forget.
 * Hosted-only: renders NOTHING on a switchboard-served SPA (no relay URL).
 */
export function ComputerSwitcher(): React.ReactNode {
  const relayUrl = relayUrlConfigured();
  const [list, setList] = useState<{ computers: RelayComputer[]; active_id?: string }>();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string>();
  const [renaming, setRenaming] = useState<string>();

  const refresh = (): void => { void listPairedComputers().then(setList); };
  useEffect(() => { if (relayUrl) refresh(); }, [relayUrl]);

  if (!relayUrl || !list || list.computers.length === 0) return null;
  const active = list.computers.find((c) => c.id === list.active_id)
    ?? list.computers[list.computers.length - 1];

  const add = (code: string): void => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setError(SESSION_COPY['device-offline'].body);
      return;
    }
    setPairing(true);
    setError(undefined);
    // Records the new computer as active; reload boots straight into it.
    void pairThroughRelay(code, relayUrl)
      .then(() => window.location.assign('/'))
      .catch(() => {
        setPairing(false);
        // Offline AT rejection time is a device problem, not a bad code.
        setError(typeof navigator !== 'undefined' && !navigator.onLine
          ? SESSION_COPY['device-offline'].body
          : PAIRING_TIME_COPY['code-bad'].body);
      });
  };

  return (
    <div className="nx-computer-switcher" data-testid="computer-switcher">
      <button
        type="button"
        className="nx-computer-current"
        data-testid="computer-current"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {active?.label ?? 'This computer'}
      </button>
      {open ? (
        <div className="nx-computer-menu" role="menu">
          <ul>
            {list.computers.map((c) => (
              <li key={c.id} data-testid={`computer-${c.id}`}>
                {renaming === c.id ? (
                  <input
                    className="nx-computer-rename"
                    autoFocus
                    defaultValue={c.label}
                    data-testid={`computer-rename-${c.id}`}
                    onBlur={(e) => {
                      void renamePairedComputer(c.id, e.target.value.trim() || c.label)
                        .then(() => { setRenaming(undefined); refresh(); });
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  />
                ) : (
                  <button
                    type="button"
                    className="nx-computer-name"
                    data-testid={`computer-switch-${c.id}`}
                    onDoubleClick={() => setRenaming(c.id)}
                    onClick={() => {
                      if (c.id !== list.active_id) {
                        void switchComputer(c.id).then(() => window.location.assign('/'));
                      }
                    }}
                  >
                    {c.label}{c.id === list.active_id ? ' ✓' : ''}
                  </button>
                )}
                <button
                  type="button"
                  className="nx-computer-forget"
                  data-testid={`computer-forget-${c.id}`}
                  onClick={() => { void forgetPairedComputer(c.id).then(() => window.location.assign('/')); }}
                >
                  Forget
                </button>
              </li>
            ))}
          </ul>
          <Button variant="quiet" data-testid="computer-add" onClick={() => { setAdding(true); setOpen(false); }}>
            Add a computer
          </Button>
        </div>
      ) : null}
      {adding ? (
        <Modal label="Add a computer" onClose={() => { setAdding(false); setError(undefined); }} testid="computer-add-modal">
          <h2 className="nx-dialog-title">Add a computer</h2>
          <p className="nx-dialog-body">Enter the pairing code shown by Codor on the other computer.</p>
          <PairingCodeInput busy={pairing} error={error} submitLabel="Add this computer" onSubmit={add} />
        </Modal>
      ) : null}
    </div>
  );
}
