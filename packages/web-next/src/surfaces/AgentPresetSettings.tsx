import type { AgentPreset, DefaultRoster } from '@codor/protocol';
import { ArrowDown, ArrowUp, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createAgentPreset,
  deleteAgentPreset,
  fetchAgentPreset,
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
  originalLaunch?: AgentPreset['acp_launch'];
};

type EditError = { id: string; message: string };

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
  const [rosterRevision, setRosterRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshError, setRefreshError] = useState<string>();
  const [editor, setEditor] = useState<EditorDraft>();
  const [editorError, setEditorError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [editPendingId, setEditPendingId] = useState<string>();
  const [editError, setEditError] = useState<EditError>();
  const [deleteTarget, setDeleteTarget] = useState<AgentPreset>();
  const [deleteError, setDeleteError] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const generation = useRef(0);
  const editGeneration = useRef(0);
  const saveGeneration = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      editGeneration.current += 1;
      saveGeneration.current += 1;
    };
  }, []);

  const refresh = useCallback((): void => {
    editGeneration.current += 1;
    setEditPendingId(undefined);
    setEditError(undefined);
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
      setRosterRevision((revision) => revision + 1);
    }).catch((failure: unknown) => {
      if (alive.current && current === generation.current) setRefreshError(errorMessage(failure));
    }).finally(() => {
      if (alive.current && current === generation.current) setLoading(false);
    });
  }, [props.token]);

  useEffect(() => { refresh(); }, [refresh]);

  const openCreate = (): void => {
    editGeneration.current += 1;
    setEditPendingId(undefined);
    setEditError(undefined);
    setEditor({
      label: '', handle: '',
      config: blankConfig(catalog.installed[0]?.id ?? ''),
    });
    setEditorError(undefined);
  };

  const openEdit = (preset: AgentPreset): void => {
    const current = ++editGeneration.current;
    setEditor(undefined);
    setEditorError(undefined);
    setEditError(undefined);
    setEditPendingId(preset.id);
    void fetchAgentPreset(preset.id, { token: props.token() }).then((fresh) => {
      if (!alive.current || current !== editGeneration.current) return;
      setEditor({
        id: fresh.id,
        label: fresh.label,
        handle: fresh.handle,
        config: agentPresetToConfig(fresh),
        originalLaunch: fresh.acp_launch,
      });
    }).catch((failure: unknown) => {
      if (alive.current && current === editGeneration.current) {
        setEditError({ id: preset.id, message: errorMessage(failure) });
      }
    }).finally(() => {
      if (alive.current && current === editGeneration.current) setEditPendingId(undefined);
    });
  };

  const closeEditor = (): void => {
    if (!saving) {
      editGeneration.current += 1;
      setEditor(undefined);
      setEditorError(undefined);
    }
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
        originalLaunch: editor.originalLaunch,
      });
    } catch (failure) {
      setEditorError(errorMessage(failure));
      return;
    }
    const editingId = editor.id;
    const current = ++saveGeneration.current;
    setSaving(true);
    setEditorError(undefined);
    void (editingId === undefined
      ? createAgentPreset(input, { token: props.token() })
      : updateAgentPreset(editingId, input, { token: props.token() })
    ).then((saved) => {
      if (!alive.current || current !== saveGeneration.current) return;
      if (editingId !== undefined && saved.id !== editingId) {
        throw new Error(`saved preset id ${saved.id} did not match edited preset ${editingId}`);
      }
      setPresets((current) => {
        if (current === undefined) return [saved];
        return editingId === undefined
          ? [...current, saved]
          : current.map((preset) => preset.id === saved.id ? saved : preset);
      });
      setEditor(undefined);
    }).catch((failure: unknown) => {
      if (alive.current && current === saveGeneration.current) setEditorError(errorMessage(failure));
    }).finally(() => {
      if (alive.current && current === saveGeneration.current) setSaving(false);
    });
  };

  const confirmDelete = (): void => {
    if (deleteTarget === undefined || deleting) return;
    const target = deleteTarget;
    setDeleting(true);
    setDeleteError(undefined);
    editGeneration.current += 1;
    setEditPendingId(undefined);
    setEditError(undefined);
    void deleteAgentPreset(target.id, { token: props.token() }).then(() => {
      setPresets((current) => current?.filter((preset) => preset.id !== target.id));
      setDeleteTarget(undefined);
    }).catch((failure: unknown) => {
      setDeleteError(errorMessage(failure));
    }).finally(() => setDeleting(false));
  };

  // harn:assume empty-roster-settings-guides-saveable-setup ref=empty-roster-settings-render
  const rosterSetupGuide = presets !== undefined && roster !== undefined
    && refreshError === undefined && roster.preset_ids.length === 0 ? (
    <DefaultRosterSetupGuide hasPresets={presets.length > 0} onCreatePreset={openCreate} />
  ) : null;
  // harn:end empty-roster-settings-guides-saveable-setup

  return (
    <>
      <section className="nx-settings-card nx-agent-preset-settings" aria-labelledby="s-agent-presets" data-testid="agent-preset-settings">
        <div className="nx-settings-card-head">
          <div>
            <h2 id="s-agent-presets">Agent presets</h2>
            <p className="nx-settings-sub">Reusable individual configurations for Add agent and future channels.</p>
          </div>
          <Button variant="primary" data-testid="preset-add" disabled={saving || deleting} onClick={openCreate}>
            <Plus size={15} aria-hidden="true" /> Add preset
          </Button>
        </div>
        {loading && presets === undefined && <p className="nx-field-note" role="status">Loading saved presets…</p>}
        {refreshError !== undefined && (
          <div className="nx-settings-error" role="alert" data-testid="preset-list-error">
            <span>Couldn’t load agent presets: {refreshError}</span>
            <Button variant="quiet" data-testid="preset-list-retry" disabled={saving || deleting} onClick={refresh}>Retry</Button>
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
                  <Button
                    variant="quiet"
                    data-testid={`preset-edit-${preset.id}`}
                    disabled={saving || deleting || editPendingId === preset.id}
                    onClick={() => openEdit(preset)}
                  >
                    {editPendingId === preset.id ? 'Loading…' : 'Edit'}
                  </Button>
                  <Button
                    variant="danger"
                    data-testid={`preset-delete-${preset.id}`}
                    disabled={saving || deleting}
                    onClick={() => {
                      editGeneration.current += 1;
                      setEditPendingId(undefined);
                      setEditError(undefined);
                      setDeleteTarget(preset);
                      setDeleteError(undefined);
                    }}
                  >
                    Delete
                  </Button>
                </div>
                {editError?.id === preset.id && (
                  <div className="nx-preset-row-error" role="alert" data-testid={`preset-edit-error-${preset.id}`}>
                    <span>{editError?.message}</span>
                    <Button
                      variant="quiet"
                      data-testid={`preset-edit-retry-${preset.id}`}
                      disabled={saving || deleting || editPendingId === preset.id}
                      onClick={() => openEdit(preset)}
                    >
                      Retry
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {deleteError !== undefined && !deleteTarget && (
          <p className="nx-field-note is-error" role="alert">{deleteError}</p>
        )}
        <div className="nx-settings-actions">
            <Button variant="quiet" data-testid="preset-refresh" disabled={loading || saving || deleting} onClick={refresh}>
            <RefreshCw size={14} aria-hidden="true" /> Reload presets
          </Button>
        </div>
      </section>

      {rosterSetupGuide}
      <DefaultRosterEditor
        token={props.token}
        presets={presets ?? []}
        roster={roster}
        rosterRevision={rosterRevision}
        loading={loading}
        error={refreshError}
        onRefresh={refresh}
        onSaved={(saved) => {
          setRoster(saved);
          setRosterRevision((revision) => revision + 1);
        }}
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

// harn:assume empty-roster-settings-guides-saveable-setup ref=empty-roster-settings-guide
function DefaultRosterSetupGuide(props: { hasPresets: boolean; onCreatePreset: () => void }) {
  const firstRosterStep = props.hasPresets ? 1 : 2;
  return (
    <section className="nx-roster-setup-guide" aria-labelledby="s-default-roster-setup" data-testid="default-roster-setup-guide">
      <h3 id="s-default-roster-setup">Set up the Default roster</h3>
      <ol>
        {!props.hasPresets && (
          <li data-testid="roster-setup-create-step">
            <strong>1. Create a preset</strong>
            <span>Save one reusable agent configuration first.</span>
            <Button variant="secondary" type="button" data-testid="roster-setup-add-preset" onClick={props.onCreatePreset}>
              Create preset
            </Button>
          </li>
        )}
        <li data-testid="roster-setup-add-step">
          <strong>{firstRosterStep}. Add a saved preset</strong>
          <span>Choose a saved preset in the Default roster below.</span>
        </li>
        <li data-testid="roster-setup-save-step">
          <strong>{firstRosterStep + 1}. Save the roster</strong>
          <span>Save the ordered roster before using it for a new channel.</span>
        </li>
      </ol>
    </section>
  );
}
// harn:end empty-roster-settings-guides-saveable-setup

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
        <div className="nx-dialog-body" aria-busy={props.saving}>
          <fieldset className="nx-preset-editor-fields" disabled={props.saving}>
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
          </fieldset>
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
  rosterRevision: number;
  loading: boolean;
  error?: string;
  onRefresh: () => void;
  onSaved: (roster: DefaultRoster) => void;
}) {
  const [draftIds, setDraftIds] = useState<string[]>([]);
  const [addId, setAddId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  const rosterGeneration = useRef(0);
  const appliedRoster = useRef<{ revision: number; serialized: string }>();

  useEffect(() => () => {
    alive.current = false;
    rosterGeneration.current += 1;
  }, []);

  useEffect(() => {
    if (props.roster !== undefined && !saving) {
      const serialized = JSON.stringify(props.roster);
      const applied = appliedRoster.current;
      if (applied?.revision === props.rosterRevision && applied.serialized === serialized) return;
      appliedRoster.current = { revision: props.rosterRevision, serialized };
      setDraftIds([...props.roster.preset_ids]);
      setError(undefined);
    }
  }, [props.roster, props.rosterRevision, saving]);

  const authoritative = props.roster?.preset_ids ?? [];
  const dirty = JSON.stringify(draftIds) !== JSON.stringify(authoritative);
  const byId = useMemo(() => new Map(props.presets.map((preset) => [preset.id, preset])), [props.presets]);
  const available = props.presets.filter((preset) => !draftIds.includes(preset.id));
  const add = (): void => {
    if (saving || addId === '' || draftIds.includes(addId)) return;
    setDraftIds((ids) => [...ids, addId]);
    setAddId('');
  };
  const save = (): void => {
    if (!dirty || saving) return;
    const submittedIds = [...draftIds];
    const current = ++rosterGeneration.current;
    setSaving(true);
    setError(undefined);
    void replaceDefaultRoster({ preset_ids: submittedIds }, { token: props.token() }).then((saved) => {
      if (!alive.current || current !== rosterGeneration.current) return;
      props.onSaved(saved);
    }).catch((failure: unknown) => {
      if (alive.current && current === rosterGeneration.current) setError(errorMessage(failure));
    }).finally(() => {
      if (alive.current && current === rosterGeneration.current) setSaving(false);
    });
  };

  return (
    <section className="nx-settings-card nx-roster-settings" aria-labelledby="s-default-roster" aria-busy={saving} data-testid="default-roster-settings">
      <div className="nx-settings-card-head">
        <div>
          <h2 id="s-default-roster">Default roster</h2>
          <p className="nx-settings-sub">One ordered group of preset references used by new channels.</p>
        </div>
        <Button variant="quiet" data-testid="roster-refresh" disabled={props.loading || saving} onClick={props.onRefresh}>
          <RefreshCw size={14} aria-hidden="true" /> Reload
        </Button>
      </div>
      {props.loading && props.roster === undefined && <p className="nx-field-note" role="status">Loading default roster…</p>}
      {props.error !== undefined && <p className="nx-field-note is-error" role="alert" data-testid="roster-load-error">Couldn’t load the roster. Your draft remains unchanged.</p>}
      {props.roster !== undefined && (
        <>
          <fieldset className="nx-roster-draft" disabled={saving}>
          <ol className="nx-roster-list" data-testid="roster-list">
            {draftIds.length === 0 && <li className="nx-field-note">No default roster configured yet. Add a saved preset below, then save the roster.</li>}
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
                    <IconButton icon={ArrowUp} label={`Move ${preset?.label ?? 'missing preset'} up`} variant="quiet" size="sm" disabled={saving || index === 0} data-testid={`roster-up-${id}`} onClick={() => setDraftIds((ids) => ids.map((item, itemIndex) => itemIndex === index - 1 ? ids[index]! : itemIndex === index ? ids[index - 1]! : item))} />
                    <IconButton icon={ArrowDown} label={`Move ${preset?.label ?? 'missing preset'} down`} variant="quiet" size="sm" disabled={saving || index === draftIds.length - 1} data-testid={`roster-down-${id}`} onClick={() => setDraftIds((ids) => ids.map((item, itemIndex) => itemIndex === index ? ids[index + 1]! : itemIndex === index + 1 ? ids[index]! : item))} />
                    <IconButton icon={Trash2} label={`Remove ${preset?.label ?? 'missing preset'}`} variant="quiet" size="sm" disabled={saving} data-testid={`roster-remove-${id}`} onClick={() => setDraftIds((ids) => ids.filter((_, itemIndex) => itemIndex !== index))} />
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
            <Button variant="secondary" data-testid="roster-add" disabled={saving || addId === ''} onClick={add}><Plus size={15} aria-hidden="true" /> Add</Button>
          </div>
          </fieldset>
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
