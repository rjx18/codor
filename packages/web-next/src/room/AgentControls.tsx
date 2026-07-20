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
import { Lock, PencilLine, Zap } from 'lucide-react';
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
export function Section(props: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="nx-sec">
      <div className="nx-sec-head">
        <span className="nx-sec-n" aria-hidden="true">{props.n}</span>
        <h3 className="nx-sec-title">{props.title}</h3>
        <span className="nx-sec-rule" aria-hidden="true" />
      </div>
      {props.children}
    </section>
  );
}

export function AgentControls(props: {
  adapters: readonly AdapterLike[];
  config: AgentConfig;
  onChange: (next: AgentConfig) => void;
  /** Spawn offers one-click roles; configure and channel-create do not. */
  presets?: { onApply: (preset: SpawnPreset) => void };
  /** Configure-an-existing-member cannot change harness. */
  lockHarness?: boolean;
  /** Channel-create picks the harness in its own "starting agent" row. */
  hideHarness?: boolean;
  /** Section number for Behaviour; the host dialog owns the numbering. */
  behaviourSection: number;
  permissionsSection: number;
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

  return (
    <>
      {props.presets !== undefined && (
        <div className="nx-field">
          <span className="nx-label">Role <span className="nx-opt">· optional</span></span>
          <div className="nx-tile-row" role="group" aria-label="Role preset">
            {SPAWN_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="nx-tile is-compact"
                data-testid={`${id}-preset-${preset.id}`}
                onClick={() => { props.presets?.onApply(preset); }}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {props.hideHarness !== true && (
        <div className="nx-field">
          <span className="nx-label">Harness</span>
          {adapters.length === 0 ? (
            <p className="nx-note" role="status">Discovering harnesses…</p>
          ) : (
            <div className="nx-harness-grid" role="group" aria-label="Harness">
              {adapters.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  className="nx-harness"
                  aria-pressed={candidate.id === config.harness}
                  disabled={props.lockHarness === true}
                  data-testid={`${id}-harness-${candidate.id}`}
                  onClick={() => { props.onChange(reconcileConfig(config, candidate.id, adapters)); }}
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
          )}
        </div>
      )}

      <Section n={props.behaviourSection} title="Behaviour">
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
              <div className="nx-list" role="listbox" aria-label="Model" data-testid={`${id}-model-list`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={config.model === ''}
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
                    role="option"
                    aria-selected={config.model === model}
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
            // Stated, not hidden: the absence is the information.
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
      </Section>

      <Section n={props.permissionsSection} title="Permissions">
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
                {/* What the harness will actually do. Someone choosing "Read only"
                    on a harness that does not enforce it deserves to know. */}
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
      </Section>
    </>
  );
}
