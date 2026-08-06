import type { AgentPreset, DefaultRoster } from '@codor/protocol';
import { ArrowDown, ArrowUp, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createAgentPreset,
  deleteAgentPreset,
  fetchAgentPresets,
  fetchDefaultRoster,
  replaceDefaultRoster,
  updateAgentPreset,
} from '@runtime/api.js';

import { useAdapterCatalog } from '../app/session.js';
import { Button, Code, IconButton, Modal } from '../primitives/primitives.js';
import {
  DEFAULT_POLICY,
  HANDLE_PATTERN,
  agentPresetInputFromConfig,
  agentPresetToConfig,
  supportedThinking,
  type AdapterLike,
  type AgentConfig,
} from '../room/agent-spec.js';
import { AgentControls, AgentIdentityControls } from '../room/AgentControls.js';

type EditorDraft = {
  id?: string;
  label: string;
  handle: string;
  config: AgentConfig;
};

const errorMessage = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

const blankConfig = (harness = ''): AgentConfig => ({
  harness,
  model: '',
  thinking: '',
  policy: DEFAULT_POLICY,
  displayName: '',
});

function catalogIssue(draft: EditorDraft, adapters: readonly AdapterLike[]): string | undefined {
  if (draft.label.trim() === '') return 'Give this preset a readable label.';
  if (!new RegExp(`^${HANDLE_PATTERN}$`).test(draft.handle.trim())) {
    return 'Use a lowercase handle with letters, numbers, and hyphens.';
  }
  const selector = draft.config.harness.trim();
  if (selector === '') return 'Choose a harness.';
  const adapter = adapters.find((candidate) => candidate.id === selector);
  const configurableCustomAcp = selector === 'acp' && adapter?.configurable === true;
  if (adapter === undefined || (adapter.installed === false && !configurableCustomAcp)) {
    return 'This harness is unavailable. Refresh the catalog or choose another one.';
  }
  if (selector === 'acp' && adapter.configurable !== true) {
    return 'The custom ACP transport is unavailable. Refresh the catalog and try again.';
  }
  if (draft.config.model !== '' && adapter.models !== undefined && adapter.models.length > 0
    && !adapter.models.includes(draft.config.model)) {
    return `Model “${draft.config.model}” is no longer offered by this harness.`;
  }
  if (draft.config.thinking !== '' && supportedThinking(adapter, draft.config.thinking) === undefined) {
    return `Thinking level “${draft.config.thinking}” is no longer supported by this harness.`;
  }
  if (selector === 'acp' && (draft.config.acpExecutable?.trim() ?? '') === '') {
    return 'A custom ACP executable is required.';
  }
  return undefined;
}

function harnessSummary(preset: AgentPreset): string {
  if (preset.harness !== 'acp') return preset.harness;
  return preset.acp_provider === undefined ? 'ACP · custom command' : `ACP · ${preset.acp_provider}`;
}

export function AgentPresetSettings(props: { token: () => string }) {
  const catalog = useAdapterCatalog(props.token);
  const adapters = useMemo<AdapterLike[]>(
    () => [...catalog.installed, ...catalog.advanced],
    [catalog.advanced, catalog.installed],
  );
  const [presets, setPresets] = useState<AgentPreset[]>();
  const [roster, setRoster] = useState<DefaultRoster>();
  const [loading, setLoading] = useState(true);
  const [refreshError, setRefreshError] = useState<string>();
  const [editor, setEditor] = useState<EditorDraft>();
  const [editorError, setEditorError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AgentPreset>();
  const [deleteError, setDeleteError] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const generation = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const refresh = useCallback((): void => {
    const current = ++generation.current;
    setLoading(true);
    setRefreshError(undefined);
    void Promise.all([
      fetchAgentPresets({ token: props.token() }),
      fetchDefaultRoster({ token: props.token() }),
    ]).then(([nextPresets, nextRoster]) => {
      if (!alive.current || current !== generation.current) return;
      setPresets(nextPresets);
      setRoster(nextRoster);
    }).catch((failure: unknown) => {
      if (alive.current && current === generation.current) setRefreshError(errorMessage(failure));
    }).finally(() => {
      if (alive.current && current === generation.current) setLoading(false);
    });
  }, [props.token]);

  useEffect(() => { refresh(); }, [refresh]);

  const openCreate = (): void => {
    setEditor({
      label: '', handle: '',
      config: blankConfig(catalog.installed[0]?.id ?? ''),
    });
    setEditorError(undefined);
  };

  const openEdit = (preset: AgentPreset): void => {
    setEditor({ id: preset.id, label: preset.label, handle: preset.handle, config: agentPresetToConfig(preset) });
    setEditorError(undefined);
  };

  const closeEditor = (): void => {
    if (!saving) setEditor(undefined);
  };

  const saveEditor = (): void => {
    if (editor === undefined || saving) return;
    const issue = catalogIssue(editor, adapters);
    if (issue !== undefined) {
      setEditorError(issue);
      return;
    }
    let input;
    try {
      input = agentPresetInputFromConfig({
        label: editor.label,
        handle: editor.handle,
        config: editor.config,
        adapters,
      });
    } catch (failure) {
      setEditorError(errorMessage(failure));
      return;
    }
    const editingId = editor.id;
    setSaving(true);
    setEditorError(undefined);
    void (editingId === undefined
      ? createAgentPreset(input, { token: props.token() })
      : updateAgentPreset(editingId, input, { token: props.token() })
    ).then((saved) => {
      setPresets((current) => {
        if (current === undefined) return [saved];
        return editingId === undefined
          ? [...current, saved]
          : current.map((preset) => preset.id === saved.id ? saved : preset);
      });
      setEditor(undefined);
    }).catch((failure: unknown) => {
      setEditorError(errorMessage(failure));
    }).finally(() => setSaving(false));
  };

  const confirmDelete = (): void => {
    if (deleteTarget === undefined || deleting) return;
    const target = deleteTarget;
    setDeleting(true);
    setDeleteError(undefined);
    void deleteAgentPreset(target.id, { token: props.token() }).then(() => {
      setPresets((current) => current?.filter((preset) => preset.id !== target.id));
      setDeleteTarget(undefined);
    }).catch((failure: unknown) => {
      setDeleteError(errorMessage(failure));
    }).finally(() => setDeleting(false));
  };

  return (
    <>
      <section className="nx-settings-card nx-agent-preset-settings" aria-labelledby="s-agent-presets" data-testid="agent-preset-settings">
        <div className="nx-settings-card-head">
          <div>
            <h2 id="s-agent-presets">Agent presets</h2>
            <p className="nx-settings-sub">Reusable individual configurations for Add agent and future channels.</p>
          </div>
          <Button variant="primary" data-testid="preset-add" onClick={openCreate}>
            <Plus size={15} aria-hidden="true" /> Add preset
          </Button>
        </div>
        {loading && presets === undefined && <p className="nx-field-note" role="status">Loading saved presets…</p>}
        {refreshError !== undefined && (
          <div className="nx-settings-error" role="alert" data-testid="preset-list-error">
            <span>Couldn’t load agent presets: {refreshError}</span>
            <Button variant="quiet" data-testid="preset-list-retry" onClick={refresh}>Retry</Button>
          </div>
        )}
        {presets !== undefined && (
          <ul className="nx-preset-list" data-testid="preset-list">
            {presets.length === 0 && <li className="nx-field-note">No saved presets yet.</li>}
            {presets.map((preset) => (
              <li key={preset.id} className="nx-preset-row" data-testid={`preset-row-${preset.id}`}>
                <div className="nx-preset-summary">
                  <strong>{preset.label}</strong>
                  <span><Code>@{preset.handle}</Code>{preset.display_name ? ` · ${preset.display_name}` : ''}</span>
                  <small>{harnessSummary(preset)}</small>
                </div>
                <div className="nx-preset-actions">
                  <Button variant="quiet" data-testid={`preset-edit-${preset.id}`} onClick={() => openEdit(preset)}>Edit</Button>
                  <Button variant="danger" data-testid={`preset-delete-${preset.id}`} onClick={() => { setDeleteTarget(preset); setDeleteError(undefined); }}>Delete</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {deleteError !== undefined && !deleteTarget && (
          <p className="nx-field-note is-error" role="alert">{deleteError}</p>
        )}
        <div className="nx-settings-actions">
          <Button variant="quiet" data-testid="preset-refresh" disabled={loading} onClick={refresh}>
            <RefreshCw size={14} aria-hidden="true" /> Reload presets
          </Button>
        </div>
      </section>

      <DefaultRosterEditor
        token={props.token}
        presets={presets ?? []}
        roster={roster}
        loading={loading}
        error={refreshError}
        onRefresh={refresh}
        onSaved={setRoster}
      />

      {editor !== undefined && (
        <PresetEditorModal
          draft={editor}
          adapters={adapters}
          catalog={catalog}
          error={editorError}
          saving={saving}
          onChange={setEditor}
          onSave={saveEditor}
          onClose={closeEditor}
        />
      )}
      {deleteTarget !== undefined && (
        <Modal label={`Delete ${deleteTarget.label}`} onClose={() => { if (!deleting) setDeleteTarget(undefined); }} alert testid="preset-delete-dialog">
          <h2 className="nx-dialog-title">Delete {deleteTarget.label}?</h2>
          <p className="nx-dialog-body">This removes the reusable preset. A preset still in the default roster cannot be deleted.</p>
          {deleteError !== undefined && <p className="nx-field-note is-error" role="alert" data-testid="preset-delete-error">{deleteError}</p>}
          <div className="nx-dialog-actions">
            <Button variant="quiet" disabled={deleting} onClick={() => setDeleteTarget(undefined)}>Cancel</Button>
            <Button variant="danger" disabled={deleting} data-testid="preset-delete-confirm" onClick={confirmDelete}>
              {deleting ? 'Deleting…' : 'Delete preset'}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function PresetEditorModal(props: {
  draft: EditorDraft;
  adapters: readonly AdapterLike[];
  catalog: ReturnType<typeof useAdapterCatalog>;
  error?: string;
  saving: boolean;
  onChange: (draft: EditorDraft) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const labelRef = useRef<HTMLInputElement>(null);
  const issue = catalogIssue(props.draft, props.adapters);
  const setConfig = (config: AgentConfig): void => props.onChange({ ...props.draft, config });
  return (
    <Modal
      label={props.draft.id === undefined ? 'Add agent preset' : 'Edit agent preset'}
      onClose={props.onClose}
      testid="preset-editor-dialog"
      wide
      structured
      initialFocus={labelRef}
    >
      <form onSubmit={(event) => { event.preventDefault(); props.onSave(); }}>
        <header className="nx-dialog-head">
          <div className="nx-dialog-headings">
            <div>
              <h2 className="nx-dialog-title">{props.draft.id === undefined ? 'Add agent preset' : 'Edit agent preset'}</h2>
              <p className="nx-dialog-sub">One reusable identity, mapped to the same controls as Add agent.</p>
            </div>
          </div>
          <button type="button" className="nx-dialog-close" aria-label="Close preset editor" disabled={props.saving} data-testid="preset-editor-close" onClick={props.onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="nx-dialog-body">
          <label className="nx-field">
            <span className="nx-label">Preset label</span>
            <input ref={labelRef} value={props.draft.label} maxLength={80} required data-testid="preset-label" onChange={(event) => props.onChange({ ...props.draft, label: event.target.value })} />
          </label>
          <label className="nx-field">
            <span className="nx-label">Assignable handle</span>
            <input value={props.draft.handle} maxLength={31} pattern={HANDLE_PATTERN} required placeholder="e.g. reviewer" data-testid="preset-handle" onChange={(event) => props.onChange({ ...props.draft, handle: event.target.value })} />
            <span className="nx-field-note">lowercase letters, numbers, and hyphens</span>
          </label>
          <label className="nx-field">
            <span className="nx-label">Display name <span className="nx-opt">· optional</span></span>
            <input value={props.draft.config.displayName ?? ''} maxLength={120} data-testid="preset-display-name" onChange={(event) => setConfig({ ...props.draft.config, displayName: event.target.value })} />
          </label>
          <AgentIdentityControls
            adapters={props.catalog.installed}
            advanced={props.catalog.advanced}
            config={props.draft.config}
            onChange={setConfig}
            idPrefix="preset"
            onRefresh={props.catalog.refresh}
            refreshing={props.catalog.refreshing}
            refreshError={props.catalog.refreshError}
          />
          <AgentControls
            adapters={props.adapters}
            config={props.draft.config}
            onChange={setConfig}
            hideHarness
            behaviourSection={3}
            permissionsSection={4}
            idPrefix="preset"
          />
          {issue !== undefined && <p className="nx-field-note is-error" role="alert" data-testid="preset-editor-validation">{issue}</p>}
          {props.error !== undefined && <p className="nx-field-note is-error" role="alert" data-testid="preset-editor-error">{props.error}</p>}
        </div>
        <footer className="nx-dialog-actions">
          <Button variant="quiet" type="button" disabled={props.saving} data-testid="preset-editor-cancel" onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={props.saving || issue !== undefined} data-testid="preset-save">
            <Save size={15} aria-hidden="true" /> {props.saving ? 'Saving…' : 'Save preset'}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}

function DefaultRosterEditor(props: {
  token: () => string;
  presets: readonly AgentPreset[];
  roster: DefaultRoster | undefined;
  loading: boolean;
  error?: string;
  onRefresh: () => void;
  onSaved: (roster: DefaultRoster) => void;
}) {
  const [draftIds, setDraftIds] = useState<string[]>([]);
  const [addId, setAddId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (props.roster !== undefined) {
      setDraftIds([...props.roster.preset_ids]);
      setError(undefined);
    }
  }, [props.roster]);

  const authoritative = props.roster?.preset_ids ?? [];
  const dirty = JSON.stringify(draftIds) !== JSON.stringify(authoritative);
  const byId = useMemo(() => new Map(props.presets.map((preset) => [preset.id, preset])), [props.presets]);
  const available = props.presets.filter((preset) => !draftIds.includes(preset.id));
  const add = (): void => {
    if (addId === '' || draftIds.includes(addId)) return;
    setDraftIds((ids) => [...ids, addId]);
    setAddId('');
  };
  const save = (): void => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(undefined);
    void replaceDefaultRoster({ preset_ids: draftIds }, { token: props.token() }).then((saved) => {
      props.onSaved(saved);
    }).catch((failure: unknown) => setError(errorMessage(failure))).finally(() => setSaving(false));
  };

  return (
    <section className="nx-settings-card nx-roster-settings" aria-labelledby="s-default-roster" data-testid="default-roster-settings">
      <div className="nx-settings-card-head">
        <div>
          <h2 id="s-default-roster">Default roster</h2>
          <p className="nx-settings-sub">One ordered group of preset references used by new channels.</p>
        </div>
        <Button variant="quiet" data-testid="roster-refresh" disabled={props.loading} onClick={props.onRefresh}>
          <RefreshCw size={14} aria-hidden="true" /> Reload
        </Button>
      </div>
      {props.loading && props.roster === undefined && <p className="nx-field-note" role="status">Loading default roster…</p>}
      {props.error !== undefined && <p className="nx-field-note is-error" role="alert" data-testid="roster-load-error">Couldn’t load the roster. Your draft remains unchanged.</p>}
      {props.roster !== undefined && (
        <>
          <ol className="nx-roster-list" data-testid="roster-list">
            {draftIds.length === 0 && <li className="nx-field-note">Empty roster — new channels can start without agents.</li>}
            {draftIds.map((id, index) => {
              const preset = byId.get(id);
              return (
                <li key={`${id}-${index}`} className={`nx-roster-row ${preset === undefined ? 'is-missing' : ''}`} data-testid={`roster-row-${id}`}>
                  <span className="nx-roster-order">{String(index + 1)}</span>
                  <span className="nx-roster-summary">
                    {preset === undefined ? <strong>Missing preset</strong> : <strong>{preset.label}</strong>}
                    <span>{preset === undefined ? <Code>{id}</Code> : <><Code>@{preset.handle}</Code>{preset.display_name ? ` · ${preset.display_name}` : ''}</>}</span>
                  </span>
                  <span className="nx-roster-actions">
                    <IconButton icon={ArrowUp} label={`Move ${preset?.label ?? 'missing preset'} up`} variant="quiet" size="sm" disabled={index === 0} data-testid={`roster-up-${id}`} onClick={() => setDraftIds((ids) => ids.map((item, itemIndex) => itemIndex === index - 1 ? ids[index]! : itemIndex === index ? ids[index - 1]! : item))} />
                    <IconButton icon={ArrowDown} label={`Move ${preset?.label ?? 'missing preset'} down`} variant="quiet" size="sm" disabled={index === draftIds.length - 1} data-testid={`roster-down-${id}`} onClick={() => setDraftIds((ids) => ids.map((item, itemIndex) => itemIndex === index ? ids[index + 1]! : itemIndex === index + 1 ? ids[index]! : item))} />
                    <IconButton icon={Trash2} label={`Remove ${preset?.label ?? 'missing preset'}`} variant="quiet" size="sm" data-testid={`roster-remove-${id}`} onClick={() => setDraftIds((ids) => ids.filter((_, itemIndex) => itemIndex !== index))} />
                  </span>
                </li>
              );
            })}
          </ol>
          <div className="nx-roster-add">
            <label className="nx-field">
              <span className="nx-label">Add a saved preset</span>
              <select aria-label="Add preset to default roster" data-testid="roster-add-select" value={addId} onChange={(event) => setAddId(event.target.value)}>
                <option value="">Choose a preset…</option>
                {available.map((preset) => <option key={preset.id} value={preset.id}>{preset.label} · @{preset.handle}</option>)}
              </select>
            </label>
            <Button variant="secondary" data-testid="roster-add" disabled={addId === ''} onClick={add}><Plus size={15} aria-hidden="true" /> Add</Button>
          </div>
          {error !== undefined && <p className="nx-field-note is-error" role="alert" data-testid="roster-save-error">{error}</p>}
          <div className="nx-settings-actions">
            <Button variant="primary" data-testid="roster-save" disabled={!dirty || saving} onClick={save}>
              <Save size={15} aria-hidden="true" /> {saving ? 'Saving…' : 'Save roster'}
            </Button>
            {dirty && <span className="nx-field-note" role="status">Unsaved order</span>}
          </div>
        </>
      )}
    </section>
  );
}
