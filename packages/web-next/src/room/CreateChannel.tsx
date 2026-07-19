import type { Room } from '@codor/protocol';
import { CHANNEL_ACCENTS, deriveAssignableHandle, deriveRoomId } from '@codor/protocol';
import { ArrowUp, Folder, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  createRoom,
  fetchLocalDirectories,
  type AdapterRegistration,
  type LocalDirectoryListing,
} from '@legacy/api.js';

import { AgentControls } from './AgentControls.js';
import {
  DEFAULT_POLICY,
  type AgentConfig,
  collidesWithOwner,
  supportedThinking,
} from './agent-spec.js';
import { Button, Code, Modal } from '../primitives/primitives.js';
import { useAdapters } from '../app/session.js';
import { me, roomSlice, useClientStore } from '../app/store.js';

export function CreateChannelDialog(props: {
  token: () => string;
  onClose: () => void;
  onCreated: (room: Room) => void;
}) {
  const activeRoom = useClientStore((state) => state.activeRoom);
  const members = useClientStore((state) => roomSlice(state, activeRoom).members);
  const selfId = useClientStore((state) => roomSlice(state, activeRoom).selfMemberId);
  const adapters = useAdapters(props.token);
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [color, setColor] = useState<string>(CHANNEL_ACCENTS[0] ?? '');
  const [agentConfig, setAgentConfig] = useState<AgentConfig>({
    harness: '', model: '', thinking: '', policy: DEFAULT_POLICY,
  });
  // Default name matches legacy: most channels want one agent called `codor`.
  const [agentName, setAgentName] = useState('codor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // A server error about the starting agent belongs beside the agent name, not in
  // a generic banner at the bottom where it reads as unrelated to the field.
  const [agentError, setAgentError] = useState<string>();

  const owner = me(members, selfId);
  // A blank name is not an error — it falls back to "Agent", so the handle is
  // derived from the effective name rather than from what was literally typed.
  // Requiring a non-empty name here is what made the fallback unreachable.
  const effectiveAgentName = agentName.trim() === '' ? 'Agent' : agentName.trim();
  const derivedHandle = useMemo(
    () => deriveAssignableHandle(effectiveAgentName),
    [effectiveAgentName],
  );
  const agentHarness = agentConfig.harness;
  const ownerClash = derivedHandle !== undefined && collidesWithOwner(derivedHandle, owner);
  const canCreate = name.trim() !== '' && owner !== undefined && !busy && !ownerClash
    && (agentHarness === '' || derivedHandle !== undefined);

  const submit = (): void => {
    if (!canCreate || owner === undefined) return;
    setBusy(true);
    setError(undefined);
    setAgentError(undefined);
    void createRoom({
      name: name.trim(),
      owner: { handle: owner.handle, display_name: owner.display_name },
      ...(cwd !== '' && { cwd }),
      ...(color !== '' && { color }),
      ...(agentHarness !== '' && derivedHandle !== undefined && {
        starting_agent: {
          harness: agentHarness,
          handle: derivedHandle,
          // A blank name falls back rather than blocking submit.
          display_name: effectiveAgentName,
          // Always carries a policy. A channel-seeded agent used to spawn with
          // none at all, which is the F11 regression legacy still warns about.
          policy: agentConfig.policy === '' ? DEFAULT_POLICY : agentConfig.policy,
          ...(agentConfig.model !== '' && { model: agentConfig.model }),
          ...(() => {
            const level = supportedThinking(
              adapters.find((a) => a.id === agentHarness), agentConfig.thinking,
            );
            return level === undefined ? {} : { thinking: level };
          })(),
        },
      }),
    }, { token: props.token() }).then(
      (room) => props.onCreated(room),
      (failure: unknown) => {
        const message = failure instanceof Error ? failure.message : String(failure);
        if (/starting agent|handle/i.test(message)) setAgentError(message);
        else setError(message);
      },
    ).finally(() => setBusy(false));
  };

  return (
    <Modal label="Create channel" onClose={props.onClose} testid="create-channel-dialog" wide>
      {/* Native form so Enter submits from any field. */}
      <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <div className="nx-dialog-head">
        <div>
          <h2 className="nx-dialog-title">Create channel</h2>
          <p className="nx-dialog-sub">A workspace for a task and its agents.</p>
        </div>
        <button type="button" className="nx-dialog-close" aria-label="Close create channel"
          data-testid="create-close" onClick={props.onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <label className="nx-field">
        Name
        <input
          value={name}
          required
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Engineering"
          data-testid="create-name"
        />
        {name.trim() !== '' && (
          // The derived id is what everything else addresses this channel by.
          <span className="nx-field-note">id: <Code>{deriveRoomId(name)}</Code></span>
        )}
      </label>
      <div className="nx-field">
        Colour
        <div className="nx-swatch-row" role="group" aria-label="Channel colour">
          {CHANNEL_ACCENTS.map((accent, index) => (
            <button
              key={accent}
              type="button"
              className="nx-swatch"
              style={{ '--swatch': accent } as React.CSSProperties}
              aria-label={`Accent ${String(index + 1)}`}
              aria-pressed={color === accent}
              data-testid={`create-color-${String(index)}`}
              onClick={() => setColor(accent)}
            />
          ))}
        </div>
      </div>
      <div className="nx-field">
        Working folder (optional)
        <FolderPicker token={props.token} value={cwd} onChange={setCwd} />
      </div>
      <div className="nx-field">
        Starting agent (optional)
        <div className="nx-tile-row" role="group" aria-label="Starting agent">
          <button
            type="button"
            className="nx-tile"
            aria-pressed={agentHarness === ''}
            data-testid="create-harness-none"
            onClick={() => setAgentConfig({ ...agentConfig, harness: '' })}
          >
            None
          </button>
          {adapters.map((adapter: AdapterRegistration) => (
            <button
              key={adapter.id}
              type="button"
              className="nx-tile"
              aria-pressed={agentHarness === adapter.id}
              data-testid={`create-harness-${adapter.id}`}
              onClick={() => setAgentConfig({ ...agentConfig, harness: adapter.id, model: '', thinking: '' })}
            >
              {adapter.id}
            </button>
          ))}
        </div>
      </div>
      <>
          <label className="nx-field">
            Agent name
            {/* Disabled rather than unmounted elsewhere, so the dialog never jumps. */}
            {/* Disabled, never unmounted: unmounting made the dialog jump as the
                harness changed, and hid the control instead of explaining it. */}
            <input
              value={agentName}
              disabled={agentHarness === ''}
              onChange={(e) => setAgentName(e.target.value)}
              placeholder="e.g. Scout"
              data-testid="create-agent-name"
            />
            {agentError !== undefined && (
              <span className="nx-field-note is-error" role="alert" data-testid="create-agent-error">
                {agentError}
              </span>
            )}
            {/* Only claim an agent will join when one actually will — under "None"
                this promised "@codor joins" and nothing was created. */}
            {agentHarness !== '' && agentName.trim() !== '' && (
              derivedHandle !== undefined
                ? <span className="nx-field-note">joins as <Code>@{derivedHandle}</Code></span>
                : <span className="nx-field-note is-error">that name resolves to a reserved handle — pick another</span>
            )}
            {ownerClash && (
              <span className="nx-field-note is-error" data-testid="create-owner-clash">
                @{derivedHandle} is already in use by the channel owner.
              </span>
            )}
          </label>
          {/* The same control the spawn and configure dialogs use, so a channel-seeded
              agent is configured exactly as thoroughly as a later one. */}
          {agentHarness !== '' && (
            <AgentControls adapters={adapters} config={agentConfig} onChange={setAgentConfig}
              hideHarness idPrefix="create" />
          )}
      </>
      {error !== undefined && <p className="nx-field-note is-error" role="alert">{error}</p>}
      <div className="nx-dialog-actions">
        <Button variant="quiet" type="button" onClick={props.onClose}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={!canCreate} data-testid="create-go">
          {busy ? 'Creating…' : 'Create channel'}
        </Button>
      </div>
      </form>
    </Modal>
  );
}

/** Minimal directory browser over the daemon's home-contained listing. */
function FolderPicker(props: { token: () => string; value: string; onChange: (path: string) => void }) {
  const [listing, setListing] = useState<LocalDirectoryListing>();
  const [browsing, setBrowsing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [typed, setTyped] = useState('');

  // Browsing no longer mutates the selection. Every navigation used to call
  // onChange, so opening the picker to look around silently changed the channel's
  // folder and there was no way back out of a partial browse.
  const load = (path?: string, showHidden = hidden): void => {
    void fetchLocalDirectories(path, showHidden, { token: props.token() })
      .then((next) => { setListing(next); setTyped(next.path); setFailed(false); })
      .catch(() => setFailed(true));
  };

  useEffect(() => {
    if (browsing && listing === undefined && !failed) load(props.value === '' ? undefined : props.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browsing]);

  if (!browsing) {
    return (
      <button type="button" className="nx-folder-summary" data-testid="folder-open" onClick={() => setBrowsing(true)}>
        <Folder size={15} aria-hidden="true" />
        {props.value === '' ? 'Choose a folder…' : props.value}
      </button>
    );
  }
  if (failed) return <p className="nx-field-note is-error">Couldn’t list folders on this device.</p>;
  if (listing === undefined) return <p className="nx-field-note">Loading folders…</p>;

  // Clickable trail back to the root, rather than one step of "up" at a time.
  const segments = listing.path.split('/').filter((part) => part !== '');
  const crumbs = segments.map((name, index) => ({
    name,
    path: `/${segments.slice(0, index + 1).join('/')}`,
  }));

  return (
    <div className="nx-folder-picker" data-testid="folder-picker">
      <div className="nx-folder-path">
        <nav className="nx-crumbs" aria-label="Folder path">
          <button type="button" data-testid="folder-crumb-root" onClick={() => load('/')}>/</button>
          {crumbs.map((crumb) => (
            <button key={crumb.path} type="button" data-testid={`folder-crumb-${crumb.name}`}
              onClick={() => load(crumb.path)}>{crumb.name}</button>
          ))}
        </nav>
        {listing.parent !== null && (
          <button type="button" className="nx-folder-up" data-testid="folder-up" onClick={() => load(listing.parent ?? undefined)}>
            <ArrowUp size={13} aria-hidden="true" /> up
          </button>
        )}
      </div>

      <ul className="nx-folder-list">
        {listing.dirs.length === 0 && <li className="nx-field-note">no subfolders</li>}
        {listing.dirs.map((dir) => (
          <li key={dir.path}>
            <button type="button" data-testid={`folder-${dir.name}`} onClick={() => load(dir.path)}>
              <Folder size={14} aria-hidden="true" /> {dir.name}
            </button>
          </li>
        ))}
      </ul>

      <label className="nx-folder-hidden">
        {/* Without this, ~/.config and every other dotfile directory is unreachable. */}
        <input type="checkbox" checked={hidden} data-testid="folder-hidden"
          onChange={(e) => { setHidden(e.target.checked); load(listing.path, e.target.checked); }} />
        Show hidden folders
      </label>

      <label className="nx-field">
        {/* A path outside the browsable tree — a mount, a symlink target — is
            otherwise unreachable, because browsing is the only way in. */}
        Or type a path
        <input className="nx-input" value={typed} data-testid="folder-typed"
          onChange={(e) => setTyped(e.target.value)}
          placeholder="/home/you/project" />
      </label>

      <div className="nx-folder-confirm">
        <Button variant="quiet" type="button" onClick={() => setBrowsing(false)}>Cancel</Button>
        <Button variant="primary" type="button" data-testid="folder-use"
          onClick={() => { props.onChange(typed.trim()); setBrowsing(false); }}>
          Use this folder
        </Button>
      </div>
      <p className="nx-field-note">selected <Code>{typed}</Code></p>
    </div>
  );
}
