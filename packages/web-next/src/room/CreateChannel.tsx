import type { Room } from '@codor/protocol';
import { deriveAssignableHandle, deriveRoomId } from '@codor/protocol';
import { FolderPlus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  createRoom,
} from '@runtime/api.js';

import { AgentControls, AgentIdentityControls, Section } from './AgentControls.js';
import { FolderPicker } from './FolderPicker.js';
import {
  DEFAULT_POLICY,
  type AgentConfig,
  collidesWithOwner,
  isAgentFieldError,
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
  // A server error about the starting agent belongs beside the agent name, not in
  // a generic banner at the bottom where it reads as unrelated to the field.
  const [agentError, setAgentError] = useState<string>();

  const owner = me(members, selfId);
  // A blank name is not an error — it falls back to "Agent", so the handle is
  // derived from the effective name rather than from what was literally typed.
  // Requiring a non-empty name here is what made the fallback unreachable.
  const agentHarness = agentConfig.harness;
  const effectiveAgentName = agentName.trim() === '' ? 'Agent' : agentName.trim();
  const derivedHandle = useMemo(
    () => deriveAssignableHandle(effectiveAgentName),
    [effectiveAgentName],
  );
  // Only meaningful when an agent is actually being seeded. The name field keeps
  // its default under "None", so without this guard an owner called @codor blocked
  // channel creation entirely — for an agent that was never going to be created.
  const ownerClash = agentHarness !== '' && derivedHandle !== undefined
    && collidesWithOwner(derivedHandle, owner);
  const canCreate = name.trim() !== '' && cwd.trim() !== '' && owner !== undefined && !busy
    && !ownerClash && (agentHarness === '' || derivedHandle !== undefined);

  const submit = (): void => {
    if (!canCreate || owner === undefined) return;
    setBusy(true);
    setError(undefined);
    setAgentError(undefined);
    void createRoom({
      name: name.trim(),
      owner: { handle: owner.handle, display_name: owner.display_name },
      cwd: cwd.trim(),
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
      <div className="nx-field">
        <span className="nx-label">Working folder <span className="nx-req">· required</span></span>
        <FolderPicker token={props.token} value={cwd} onChange={setCwd} idPrefix="create" />
      </div>
      </Section>
      <Section n={2} title="Starting agent">
      <div className="nx-agent-panel">
          <AgentIdentityControls
            adapters={adapters}
            config={agentConfig}
            onChange={setAgentConfig}
            allowNone
            optional
            idPrefix="create"
          />
          {agentHarness === '' && (
            <p className="nx-field-note" data-testid="create-agent-none-note">
              You can add an agent later.
            </p>
          )}
          {agentHarness !== '' && (
            <>
              <label className="nx-field">
                <span className="nx-label">Agent name</span>
                <input
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  placeholder="e.g. Scout"
                  data-testid="create-agent-name"
                />
                {agentError !== undefined && (
                  <span className="nx-field-note is-error" role="alert" data-testid="create-agent-error">
                    {agentError}
                  </span>
                )}
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
                hideHarness
                behaviourSection={3}
                permissionsSection={4}
                embedded
                idPrefix="create"
              />
            </>
          )}
      </div>
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
