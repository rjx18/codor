import type { Room } from '@codor/protocol';
import { deriveRoomId } from '@codor/protocol';
import { FolderPlus, X } from 'lucide-react';
import { useState } from 'react';

import {
  createRoom,
} from '@runtime/api.js';

import { Section } from './AgentControls.js';
import { FolderPicker } from './FolderPicker.js';
import { isAgentFieldError } from './agent-spec.js';
import {
  StartingParticipantControls,
  type StartingParticipantSelection,
} from './StartingParticipant.js';
import { Button, Code, Modal } from '../primitives/primitives.js';
import { useAdapterCatalog } from '../app/session.js';
import { me, roomSlice, useClientStore } from '../app/store.js';

export function CreateChannelDialog(props: {
  token: () => string;
  onClose: () => void;
  onCreated: (room: Room) => void;
}) {
  const activeRoom = useClientStore((state) => state.activeRoom);
  const members = useClientStore((state) => roomSlice(state, activeRoom).members);
  const selfId = useClientStore((state) => roomSlice(state, activeRoom).selfMemberId);
  const adapterCatalog = useAdapterCatalog(props.token);
  const adapters = adapterCatalog.installed;
  const advanced = adapterCatalog.advanced;
  const [name, setName] = useState('');
  const [project, setProject] = useState('');
  const [cwd, setCwd] = useState('');
  const [startingParticipant, setStartingParticipant] = useState<StartingParticipantSelection>({
    mode: 'none',
    valid: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // A server error about the starting agent belongs beside the agent name, not in
  // a generic banner at the bottom where it reads as unrelated to the field.
  const [agentError, setAgentError] = useState<string>();

  const owner = me(members, selfId);
  const canCreate = name.trim() !== '' && cwd.trim() !== '' && owner !== undefined && !busy
    && startingParticipant.valid;

  const submit = (): void => {
    if (!canCreate || owner === undefined) return;
    setBusy(true);
    setError(undefined);
    setAgentError(undefined);
    void createRoom({
      name: name.trim(),
      ...(project.trim() !== '' && { project: project.trim() }),
      owner: { handle: owner.handle, display_name: owner.display_name },
      cwd: cwd.trim(),
      ...(startingParticipant.starting_agent !== undefined
        && { starting_agent: startingParticipant.starting_agent }),
      ...(startingParticipant.starting_session !== undefined
        && { starting_session: startingParticipant.starting_session }),
    }, { token: props.token() }).then(
      (room) => props.onCreated(room),
      (failure: unknown) => {
        const message = failure instanceof Error ? failure.message : String(failure);
        if (isAgentFieldError(message)) setAgentError(message);
        else setError(message);
      },
    ).finally(() => setBusy(false));
  };

  return (
    <Modal label="Create channel" onClose={props.onClose} testid="create-channel-dialog" structured>
      {/* Native form so Enter submits from any field. */}
      <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <div className="nx-dialog-head">
        <div className="nx-dialog-headings">
          <span className="nx-dialog-icon" aria-hidden="true"><FolderPlus size={19} /></span>
          <div>
            <h2 className="nx-dialog-title">Create channel</h2>
            <p className="nx-dialog-sub">A workspace for a task and its agents.</p>
          </div>
        </div>
        <button type="button" className="nx-dialog-close" aria-label="Close create channel"
          data-testid="create-close" onClick={props.onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="nx-dialog-body">
      <Section n={1} title="Workspace">
      <label className="nx-field">
        <span className="nx-label">Name</span>
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
      <label className="nx-field">
        <span className="nx-label">Project <span className="nx-req">· optional</span></span>
        <input
          value={project}
          maxLength={80}
          onChange={(event) => setProject(event.target.value)}
          placeholder="e.g. PersonalOS"
          data-testid="create-project"
        />
        <span className="nx-field-note">Channels with the same project appear together.</span>
      </label>
      <div className="nx-field">
        <span className="nx-label">Working folder <span className="nx-req">· required</span></span>
        <FolderPicker token={props.token} value={cwd} onChange={setCwd} idPrefix="create" />
      </div>
      </Section>
      <Section n={2} title="Starting participant">
        <StartingParticipantControls
          adapters={adapters}
          advanced={advanced}
          cwd={cwd}
          owner={owner}
          idPrefix="create"
          onChange={setStartingParticipant}
          onRefresh={adapterCatalog.refresh}
          refreshing={adapterCatalog.refreshing}
          refreshError={adapterCatalog.refreshError}
        />
        {agentError !== undefined && (
          <p className="nx-field-note is-error" role="alert" data-testid="create-agent-error">
            {agentError}
          </p>
        )}
      </Section>
      {error !== undefined && <p className="nx-field-note is-error" role="alert">{error}</p>}
      </div>
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
