import type { Room } from '@codor/protocol';
import { deriveAssignableHandle } from '@codor/protocol';
import { ArrowUp, Folder } from 'lucide-react';
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
  const [agentConfig, setAgentConfig] = useState<AgentConfig>({
    harness: '', model: '', thinking: '', policy: DEFAULT_POLICY,
  });
  // Default name matches legacy: most channels want one agent called `codor`.
  const [agentName, setAgentName] = useState('codor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const owner = me(members, selfId);
  const derivedHandle = useMemo(
    () => (agentName.trim() === '' ? undefined : deriveAssignableHandle(agentName)),
    [agentName],
  );
  const agentHarness = agentConfig.harness;
  const ownerClash = derivedHandle !== undefined && collidesWithOwner(derivedHandle, owner);
  const canCreate = name.trim() !== '' && owner !== undefined && !busy && !ownerClash
    && (agentHarness === '' || (agentName.trim() !== '' && derivedHandle !== undefined));

  const submit = (): void => {
    if (!canCreate || owner === undefined) return;
    setBusy(true);
    setError(undefined);
    void createRoom({
      name: name.trim(),
      owner: { handle: owner.handle, display_name: owner.display_name },
      ...(cwd !== '' && { cwd }),
      ...(agentHarness !== '' && derivedHandle !== undefined && {
        starting_agent: {
          harness: agentHarness,
          handle: derivedHandle,
          // A blank name falls back rather than blocking submit.
          display_name: agentName.trim() === '' ? 'Agent' : agentName.trim(),
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
      (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)),
    ).finally(() => setBusy(false));
  };

  return (
    <Modal label="Create channel" onClose={props.onClose} testid="create-channel-dialog" wide>
      <h2 className="nx-dialog-title">Create channel</h2>
      <label className="nx-field">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Engineering"
          data-testid="create-name"
        />
      </label>
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
      {agentHarness !== '' && (
        <>
          <label className="nx-field">
            Agent name
            {/* Disabled rather than unmounted elsewhere, so the dialog never jumps. */}
            <input
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              placeholder="e.g. Scout"
              data-testid="create-agent-name"
            />
            {agentName.trim() !== '' && (
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
          <AgentControls
            adapters={adapters}
            config={agentConfig}
            onChange={setAgentConfig}
            idPrefix="create"
          />
        </>
      )}
      {error !== undefined && <p className="nx-field-note is-error" role="alert">{error}</p>}
      <div className="nx-dialog-actions">
        <Button variant="quiet" onClick={props.onClose}>Cancel</Button>
        <Button variant="primary" disabled={!canCreate} data-testid="create-go" onClick={submit}>
          {busy ? 'Creating…' : 'Create channel'}
        </Button>
      </div>
    </Modal>
  );
}

/** Minimal directory browser over the daemon's home-contained listing. */
function FolderPicker(props: { token: () => string; value: string; onChange: (path: string) => void }) {
  const [listing, setListing] = useState<LocalDirectoryListing>();
  const [browsing, setBrowsing] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = (path?: string): void => {
    void fetchLocalDirectories(path, false, { token: props.token() })
      .then((next) => {
        setListing(next);
        setFailed(false);
        props.onChange(next.path);
      })
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

  return (
    <div className="nx-folder-picker" data-testid="folder-picker">
      <div className="nx-folder-path">
        <Code>{listing.path}</Code>
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
      <p className="nx-field-note">channel works in <Code>{listing.path}</Code></p>
    </div>
  );
}
