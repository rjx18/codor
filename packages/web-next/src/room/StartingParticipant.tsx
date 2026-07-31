import {
  deriveAssignableHandle,
  type StartingAgent,
  type StartingSession,
} from '@codor/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { AdapterRegistration } from '@runtime/api.js';

import {
  AgentControls,
  AgentIdentityControls,
  ParticipantColorPicker,
  RolePresetControls,
} from './AgentControls.js';
import {
  DEFAULT_POLICY,
  SPAWN_PRESETS,
  type AgentConfig,
  acpLaunchFromConfig,
  collidesWithOwner,
  effectiveHarness,
  isValidSessionRef,
  reconcileConfig,
  resolveSelector,
  supportedThinking,
} from './agent-spec.js';
import {
  PARTICIPANT_MODE_COPY,
  configuredConnector,
  connectorHarnessFor,
  type JoinHarnessChoice,
  type StartingParticipantMode,
} from './participant-options.js';
import { Code, StatusPill } from '../primitives/primitives.js';

export interface StartingParticipantSelection {
  mode: StartingParticipantMode;
  valid: boolean;
  starting_agent?: StartingAgent;
  starting_session?: StartingSession;
}

export function StartingParticipantControls(props: {
  adapters: AdapterRegistration[];
  advanced: AdapterRegistration[];
  cwd: string;
  owner: { handle: string } | undefined;
  idPrefix: string;
  onChange: (selection: StartingParticipantSelection) => void;
  onRefresh: () => void;
  refreshing: boolean;
  refreshError?: string;
}) {
  const id = props.idPrefix;
  const all = useMemo(
    () => [...props.adapters, ...props.advanced],
    [props.adapters, props.advanced],
  );
  const [mode, setMode] = useState<StartingParticipantMode>('none');
  const [config, setConfig] = useState<AgentConfig>({
    harness: '', model: '', thinking: '', policy: DEFAULT_POLICY,
  });
  // Preserve the existing create-channel default exactly; the presentation can
  // capitalize it elsewhere, while the stable value keeps the derived @codor
  // identity and existing operator expectations unchanged.
  const [agentName, setAgentName] = useState('codor');
  const [purpose, setPurpose] = useState('');
  const [joinHarnessChoice, setJoinHarnessChoice] = useState<JoinHarnessChoice>('codex');
  const [customJoinHarness, setCustomJoinHarness] = useState('');
  const [sessionRef, setSessionRef] = useState('');
  const [joinOwnership, setJoinOwnership] = useState<'fork' | 'mirror'>('fork');
  const initialJoinPreset = SPAWN_PRESETS.find((preset) => preset.id === 'reviewer');
  const [joinRole, setJoinRole] = useState(initialJoinPreset?.id ?? 'reviewer');
  const [joinHandle, setJoinHandle] = useState(initialJoinPreset?.handle ?? 'reviewer');
  const [joinPurpose, setJoinPurpose] = useState(initialJoinPreset?.purpose ?? '');
  const [customRole, setCustomRole] = useState('');
  const [otherParticipant, setOtherParticipant] = useState('');

  const connectorHarness = connectorHarnessFor(mode);
  const connectorAdapter = configuredConnector(mode, props.adapters);
  const connectorReady = connectorAdapter !== undefined;
  const spawnMode = mode === 'new' || connectorReady;
  const spawnAdapters = useMemo(
    () => connectorHarness === undefined
      ? all
      : connectorAdapter === undefined ? [] : [connectorAdapter],
    [all, connectorAdapter, connectorHarness],
  );
  const harness = effectiveHarness(config.harness, spawnAdapters);

  useEffect(() => {
    if (!spawnMode || config.harness === harness) return;
    setConfig(reconcileConfig(config, harness, spawnAdapters));
  }, [config, harness, spawnAdapters, spawnMode]);

  const effectiveAgentName = agentName.trim() === '' ? 'Agent' : agentName.trim();
  const agentHandle = useMemo(
    () => deriveAssignableHandle(effectiveAgentName),
    [effectiveAgentName],
  );
  const agentOwnerClash = agentHandle !== undefined && collidesWithOwner(agentHandle, props.owner);
  const acpLaunch = useMemo(
    () => acpLaunchFromConfig({ ...config, harness }),
    [config, harness],
  );
  const agentValid = spawnMode
    && harness !== ''
    && props.cwd.trim() !== ''
    && agentHandle !== undefined
    && !agentOwnerClash
    && (connectorHarness === undefined || config.model.trim() !== '')
    && (harness !== 'acp' || acpLaunch !== undefined);

  const joinHarness = joinHarnessChoice === 'other'
    ? customJoinHarness.trim()
    : joinHarnessChoice;
  const effectiveJoinOwnership = joinHarnessChoice === 'other' ? 'mirror' : joinOwnership;
  const joinOwnerClash = collidesWithOwner(joinHandle.trim(), props.owner);
  const joinValid = mode === 'existing'
    && props.cwd.trim() !== ''
    && joinHarness !== ''
    && isValidSessionRef(joinHarness, sessionRef)
    && deriveAssignableHandle(joinHandle.trim()) === joinHandle.trim()
    && !joinOwnerClash;

  const selection = useMemo<StartingParticipantSelection>(() => {
    if (mode === 'none') return { mode, valid: true };
    if (agentValid && agentHandle !== undefined) {
      const selector = resolveSelector(harness);
      const thinking = supportedThinking(
        spawnAdapters.find((adapter) => adapter.id === harness),
        config.thinking,
      );
      const trimmedPurpose = purpose.trim();
      return {
        mode,
        valid: true,
        starting_agent: {
          harness: selector.harness,
          handle: agentHandle,
          display_name: effectiveAgentName,
          policy: config.policy === '' ? DEFAULT_POLICY : config.policy,
          ...(selector.acp_provider !== undefined && { acp_provider: selector.acp_provider }),
          ...(acpLaunch !== undefined && { acp_launch: acpLaunch }),
          ...(selector.harness !== 'acp' && config.model !== '' && { model: config.model }),
          ...(thinking !== undefined && { thinking }),
          ...(trimmedPurpose !== '' && { purpose: trimmedPurpose }),
          ...(config.colorHue !== undefined && { color_hue: config.colorHue }),
        },
      };
    }
    if (joinValid) {
      const trimmedPurpose = (
        joinRole === 'other' && customRole.trim() !== ''
          ? `Role: ${customRole.trim()}.\n\n${joinPurpose.trim()}`
          : joinPurpose
      ).trim();
      return {
        mode,
        valid: true,
        starting_session: {
          harness: joinHarness,
          handle: joinHandle.trim(),
          session_ref: sessionRef.trim(),
          ownership: effectiveJoinOwnership,
          policy: DEFAULT_POLICY,
          ...(trimmedPurpose !== '' && { purpose: trimmedPurpose }),
          ...(config.colorHue !== undefined && { color_hue: config.colorHue }),
        },
      };
    }
    return { mode, valid: false };
  }, [
    acpLaunch,
    agentHandle,
    agentValid,
    config.model,
    config.policy,
    config.thinking,
    config.colorHue,
    customRole,
    effectiveAgentName,
    harness,
    joinHandle,
    joinHarness,
    effectiveJoinOwnership,
    joinPurpose,
    joinRole,
    joinValid,
    mode,
    purpose,
    sessionRef,
    spawnAdapters,
  ]);
  const onChangeRef = useRef(props.onChange);
  useEffect(() => { onChangeRef.current = props.onChange; }, [props.onChange]);
  useEffect(() => { onChangeRef.current(selection); }, [selection]);

  return (
    <div className="nx-agent-panel">
      <label className="nx-field nx-participant-mode">
        <span className="nx-label">What should join this channel?</span>
        <select
          value={mode}
          onChange={(event) => {
            const next = event.target.value as StartingParticipantMode;
            setMode(next);
            if (next === 'ollama' || next === 'nvidia') {
              setConfig({
                harness: next,
                model: '',
                thinking: '',
                policy: DEFAULT_POLICY,
              });
              setAgentName(next === 'ollama' ? 'Local model' : 'NVIDIA model');
            }
          }}
          data-testid={`${id}-participant-mode`}
        >
          <option value="none">No participant yet</option>
          <option value="new">New agent</option>
          <option value="existing">Existing Codex or Claude session</option>
          <option value="ollama">Ollama local model</option>
          <option value="nvidia">NVIDIA-hosted model</option>
          <option value="codex-cloud">Codex Cloud task</option>
          <option value="other">Other…</option>
        </select>
        <span className="nx-field-note">
          Only actions this Codor host can actually perform are enabled.
        </span>
      </label>

      {mode === 'none' && (
        <p className="nx-field-note" data-testid={`${id}-participant-none-note`}>
          You can add participants from the channel at any time.
        </p>
      )}

      {spawnMode && (
        <>
          {connectorHarness !== undefined && (
            <div className="nx-participant-trust" data-testid={`${id}-${connectorHarness}-bridge-note`}>
              <strong>{connectorHarness === 'ollama' ? 'Local bridge' : 'Hosted bridge'} · chat-only</strong>
              <span>
                {connectorHarness === 'ollama'
                  ? 'Runs through Ollama on this Mac. It receives conversation text, no filesystem tools, and requires an exact model.'
                  : 'Retrieves a dedicated NVIDIA credential from the Codor host Keychain only when a turn runs. It receives conversation text, no filesystem tools, and requires an exact model.'}
              </span>
            </div>
          )}
          <AgentIdentityControls
            adapters={connectorAdapter === undefined ? props.adapters : [connectorAdapter]}
            advanced={connectorAdapter === undefined ? props.advanced : []}
            config={{ ...config, harness }}
            onChange={setConfig}
            idPrefix={id}
            onRefresh={props.onRefresh}
            refreshing={props.refreshing}
            refreshError={props.refreshError}
          />
          <ParticipantColorPicker
            value={config.colorHue}
            onChange={(colorHue) => setConfig({ ...config, colorHue })}
            idPrefix={id}
          />
          <label className="nx-field">
            <span className="nx-label">Agent name</span>
            <input
              value={agentName}
              onChange={(event) => setAgentName(event.target.value)}
              placeholder="e.g. Orchestrator"
              data-testid={`${id}-agent-name`}
            />
            {agentHandle !== undefined && !agentOwnerClash
              ? <span className="nx-field-note">joins as <Code>@{agentHandle}</Code></span>
              : agentOwnerClash
                ? (
                  <span className="nx-field-note is-error" data-testid={`${id}-owner-clash`}>
                    @{agentHandle} is already in use by the channel owner.
                  </span>
                )
                : <span className="nx-field-note is-error">Choose a name that produces a usable handle.</span>}
          </label>
          <RolePresetControls
            idPrefix={id}
            onApply={(preset) => {
              setAgentName(preset.handle);
              setPurpose(preset.purpose);
              setConfig({
                ...config,
                harness,
                policy: preset.policy,
                thinking: supportedThinking(
                  spawnAdapters.find((adapter) => adapter.id === harness),
                  preset.thinking,
                ) ?? '',
              });
            }}
          />
          <AgentControls
            adapters={spawnAdapters}
            config={{ ...config, harness }}
            onChange={setConfig}
            hideHarness
            embedded
            behaviourSection={3}
            permissionsSection={4}
            idPrefix={id}
          />
          <label className="nx-field">
            <span className="nx-label">Assignment and operating instructions <span className="nx-opt">· optional</span></span>
            <textarea
              value={purpose}
              rows={3}
              onChange={(event) => setPurpose(event.target.value)}
              placeholder="Define the objective, responsibilities, boundaries, collaboration behavior, expected output, and verification."
              data-testid={`${id}-purpose`}
            />
          </label>
        </>
      )}

      {mode === 'existing' && (
        <>
          <label className="nx-field">
            <span className="nx-label">Session type</span>
            <select
              value={joinHarnessChoice}
              onChange={(event) => setJoinHarnessChoice(event.target.value as JoinHarnessChoice)}
              data-testid={`${id}-join-harness`}
            >
              <option value="codex">Codex CLI session</option>
              <option value="claude-code">Claude Code session</option>
              <option value="other">Other native adapter…</option>
            </select>
          </label>
          {joinHarnessChoice === 'other' && (
            <label className="nx-field">
              <span className="nx-label">Adapter ID</span>
              <input
                value={customJoinHarness}
                onChange={(event) => setCustomJoinHarness(event.target.value)}
                placeholder="e.g. my-native-adapter"
                required
                data-testid={`${id}-join-custom-harness`}
              />
            </label>
          )}
          <label className="nx-field">
            <span className="nx-label">Full session UUID or reference</span>
            <input
              value={sessionRef}
              onChange={(event) => setSessionRef(event.target.value)}
              placeholder={joinHarnessChoice === 'other'
                ? 'Paste the adapter’s complete session reference'
                : 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'}
              autoComplete="off"
              spellCheck={false}
              required
              aria-invalid={sessionRef !== '' && !isValidSessionRef(joinHarness, sessionRef)}
              data-testid={`${id}-join-session-ref`}
            />
            <span className="nx-field-note">The complete value is never shortened or reformatted.</span>
          </label>
          {sessionRef !== '' && !isValidSessionRef(joinHarness, sessionRef) && (
            <p className="nx-field-note is-error" role="alert" data-testid={`${id}-join-session-error`}>
              {joinHarnessChoice === 'other'
                ? 'Enter the complete session reference.'
                : 'Codex and Claude session IDs use the full 36-character UUID format.'}
            </p>
          )}
          {joinHarnessChoice !== 'other' && (
            <label className="nx-field">
              <span className="nx-label">How Codor should connect</span>
              <select
                value={joinOwnership}
                onChange={(event) => setJoinOwnership(event.target.value as 'fork' | 'mirror')}
                data-testid={`${id}-join-ownership`}
              >
                <option value="fork">Fork a copy into Codor — recommended</option>
                <option value="mirror">Mirror the live terminal — read-only</option>
              </select>
            </label>
          )}
          <label className="nx-field">
            <span className="nx-label">Role</span>
            <select
              value={joinRole}
              onChange={(event) => {
                const next = event.target.value;
                setJoinRole(next);
                if (next === 'other') {
                  setJoinHandle('');
                  setJoinPurpose('');
                  return;
                }
                const preset = SPAWN_PRESETS.find((candidate) => candidate.id === next);
                if (preset !== undefined) {
                  setJoinHandle(preset.handle);
                  setJoinPurpose(preset.purpose);
                }
              }}
              data-testid={`${id}-join-role`}
            >
              {SPAWN_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.label} — {preset.blurb}</option>
              ))}
              <option value="other">Other…</option>
            </select>
          </label>
          {joinRole === 'other' && (
            <label className="nx-field">
              <span className="nx-label">Custom role</span>
              <input
                value={customRole}
                onChange={(event) => setCustomRole(event.target.value)}
                placeholder="e.g. Architect"
                data-testid={`${id}-join-custom-role`}
              />
            </label>
          )}
          <label className="nx-field">
            <span className="nx-label">Channel handle</span>
            <input
              value={joinHandle}
              onChange={(event) => setJoinHandle(event.target.value)}
              placeholder="e.g. orchestrator"
              required
              data-testid={`${id}-join-handle`}
            />
            <span className="nx-field-note">Other participants will address this session as @{joinHandle || 'handle'}.</span>
            {joinOwnerClash && (
              <span className="nx-field-note is-error" data-testid={`${id}-join-owner-clash`}>
                @{joinHandle} is already in use by the channel owner.
              </span>
            )}
          </label>
          <label className="nx-field">
            <span className="nx-label">Assignment and operating instructions <span className="nx-opt">· optional</span></span>
            <textarea
              value={joinPurpose}
              rows={3}
              onChange={(event) => setJoinPurpose(event.target.value)}
              placeholder="Define the objective, responsibilities, boundaries, when to @mention others, expected output, and verification."
              data-testid={`${id}-join-purpose`}
            />
          </label>
          <ParticipantColorPicker
            value={config.colorHue}
            onChange={(colorHue) => setConfig({ ...config, colorHue })}
            idPrefix={`${id}-join`}
          />
          <div className="nx-participant-trust" data-testid={`${id}-join-custody-note`}>
            {effectiveJoinOwnership === 'fork' ? (
              <>
                <strong>Forked copy · Codor-controlled</strong>
                <span>The original terminal stays open and unchanged. Codor creates a separate copy on the first message.</span>
              </>
            ) : (
              <>
                <strong>Mirrored · read-only</strong>
                <span>The native terminal keeps control. Messages wait until that terminal hands over custody.</span>
              </>
            )}
          </div>
        </>
      )}

      {mode !== 'none' && mode !== 'new' && mode !== 'existing' && !connectorReady && (
        <div className="nx-connector-guide" data-testid={`${id}-connector-guide-${mode}`}>
          <div className="nx-connector-guide-head">
            <span>{PARTICIPANT_MODE_COPY[mode].title}</span>
            <StatusPill tone="warn">{PARTICIPANT_MODE_COPY[mode].status}</StatusPill>
          </div>
          <p>{PARTICIPANT_MODE_COPY[mode].body}</p>
          <p className="nx-field-note">{PARTICIPANT_MODE_COPY[mode].detail}</p>
          {mode === 'other' && (
            <label className="nx-field">
              <span className="nx-label">Provider or runtime</span>
              <input
                value={otherParticipant}
                onChange={(event) => setOtherParticipant(event.target.value)}
                placeholder="Tell Codor what you want to connect"
                data-testid={`${id}-other-participant`}
              />
            </label>
          )}
        </div>
      )}
    </div>
  );
}
