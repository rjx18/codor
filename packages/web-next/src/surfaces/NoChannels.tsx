import { deriveAssignableHandle, deriveRoomId } from '@codor/protocol';
import { ArrowRight, FolderPlus, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { createRoom } from '@runtime/api.js';

import { Button, Code } from '../primitives/primitives.js';
import { AgentControls, AgentIdentityControls, Section } from '../room/AgentControls.js';
import { FolderPicker } from '../room/FolderPicker.js';
import {
  DEFAULT_POLICY,
  type AgentConfig,
  supportedThinking,
} from '../room/agent-spec.js';
import { useAdapterCatalog } from '../app/session.js';

export function suggestedChannelName(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/, '');
  const name = normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  return name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A confirmed empty room list is an onboarding state, not a dead end. */
export function NoChannels(props: { token: string }) {
  const token = useCallback(() => props.token, [props.token]);
  const adapterCatalog = useAdapterCatalog(token);
  const adapters = adapterCatalog.installed;
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [cwd, setCwd] = useState('');
  const [ownerName, setOwnerName] = useState('You');
  const [agentName, setAgentName] = useState('Codor');
  const [agentConfig, setAgentConfig] = useState<AgentConfig>({
    harness: '', model: '', thinking: '', policy: DEFAULT_POLICY,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const ownerHandle = useMemo(
    () => deriveAssignableHandle(ownerName.trim()),
    [ownerName],
  );
  const effectiveAgentName = agentName.trim() === '' ? 'Agent' : agentName.trim();
  const agentHandle = useMemo(
    () => deriveAssignableHandle(effectiveAgentName),
    [effectiveAgentName],
  );
  const hasAgent = agentConfig.harness !== '';
  // harn:assume agent-selection-catalog-is-refreshable ref=first-channel-harness-refresh
  useEffect(() => {
    if (!hasAgent || adapters.some((adapter) => adapter.id === agentConfig.harness)) return;
    setAgentConfig({ ...agentConfig, harness: '', model: '', thinking: '' });
  }, [adapters, agentConfig, hasAgent]);
  // harn:end agent-selection-catalog-is-refreshable
  const identityClash = hasAgent && ownerHandle !== undefined && agentHandle === ownerHandle;
  const canCreate = name.trim() !== '' && cwd.trim() !== '' && ownerHandle !== undefined && !busy
    && (!hasAgent || (agentHandle !== undefined && !identityClash));

  const chooseFolder = (path: string): void => {
    setCwd(path);
    if (nameEdited) return;
    const suggested = suggestedChannelName(path);
    if (suggested !== '') setName(suggested);
  };

  const submit = (): void => {
    if (!canCreate || ownerHandle === undefined) return;
    setBusy(true);
    setError(undefined);
    void createRoom({
      name: name.trim(),
      owner: { handle: ownerHandle, display_name: ownerName.trim() },
      cwd: cwd.trim(),
      ...(hasAgent && agentHandle !== undefined && {
        starting_agent: {
          harness: agentConfig.harness,
          handle: agentHandle,
          display_name: effectiveAgentName,
          policy: agentConfig.policy === '' ? DEFAULT_POLICY : agentConfig.policy,
          ...(agentConfig.model !== '' && { model: agentConfig.model }),
          ...(() => {
            const thinking = supportedThinking(
              adapters.find((adapter) => adapter.id === agentConfig.harness),
              agentConfig.thinking,
            );
            return thinking === undefined ? {} : { thinking };
          })(),
        },
      }),
    }, { token: props.token }).then(
      (room) => { window.location.assign(`/?room=${encodeURIComponent(room.id)}`); },
      (failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
        setBusy(false);
      },
    );
  };

  return (
    <main className="nx-onboarding" data-testid="first-channel-onboarding">
      <header className="nx-onboarding-head">
        <span className="nx-onboarding-mark" aria-hidden="true" />
        <p className="nx-eyebrow">Paired successfully</p>
        <h1>Create your first channel</h1>
        <p>Point Codor at a project, then bring in an agent now or add one later.</p>
      </header>

      <form className="nx-onboarding-card" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <Section n={1} title="Channel" headingLevel={2}>
          <label className="nx-field">
            <span className="nx-label">Channel name</span>
            <input
              required
              autoFocus
              value={name}
              placeholder="e.g. My project"
              data-testid="first-channel-name"
              onChange={(event) => {
                setName(event.target.value);
                setNameEdited(true);
              }}
            />
            {name.trim() !== '' && <span className="nx-field-note">id: <Code>{deriveRoomId(name)}</Code></span>}
          </label>

          <label className="nx-field">
            <span className="nx-label">Your name</span>
            <input
              required
              value={ownerName}
              data-testid="first-channel-owner"
              onChange={(event) => setOwnerName(event.target.value)}
            />
            {ownerHandle === undefined
              ? <span className="nx-field-note is-error">Choose a name that produces a usable handle.</span>
              : <span className="nx-field-note">you’ll join as <Code>@{ownerHandle}</Code></span>}
          </label>

          <div className="nx-field">
            <span className="nx-label">Project folder <span className="nx-req">· required</span></span>
            <FolderPicker token={() => props.token} value={cwd} onChange={chooseFolder} idPrefix="first" />
            {!nameEdited && cwd !== '' && (
              <span className="nx-field-note" data-testid="first-channel-folder-suggestion">
                Suggested the folder name above. Editing the name keeps your choice.
              </span>
            )}
          </div>
        </Section>

        <Section n={2} title="Starting agent" headingLevel={2}>
          <div className="nx-first-agent">
            <AgentIdentityControls
              adapters={adapters}
              config={agentConfig}
              onChange={setAgentConfig}
              allowNone
              optional
              idPrefix="first"
              onRefresh={adapterCatalog.refresh}
              refreshing={adapterCatalog.refreshing}
              refreshError={adapterCatalog.refreshError}
            />
            {hasAgent ? (
              <>
                <label className="nx-field">
                  <span className="nx-label">Agent name</span>
                  <input
                    value={agentName}
                    data-testid="first-agent-name"
                    onChange={(event) => setAgentName(event.target.value)}
                  />
                  {agentHandle !== undefined && !identityClash && (
                    <span className="nx-field-note">joins as <Code>@{agentHandle}</Code></span>
                  )}
                  {identityClash && (
                    <span className="nx-field-note is-error">The owner and agent need different handles.</span>
                  )}
                </label>
                <AgentControls
                  adapters={adapters}
                  config={agentConfig}
                  onChange={setAgentConfig}
                  hideHarness
                  embedded
                  behaviourSection={3}
                  permissionsSection={4}
                  idPrefix="first"
                />
              </>
            ) : (
              <p className="nx-first-later"><Sparkles size={16} aria-hidden="true" /> You can add agents from the channel at any time.</p>
            )}
          </div>
        </Section>

        {error !== undefined && <p className="nx-field-note is-error nx-first-error" role="alert">{error}</p>}
        <footer className="nx-onboarding-actions">
          <span><FolderPlus size={15} aria-hidden="true" /> Creates a private workspace on this host.</span>
          <Button type="submit" variant="primary" disabled={!canCreate} data-testid="first-channel-create">
            {busy ? 'Creating…' : <>Create channel <ArrowRight size={15} aria-hidden="true" /></>}
          </Button>
        </footer>
      </form>
    </main>
  );
}
