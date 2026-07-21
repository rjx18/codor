/**
 * The one place an agent's harness, model, thinking level and policy are chosen.
 *
 * Legacy holds this as an invariant (`agent-controls-shared-by-both-dialogs`) and
 * web-next lost it, ending up with three hand-rolled forms that disagreed with
 * each other and with the protocol. Every consumer — spawn, channel-create and
 * member configure — renders this, so a fix lands once.
 *
 * Everything here is driven by what the adapter reports. Nothing about policies
 * or thinking levels is written down in this file; a source guard fails the build
 * if a literal list reappears.
 */
import { Ban, LoaderCircle, Lock, PencilLine, RefreshCw, Zap } from 'lucide-react';
import { useState } from 'react';

import { ThinkingSlider } from './ThinkingSlider.js';
import {
  POLICIES,
  SPAWN_PRESETS,
  type AdapterLike,
  type AgentConfig,
  type SpawnPreset,
  reconcileConfig,
  thinkingLevelsFor,
} from './agent-spec.js';
import { harnessLabel, harnessMark } from './harness-marks.js';

/** Compact titles. The mapping a harness actually applies is read from the
 *  adapter and shown beneath, because that is the safety-relevant part. */
const POLICY_COPY: Record<string, { title: string; icon: typeof Lock }> = {
  'read-only': { title: 'Read only', icon: Lock },
  'workspace-write': { title: 'Edit', icon: PencilLine },
  'full-access': { title: 'Full access', icon: Zap },
};

/** Past this many models the list gets a search field. opencode reports ~80. */
const SEARCH_THRESHOLD = 8;

/** A numbered section header with its hairline rule. */
export function Section(props: {
  n: number;
  title: string;
  children: React.ReactNode;
  headingLevel?: 2 | 3;
}) {
  const Heading = props.headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className="nx-sec">
      <div className="nx-sec-head">
        <span className="nx-sec-n" aria-hidden="true">{props.n}</span>
        <Heading className="nx-sec-title">{props.title}</Heading>
        <span className="nx-sec-rule" aria-hidden="true" />
      </div>
      {props.children}
    </section>
  );
}

/** The shared role + harness portion of an agent identity.
 *
 * Spawn places this inside its numbered Identity section. Create adds a real
 * `None` choice and places it inside Starting agent. Configure uses the same
 * picker locked, so the three dialogs cannot drift back into separate forms.
 */
export function AgentIdentityControls(props: {
  adapters: readonly AdapterLike[];
  config: AgentConfig;
  onChange: (next: AgentConfig) => void;
  lockHarness?: boolean;
  allowNone?: boolean;
  optional?: boolean;
  idPrefix?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshError?: string;
}) {
  const id = props.idPrefix ?? 'agent';
  return (
    <>
      <div className="nx-field">
        <div className="nx-harness-head">
          <span className="nx-label">
            Harness {props.optional === true && <span className="nx-opt">· optional</span>}
          </span>
          {props.onRefresh !== undefined && (
            <button type="button" className="nx-harness-refresh"
              disabled={props.refreshing === true}
              data-testid={`${id}-refresh-adapters`}
              onClick={props.onRefresh}>
              {props.refreshing === true
                ? <LoaderCircle size={14} className="nx-spin" aria-hidden="true" />
                : <RefreshCw size={14} aria-hidden="true" />}
              {props.refreshing === true ? 'Refreshing…' : 'Refresh'}
            </button>
          )}
        </div>
        {props.adapters.length === 0 && (
          <p className="nx-note" role="status">No supported harnesses found</p>
        )}
        {props.refreshError !== undefined && (
          <p className="nx-field-note is-error" role="alert">Refresh failed: {props.refreshError}</p>
        )}
          <div className="nx-harness-grid" role="group" aria-label="Harness">
            {props.allowNone === true && (
              <button
                type="button"
                className="nx-harness"
                aria-pressed={props.config.harness === ''}
                data-testid={`${id}-harness-none`}
                onClick={() => { props.onChange({ ...props.config, harness: '', model: '', thinking: '' }); }}
              >
                <Ban size={22} aria-hidden="true" />
                <span className="nx-harness-name">None</span>
                <span className="nx-check" aria-hidden="true" />
              </button>
            )}
            {props.adapters.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className="nx-harness"
                aria-pressed={candidate.id === props.config.harness}
                disabled={props.lockHarness === true}
                data-testid={`${id}-harness-${candidate.id}`}
                onClick={() => {
                  props.onChange(reconcileConfig(props.config, candidate.id, props.adapters));
                }}
              >
                {harnessMark(candidate.id)}
                <span className="nx-harness-name">{harnessLabel(candidate.id)}</span>
                {candidate.capabilities.resume === false && (
                  <span className="nx-harness-sub">ephemeral</span>
                )}
                <span className="nx-check" aria-hidden="true" />
              </button>
            ))}
          </div>
      </div>

    </>
  );
}

/** Optional role shortcuts stay in Identity after its primary fields, preserving
 * the reference order: Harness → Handle → Working directory. */
export function RolePresetControls(props: {
  onApply: (preset: SpawnPreset) => void;
  idPrefix?: string;
}) {
  const id = props.idPrefix ?? 'agent';
  return (
    <div className="nx-field">
      <span className="nx-label">Preset <span className="nx-opt">· optional</span></span>
      <div className="nx-tile-row" role="group" aria-label="Preset">
        {SPAWN_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="nx-tile nx-preset"
            data-testid={`${id}-preset-${preset.id}`}
            onClick={() => { props.onApply(preset); }}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function AgentControls(props: {
  adapters: readonly AdapterLike[];
  config: AgentConfig;
  onChange: (next: AgentConfig) => void;
  /** Configure-an-existing-member cannot change harness. */
  lockHarness?: boolean;
  /** Channel-create picks the harness in its own "starting agent" row. */
  hideHarness?: boolean;
  /** Section number for Behaviour; the host dialog owns the numbering. */
  behaviourSection: number;
  permissionsSection: number;
  /** Create embeds behaviour and permissions in Starting agent, without adding
   *  nested numbered sections that do not exist in the reference. */
  embedded?: boolean;
  idPrefix?: string;
}) {
  const { adapters, config } = props;
  const id = props.idPrefix ?? 'agent';
  const adapter = adapters.find((candidate) => candidate.id === config.harness);
  const models = adapter?.models ?? [];
  const levels = thinkingLevelsFor(adapter);
  const [modelQuery, setModelQuery] = useState('');

  const set = (patch: Partial<AgentConfig>) => { props.onChange({ ...config, ...patch }); };

  const query = modelQuery.trim().toLowerCase();
  const shown = query === '' ? models : models.filter((m) => m.toLowerCase().includes(query));

  const behaviour = (
    <>
      <div className="nx-field">
        <span className="nx-label">Model</span>
        {models.length === 0 ? (
          <>
            <input
              className="nx-input"
              value={config.model}
              onChange={(e) => { set({ model: e.target.value }); }}
              placeholder="harness default"
              aria-label="Model"
              data-testid={`${id}-model-input`}
            />
            <p className="nx-note">This harness did not report a model list.</p>
          </>
        ) : (
          <>
            {models.length > SEARCH_THRESHOLD && (
              <input
                className="nx-input"
                value={modelQuery}
                onChange={(e) => { setModelQuery(e.target.value); }}
                placeholder={`Search ${String(models.length)} models…`}
                aria-label="Search models"
                data-testid={`${id}-model-search`}
              />
            )}
            <div className="nx-list" role="group" aria-label="Model" data-testid={`${id}-model-list`}>
              <button
                type="button"
                aria-pressed={config.model === ''}
                className="nx-list-row"
                data-testid={`${id}-model-default`}
                onClick={() => { set({ model: '' }); }}
              >
                <span>Default</span>
                <span className="nx-list-sub">harness pick</span>
                <span className="nx-check" aria-hidden="true" />
              </button>
              {shown.map((model) => (
                <button
                  key={model}
                  type="button"
                  aria-pressed={config.model === model}
                  className="nx-list-row"
                  data-testid={`${id}-model-${model}`}
                  onClick={() => { set({ model }); }}
                >
                  <span className="nx-mono">{model}</span>
                  <span className="nx-check" aria-hidden="true" />
                </button>
              ))}
              {shown.length === 0 && <p className="nx-note">No model matches that search.</p>}
            </div>
            {/* Never trap the operator in the reported list: a catalogue can lag
                a model that already works. */}
            <input
              className="nx-input"
              value={config.model}
              onChange={(e) => { set({ model: e.target.value }); }}
              placeholder="or type an exact model id"
              aria-label="Custom model"
              data-testid={`${id}-model-custom`}
            />
          </>
        )}
      </div>

      <div className="nx-field">
        <span className="nx-label">Thinking effort</span>
        {levels.length === 0 ? (
          <p className="nx-note" data-testid={`${id}-thinking-unsupported`}>
            Not supported by this harness.
          </p>
        ) : (
          <ThinkingSlider
            levels={levels}
            value={config.thinking}
            onChange={(thinking) => { set({ thinking }); }}
            idPrefix={id}
          />
        )}
      </div>
    </>
  );

  const permissions = (
    <>
      <div className="nx-perm-row" role="group" aria-label="Permissions">
        {POLICIES.map((policy) => {
          const copy = POLICY_COPY[policy];
          const Icon = copy?.icon ?? Lock;
          const native = adapter?.capabilities.policies?.[policy];
          return (
            <button
              key={policy}
              type="button"
              className="nx-perm"
              aria-pressed={config.policy === policy}
              data-testid={`${id}-policy-${policy}`}
              onClick={() => { set({ policy }); }}
            >
              <Icon size={16} aria-hidden="true" />
              <span className="nx-perm-title">{copy?.title ?? policy}</span>
              <span className={native == null ? 'nx-perm-native is-deferred' : 'nx-perm-native'}>
                {adapter === undefined ? '' : native ?? 'not enforced'}
              </span>
              <span className="nx-check" aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {adapter !== undefined && config.policy !== ''
        && adapter.capabilities.policies?.[config.policy] === null && (
        <p className="nx-note is-warn" role="status" data-testid={`${id}-policy-deferred`}>
          {harnessLabel(adapter.id)} does not enforce this setting — it defers to however
          that harness is configured. Only Full access changes anything here.
        </p>
      )}
      {adapter?.capabilities.approvals === 'spawn-time' && (
        <p className="nx-note" role="status">
          Approval policy is fixed when this harness starts; in-turn approval cards
          are unavailable.
        </p>
      )}
    </>
  );

  return (
    <>
      {props.hideHarness !== true && (
        <AgentIdentityControls
          adapters={adapters}
          config={config}
          onChange={props.onChange}
          lockHarness={props.lockHarness}
          idPrefix={id}
        />
      )}

      {props.embedded === true
        ? <div className="nx-agent-embedded-group">{behaviour}</div>
        : <Section n={props.behaviourSection} title="Behaviour">{behaviour}</Section>}

      {props.embedded === true
        ? <div className="nx-agent-embedded-group">{permissions}</div>
        : <Section n={props.permissionsSection} title="Permissions">{permissions}</Section>}
    </>
  );
}
