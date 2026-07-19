/**
 * The one place an agent's harness, model, thinking level and policy are chosen.
 *
 * Legacy holds this as an invariant (`agent-controls-shared-by-both-dialogs`) and
 * web-next lost it, ending up with three hand-rolled forms that disagreed with each
 * other and with the protocol. Every consumer — spawn, channel-create and member
 * configure — renders this, so a fix lands once.
 *
 * Everything here is driven by what the adapter reports. Nothing about policies or
 * thinking levels is written down in this file.
 */
import { Cpu, Gauge, Lock, PencilLine, ShieldCheck, Zap } from 'lucide-react';
import { useState } from 'react';

import {
  POLICIES,
  type AdapterLike,
  type AgentConfig,
  reconcileConfig,
  thinkingLevelsFor,
} from './agent-spec.js';

/** Human framing for each policy. The mapping a harness actually applies is read
 *  from the adapter and shown beneath, because that is the safety-relevant part. */
const POLICY_COPY: Record<string, { title: string; blurb: string; icon: typeof Lock }> = {
  'read-only': { title: 'Read only', blurb: 'Reads files and plans. No edits, no commands.', icon: Lock },
  'workspace-write': { title: 'Edit workspace', blurb: 'Edits files and runs commands in the project.', icon: PencilLine },
  'full-access': { title: 'Full access', blurb: 'Skips permission prompts entirely. Trusted tasks only.', icon: Zap },
};

/** Past this many models a list stops being scannable and becomes a search box.
 *  opencode reports around eighty. */
const BROWSE_LIMIT = 8;

export function AgentControls(props: {
  adapters: readonly AdapterLike[];
  config: AgentConfig;
  onChange: (next: AgentConfig) => void;
  /** Configure-an-existing-member cannot change harness. */
  lockHarness?: boolean;
  idPrefix?: string;
}) {
  const { adapters, config } = props;
  const id = props.idPrefix ?? 'agent';
  const adapter = adapters.find((candidate) => candidate.id === config.harness);
  const models = adapter?.models ?? [];
  const levels = thinkingLevelsFor(adapter);
  const [customModel, setCustomModel] = useState(false);
  const [modelQuery, setModelQuery] = useState('');

  const set = (patch: Partial<AgentConfig>) => props.onChange({ ...config, ...patch });

  const shown = modelQuery.trim() === ''
    ? models
    : models.filter((m) => m.toLowerCase().includes(modelQuery.trim().toLowerCase()));

  return (
    <div className="nx-agent-controls">
      {/* ── Harness ─────────────────────────────────────────────────────── */}
      <fieldset className="nx-control-group" disabled={props.lockHarness === true}>
        <legend>Harness</legend>
        {adapters.length === 0 ? (
          <p className="nx-control-note" role="status">Discovering harnesses…</p>
        ) : (
          <div className="nx-tile-row" role="group" aria-label="Harness">
            {adapters.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className="nx-tile"
                aria-pressed={candidate.id === config.harness}
                data-testid={`${id}-harness-${candidate.id}`}
                onClick={() => props.onChange(reconcileConfig(config, candidate.id, adapters))}
              >
                <Cpu size={16} aria-hidden="true" />
                <span className="nx-tile-name">{candidate.id}</span>
                {candidate.capabilities.resume === false && (
                  // Worth knowing before you spawn: this one cannot be resumed.
                  <span className="nx-tile-badge">ephemeral</span>
                )}
              </button>
            ))}
          </div>
        )}
      </fieldset>

      {/* ── Model ───────────────────────────────────────────────────────── */}
      <fieldset className="nx-control-group">
        <legend>Model</legend>
        {models.length === 0 ? (
          <>
            <input
              className="nx-input"
              value={config.model}
              onChange={(e) => set({ model: e.target.value })}
              placeholder="harness default"
              aria-label="Model"
              data-testid={`${id}-model-input`}
            />
            <p className="nx-control-note">This harness did not report a model list.</p>
          </>
        ) : models.length > BROWSE_LIMIT ? (
          <>
            <input
              className="nx-input"
              value={modelQuery}
              onChange={(e) => setModelQuery(e.target.value)}
              placeholder={`Search ${String(models.length)} models…`}
              aria-label="Search models"
              data-testid={`${id}-model-search`}
            />
            <div className="nx-tile-row nx-tile-row-scroll" role="group" aria-label="Model">
              <button type="button" className="nx-tile" aria-pressed={config.model === ''}
                onClick={() => set({ model: '' })}>Default</button>
              {shown.slice(0, 40).map((m) => (
                <button key={m} type="button" className="nx-tile" aria-pressed={config.model === m}
                  onClick={() => set({ model: m })}>{m}</button>
              ))}
            </div>
            <input
              className="nx-input"
              value={config.model}
              onChange={(e) => set({ model: e.target.value })}
              placeholder="or type an exact model id"
              aria-label="Custom model"
              data-testid={`${id}-model-custom`}
            />
          </>
        ) : (
          <>
            <div className="nx-tile-row" role="group" aria-label="Model">
              <button type="button" className="nx-tile" aria-pressed={config.model === '' && !customModel}
                data-testid={`${id}-model-default`}
                onClick={() => { setCustomModel(false); set({ model: '' }); }}>
                <span className="nx-tile-name">Default</span>
                <span className="nx-tile-sub">harness pick</span>
              </button>
              {models.map((m) => (
                <button key={m} type="button" className="nx-tile" aria-pressed={config.model === m}
                  data-testid={`${id}-model-${m}`}
                  onClick={() => { setCustomModel(false); set({ model: m }); }}>
                  <span className="nx-tile-name">{m}</span>
                </button>
              ))}
              {/* Never trap the operator in the reported list: an adapter's catalogue
                  can lag a model that already works. */}
              <button type="button" className="nx-tile" aria-pressed={customModel}
                data-testid={`${id}-model-custom-toggle`}
                onClick={() => { setCustomModel(true); set({ model: '' }); }}>Custom…</button>
            </div>
            {customModel && (
              <input
                className="nx-input"
                autoFocus
                value={config.model}
                onChange={(e) => set({ model: e.target.value })}
                placeholder="exact model id"
                aria-label="Custom model"
                data-testid={`${id}-model-custom`}
              />
            )}
          </>
        )}
      </fieldset>

      {/* ── Thinking ────────────────────────────────────────────────────── */}
      <fieldset className="nx-control-group" disabled={levels.length === 0}>
        <legend>Thinking</legend>
        <div className="nx-tile-row" role="group" aria-label="Thinking level">
          <button type="button" className="nx-tile" aria-pressed={config.thinking === ''}
            data-testid={`${id}-thinking-default`}
            onClick={() => set({ thinking: '' })}>
            <Gauge size={16} aria-hidden="true" /><span className="nx-tile-name">Default</span>
          </button>
          {levels.map((level) => (
            <button key={level} type="button" className="nx-tile" aria-pressed={config.thinking === level}
              data-testid={`${id}-thinking-${level}`}
              onClick={() => set({ thinking: level })}>
              <span className="nx-tile-name">{level}</span>
            </button>
          ))}
        </div>
        {levels.length === 0 && (
          // Disabled rather than hidden: the absence is the information.
          <p className="nx-control-note" data-testid={`${id}-thinking-unsupported`}>
            Not supported by this harness.
          </p>
        )}
      </fieldset>

      {/* ── Permissions ─────────────────────────────────────────────────── */}
      <fieldset className="nx-control-group">
        <legend>Permissions</legend>
        <div className="nx-card-row" role="group" aria-label="Permissions">
          {POLICIES.map((policy) => {
            const copy = POLICY_COPY[policy];
            const Icon = copy?.icon ?? ShieldCheck;
            const native = adapter?.capabilities.policies?.[policy];
            return (
              <button
                key={policy}
                type="button"
                className="nx-policy-card"
                aria-pressed={config.policy === policy}
                data-testid={`${id}-policy-${policy}`}
                onClick={() => set({ policy })}
              >
                <Icon size={17} aria-hidden="true" />
                <span className="nx-policy-title">{copy?.title ?? policy}</span>
                <span className="nx-policy-blurb">{copy?.blurb ?? ''}</span>
                {/* What the harness will actually do. A user choosing "Read only" on a
                    harness that does not enforce it deserves to be told. */}
                <span className={native == null ? 'nx-policy-native is-deferred' : 'nx-policy-native'}>
                  {adapter === undefined ? '' : native ?? 'not enforced by this harness'}
                </span>
              </button>
            );
          })}
        </div>
        {adapter !== undefined && config.policy !== '' && adapter.capabilities.policies?.[config.policy] === null && (
          // The protocol marks null as the safety-critical value: the harness makes
          // no distinction here, so this choice changes nothing. Saying so is the
          // whole point — an operator picking "Read only" on such a harness is not
          // getting read-only.
          <p className="nx-control-note is-warn" role="status" data-testid={`${id}-policy-deferred`}>
            {adapter.id} does not enforce this setting — it defers to however that
            harness is configured. Only Full access changes anything here.
          </p>
        )}
        {adapter?.capabilities.approvals === 'spawn-time' && (
          <p className="nx-control-note" role="status">
            Approval policy is fixed when this harness starts; in-turn approval cards are unavailable.
          </p>
        )}
      </fieldset>
    </div>
  );
}
