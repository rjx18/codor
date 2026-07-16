import { DEFAULT_THINKING_LEVELS, PolicySchema, type Policy, type ThinkingLevel } from '@codor/protocol';
import { Bot, Box, Cat, Sparkles, SquareTerminal, Terminal, type LucideIcon } from 'lucide-react';
import { useState } from 'react';

import type { AdapterRegistration } from './api.js';

const HARNESS_ICONS: Record<string, LucideIcon> = {
  'claude-code': Sparkles,
  codex: SquareTerminal,
  gemini: Bot,
  copilot: Cat,
  opencode: Terminal,
};

/** Past this many, a button row stops being a row. opencode reports ~79. */
const ROW_LIMIT = 8;

export interface AgentControlsValue {
  harness: string;
  model: string;
  thinking: ThinkingLevel | '';
  policy: Policy;
}

/** What the operator is choosing, in their words rather than the enum's. */
const POLICY_LABELS: Record<Policy, { title: string; blurb: string }> = {
  'read-only': { title: 'Plan only', blurb: 'Reads and plans. No edits.' },
  'workspace-write': { title: 'Edit workspace', blurb: 'Edits inside the working directory.' },
  'full-access': { title: 'Full access', blurb: 'Skips permission prompts entirely.' },
};

// harn:assume agent-controls-shared-by-both-dialogs ref=agent-controls-component
/**
 * The one place harness / model / thinking are chosen. Both the channel-creation
 * dialog and the spawn dialog render this, so an option can never exist in one
 * and not the other.
 *
 * Models come from the adapter (`/api/adapters`), never from this package: a
 * model id hardcoded in the UI goes stale silently and fails only once the agent
 * is already starting. A harness that reports nothing still gets the custom
 * escape — a worse control, not a broken one.
 */
export function AgentControls(props: {
  adapters: AdapterRegistration[];
  value: AgentControlsValue;
  onChange: (next: AgentControlsValue) => void;
  /** Distinguishes the two dialogs' testids. */
  idPrefix: string;
  /** The creation dialog may start a channel with no agent at all. */
  allowNone?: boolean;
  /**
   * The member card configures an agent that already exists, and an agent's harness is
   * fixed the moment it is created. Show which one it is; do not offer a choice that
   * cannot be honoured.
   */
  lockHarness?: boolean;
}) {
  const { adapters, value, onChange, idPrefix } = props;
  // harn:assume harness-declares-supported-thinking-levels ref=agent-thinking-level-options
  const [customOpen, setCustomOpen] = useState(false);
  const adapter = adapters.find((candidate) => candidate.id === value.harness);
  const models = adapter?.models ?? [];
  const thinkingSupported = adapter?.capabilities.thinking === true;
  const thinkingLevels = thinkingSupported
    ? (adapter.capabilities.thinking_levels ?? DEFAULT_THINKING_LEVELS)
    : DEFAULT_THINKING_LEVELS;
  // Warn on EITHER deferred level, not just read-only: on a harness that emits a flag
  // only for full-access, workspace-write is no more enforced than read-only is, and
  // implying otherwise would trade one false promise for another.
  const deferredSelected =
    adapter !== undefined && adapter.capabilities.policies?.[value.policy] === null;
  // A searchable list IS free text: a half-typed model is a search in progress, not
  // an off-catalog model. Deriving `custom` from it would unmount the search box on
  // the first keystroke.
  const searchable = models.length > ROW_LIMIT;
  const listed = models.includes(value.model);
  const custom = customOpen || (!searchable && value.model !== '' && !listed);

  const pick = (next: Partial<AgentControlsValue>): void => onChange({ ...value, ...next });
  const reset = (next: Partial<AgentControlsValue>): void => {
    setCustomOpen(false);
    pick(next);
  };

  const fields = (
    <>
    {value.harness !== '' && (
      <fieldset className="wr-control-group">
        <legend>Model</legend>
        <div className="wr-button-row">
          <button
            type="button"
            data-testid={`${idPrefix}-model-default`}
            aria-pressed={value.model === '' && !custom}
            onClick={() => reset({ model: '' })}
          >
            Default
          </button>
          {!searchable && models.map((model) => (
            <button
              key={model}
              type="button"
              data-testid={`${idPrefix}-model-${model}`}
              aria-pressed={!custom && value.model === model}
              onClick={() => reset({ model })}
            >
              {model}
            </button>
          ))}
          <button
            type="button"
            data-testid={`${idPrefix}-model-custom`}
            aria-pressed={custom}
            onClick={() => {
              setCustomOpen(!custom);
              if (custom) pick({ model: '' });
            }}
          >
            Custom…
          </button>
        </div>

        {/* Too many to be a row — opencode reports one per configured provider. */}
        {!custom && searchable && (
          <>
            <input
              data-testid={`${idPrefix}-model-search`}
              aria-label="Model"
              list={`${idPrefix}-model-options`}
              value={value.model}
              placeholder={`Search ${String(models.length)} models`}
              onChange={(event) => pick({ model: event.target.value })}
              className="wr-input min-h-11 w-full px-3 text-sm"
            />
            <datalist id={`${idPrefix}-model-options`}>
              {models.map((model) => <option key={model} value={model} />)}
            </datalist>
          </>
        )}

        {custom && (
          <input
            data-testid={`${idPrefix}-model-custom-input`}
            aria-label="Custom model"
            value={value.model}
            autoFocus
            placeholder="model id"
            onChange={(event) => pick({ model: event.target.value })}
            className="wr-input min-h-11 w-full px-3 text-sm"
          />
        )}

        {models.length === 0 && !custom && (
          <small data-testid={`${idPrefix}-model-note`}>
            This harness did not report a model list.
          </small>
        )}
      </fieldset>
    )}

    {value.harness !== '' && (
      <fieldset className="wr-control-group">
        <legend>Thinking</legend>
        <div className="wr-button-row">
          <button
            type="button"
            data-testid={`${idPrefix}-thinking-default`}
            aria-pressed={value.thinking === ''}
            onClick={() => pick({ thinking: '' })}
          >
            Default
          </button>
          {thinkingLevels.map((level) => (
            <button
              key={level}
              type="button"
              data-testid={`${idPrefix}-thinking-${level}`}
              aria-pressed={value.thinking === level}
              disabled={!thinkingSupported}
              onClick={() => pick({ thinking: level })}
            >
              {level}
            </button>
          ))}
        </div>
        {!thinkingSupported && <small>Not supported by this harness</small>}
      </fieldset>
    )}

    {/* harn:assume one-control-chooses-an-agent-everywhere ref=shared-policy-control */}
    {value.harness !== '' && (
      <fieldset className="wr-control-group">
        <legend>Permission</legend>
        <div className="wr-policy-row">
          {PolicySchema.options.map((policy) => {
            const native = adapter?.capabilities.policies?.[policy] ?? null;
            const deferred = adapter !== undefined && native === null;
            return (
              <button
                key={policy}
                type="button"
                data-testid={`${idPrefix}-policy-${policy}`}
                className={`wr-policy-option${deferred ? ' is-deferred' : ''}`}
                aria-pressed={value.policy === policy}
                onClick={() => pick({ policy })}
              >
                <strong>{POLICY_LABELS[policy].title}</strong>
                <small>{POLICY_LABELS[policy].blurb}</small>
                {/* What it ACTUALLY becomes for this harness — read from the adapter,
                    never guessed here. A UI that hardcodes harness knowledge goes
                    stale silently, and this particular staleness is a safety one. */}
                <em data-testid={`${idPrefix}-policy-${policy}-native`}>
                  {native ?? 'not enforced'}
                </em>
              </button>
            );
          })}
        </div>
        {deferredSelected && (
          <small data-testid={`${idPrefix}-policy-deferred`} role="status" className="wr-policy-warning">
            {value.harness} does not take this setting. Both Plan only and Edit workspace
            build the same command, so what this agent may do is whatever {value.harness}
            is configured to allow. Only Full access changes anything.
          </small>
        )}
      </fieldset>
    )}
    {/* harn:end one-control-chooses-an-agent-everywhere */}
    </>
  );

  // An agent's harness is fixed the moment it is created, so the member card shows which
  // one it is rather than offering tiles that cannot be honoured. The rest of the control
  // is identical — that is the point of there being only one of it.
  if (props.lockHarness === true) {
    return (
      <div className="wr-agent-controls">
        <p data-testid={`${idPrefix}-harness-fixed`} className="wr-control-fixed">
          Harness <strong>{value.harness}</strong>
        </p>
        {fields}
      </div>
    );
  }

  return (
    <div className="wr-agent-controls">
      <fieldset className="wr-control-group">
        <legend>Harness</legend>
        <div className="wr-tile-grid">
          {props.allowNone === true && (
            <button
              type="button"
              data-testid={`${idPrefix}-harness-none`}
              aria-pressed={value.harness === ''}
              className="wr-tile"
              onClick={() => reset({ harness: '', model: '', thinking: '' })}
            >
              <Box aria-hidden size={18} />
              <span>No agent</span>
            </button>
          )}
          {adapters.map((candidate) => {
            const Icon = HARNESS_ICONS[candidate.id] ?? Box;
            return (
              <button
                key={candidate.id}
                type="button"
                data-testid={`${idPrefix}-harness-${candidate.id}`}
                aria-pressed={value.harness === candidate.id}
                className="wr-tile"
                onClick={() => {
                  // Re-picking the harness already selected is not a change: wiping
                  // the model here would throw away what the operator just typed
                  // into the custom escape.
                  if (candidate.id === value.harness) return;
                  // A model only means anything to the harness it was chosen under,
                  // and a thinking level the new harness rejects would strand the
                  // form: its buttons are disabled, so nothing could clear it.
                  const candidateLevels = candidate.capabilities.thinking === true
                    ? (candidate.capabilities.thinking_levels ?? DEFAULT_THINKING_LEVELS)
                    : [];
                  reset({
                    harness: candidate.id,
                    model: '',
                    ...(value.thinking === '' || candidateLevels.includes(value.thinking)
                      ? {}
                      : { thinking: '' }),
                  });
                }}
              >
                <Icon aria-hidden size={18} />
                <span>{candidate.id}</span>
                {!candidate.capabilities.resume && <small>ephemeral</small>}
              </button>
            );
          })}
        </div>
      </fieldset>

      {fields}
    </div>
  );
  // harn:end harness-declares-supported-thinking-levels
}
// harn:end agent-controls-shared-by-both-dialogs
