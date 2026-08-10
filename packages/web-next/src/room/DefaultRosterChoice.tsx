import type { AgentPreset, DefaultRoster } from '@codor/protocol';
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchAgentPresets,
  fetchDefaultRoster,
} from '@runtime/api.js';

import { Button } from '../primitives/primitives.js';

export interface DefaultRosterChoiceState {
  presets: AgentPreset[] | undefined;
  roster: DefaultRoster | undefined;
  loading: boolean;
  error?: string;
  refresh: () => void;
}

/** Read the two authoritative sources together without expanding the roster client-side. */
export function useDefaultRosterChoice(
  token: () => string,
  enabled = true,
): DefaultRosterChoiceState {
  const [presets, setPresets] = useState<AgentPreset[]>();
  const [roster, setRoster] = useState<DefaultRoster>();
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const refresh = useCallback((): void => {
    if (!enabled) return;
    const current = ++generation.current;
    setLoading(true);
    setError(undefined);
    void Promise.all([
      fetchAgentPresets({ token: token() }),
      fetchDefaultRoster({ token: token() }),
    ]).then(([nextPresets, nextRoster]) => {
      if (!alive.current || current !== generation.current) return;
      setPresets(nextPresets);
      setRoster(nextRoster);
    }).catch((failure: unknown) => {
      if (!alive.current || current !== generation.current) return;
      setError(failure instanceof Error ? failure.message : String(failure));
    }).finally(() => {
      if (alive.current && current === generation.current) setLoading(false);
    });
  }, [enabled, token]);

  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, refresh]);

  return { presets, roster, loading, ...(error !== undefined && { error }), refresh };
}

export function rosterSummary(
  roster: DefaultRoster | undefined,
  presets: readonly AgentPreset[] | undefined,
): { text: string; inconsistent: boolean } {
  if (roster === undefined || presets === undefined) return { text: '', inconsistent: false };
  if (roster.preset_ids.length === 0) return { text: 'No default roster configured', inconsistent: false };
  const byId = new Map(presets.map((preset) => [preset.id, preset]));
  const missing = roster.preset_ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return {
      text: `${String(missing.length)} saved roster member${missing.length === 1 ? '' : 's'} need attention`,
      inconsistent: true,
    };
  }
  return {
    text: roster.preset_ids.map((id) => {
      const preset = byId.get(id)!;
      return `@${preset.handle}`;
    }).join(' · '),
    inconsistent: false,
  };
}

export function DefaultRosterChoice(props: {
  token: () => string;
  enabled?: boolean;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  onRosterEmptyChange?: (empty: boolean) => void;
  onSettings?: () => void;
  idPrefix?: string;
  // harn:assume worktree-lifecycle-ui-is-explicit-and-recoverable ref=worktree-default-roster-choice-copy
  /** Consumer-specific copy; the selector itself is the one accepted control. */
  title?: string;
  note?: string;
  // harn:end worktree-lifecycle-ui-is-explicit-and-recoverable
}) {
  const id = props.idPrefix ?? 'create';
  const enabled = props.enabled !== false;
  const state = useDefaultRosterChoice(props.token, enabled);
  const summary = useMemo(
    () => rosterSummary(state.roster, state.presets),
    [state.presets, state.roster],
  );

  // harn:assume empty-default-roster-is-unconfigured-state ref=empty-roster-choice-and-submit
  useEffect(() => {
    if (state.roster === undefined) return;
    const empty = state.roster.preset_ids.length === 0;
    props.onRosterEmptyChange?.(empty);
    if (empty && props.selected) props.onSelectedChange(false);
  }, [props.onRosterEmptyChange, props.onSelectedChange, props.selected, state.roster]);
  // harn:end empty-default-roster-is-unconfigured-state

  if (!enabled) return null;

  return (
    <section className="nx-roster-choice" aria-labelledby={`${id}-roster-choice-title`} data-testid={`${id}-roster-choice`}>
      <div className="nx-roster-choice-head">
        <div>
          <h3 id={`${id}-roster-choice-title`}>{props.title ?? 'Default roster'}</h3>
          <p className="nx-field-note">{props.note ?? 'Use the saved ordered group for this channel.'}</p>
        </div>
        <button
          type="button"
          className="nx-roster-reload"
          aria-label="Reload default roster"
          data-testid={`${id}-roster-refresh`}
          disabled={state.loading}
          onClick={state.refresh}
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>
      {state.loading && state.roster === undefined && (
        <p className="nx-field-note" role="status" data-testid={`${id}-roster-loading`}>Checking saved roster…</p>
      )}
      {state.error !== undefined && (
        <div className="nx-roster-choice-error" role="alert" data-testid={`${id}-roster-error`}>
          <span>Couldn’t load the default roster. Starting agent remains available.</span>
          {props.selected && (
            <Button
              variant="quiet"
              type="button"
              data-testid={`${id}-roster-deselect`}
              onClick={() => props.onSelectedChange(false)}
            >
              Use Starting agent
            </Button>
          )}
          <Button variant="quiet" type="button" data-testid={`${id}-roster-retry`} onClick={state.refresh}>
            Retry
          </Button>
        </div>
      )}
      {state.roster !== undefined && state.presets !== undefined
        && state.error === undefined && !summary.inconsistent && state.roster.preset_ids.length === 0 && (
        <div className="nx-roster-empty" role="status" data-testid={`${id}-roster-empty`}>
          <strong>No default roster configured</strong>
          <span>Add a saved preset in Settings and save it to Default roster, or use Starting agent for this channel.</span>
          {props.onSettings !== undefined && (
            <Button variant="quiet" type="button" data-testid={`${id}-roster-settings`} onClick={props.onSettings}>
              Open Settings
            </Button>
          )}
        </div>
      )}
      {state.roster !== undefined && state.presets !== undefined
        && state.error === undefined && !summary.inconsistent && state.roster.preset_ids.length > 0 && (
        <button
          type="button"
          className={`nx-roster-choice-card ${props.selected ? 'is-selected' : ''}`}
          aria-pressed={props.selected}
          data-testid={`${id}-roster-select`}
          onClick={() => props.onSelectedChange(!props.selected)}
        >
          <span className="nx-roster-choice-mark" aria-hidden="true" />
          <span className="nx-roster-choice-copy">
            <strong>{props.selected ? 'Using default roster' : 'Use default roster'}</strong>
            <span>{summary.text}</span>
          </span>
          <span className="nx-check" aria-hidden="true" />
        </button>
      )}
      {state.roster !== undefined && state.presets !== undefined
        && state.error === undefined && summary.inconsistent && (
        <div className="nx-roster-inconsistent" role="alert" data-testid={`${id}-roster-inconsistent`}>
          <strong>Roster needs attention</strong>
          <span>{summary.text}. Reload it in Settings or use Starting agent.</span>
          {props.selected && (
            <Button
              variant="quiet"
              type="button"
              data-testid={`${id}-roster-deselect`}
              onClick={() => props.onSelectedChange(false)}
            >
              Use Starting agent
            </Button>
          )}
          <Button variant="quiet" type="button" onClick={state.refresh}>Reload</Button>
        </div>
      )}
    </section>
  );
}
