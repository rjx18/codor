import { ThinkingLevelSchema, type ThinkingLevel } from '@codor/protocol';
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
}

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
}) {
  const { adapters, value, onChange, idPrefix } = props;
  const [customOpen, setCustomOpen] = useState(false);
  const adapter = adapters.find((candidate) => candidate.id === value.harness);
  const models = adapter?.models ?? [];
  const thinkingSupported = adapter?.capabilities.thinking === true;
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
                onClick={() => reset({
                  harness: candidate.id,
                  // A model only means anything to the harness it was chosen under,
                  // and a thinking level the new harness rejects would strand the
                  // form: its buttons are disabled, so nothing could clear it.
                  model: '',
                  ...(candidate.capabilities.thinking === true ? {} : { thinking: '' }),
                })}
              >
                <Icon aria-hidden size={18} />
                <span>{candidate.id}</span>
                {!candidate.capabilities.resume && <small>ephemeral</small>}
              </button>
            );
          })}
        </div>
      </fieldset>

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
            {ThinkingLevelSchema.options.map((level) => (
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
    </div>
  );
}
// harn:end agent-controls-shared-by-both-dialogs
