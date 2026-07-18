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
  const [agentHarness, setAgentHarness] = useState('');
  const [agentName, setAgentName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const owner = me(members, selfId);
  const derivedHandle = useMemo(
    () => (agentName.trim() === '' ? undefined : deriveAssignableHandle(agentName)),
    [agentName],
  );
  const canCreate = name.trim() !== '' && owner !== undefined && !busy
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
          display_name: agentName.trim(),
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
      <label className="nx-field">
        Starting agent (optional)
        <select value={agentHarness} onChange={(e) => setAgentHarness(e.target.value)} data-testid="create-harness">
          <option value="">none</option>
          {adapters.map((adapter: AdapterRegistration) => (
            <option key={adapter.id} value={adapter.id}>{adapter.id}</option>
          ))}
        </select>
      </label>
      {agentHarness !== '' && (
        <label className="nx-field">
          Agent name
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
        </label>
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
