// harn:assume registered-worktree-navigation-is-promotion-gated ref=worktree-group-navigation
// Group navigation is a projection of the PERSISTED registered set: it appears
// only after at least one secondary is active, keeps stable main first, and
// never surfaces discovered, unregistered, or removed records. All Git
// discovery lives behind the explicit Find dialog.
import type { RegisteredWorktree, WorktreeDiscoveryCandidate, WorktreeRemovalPreviewResponse } from '@codor/protocol';
import { GitBranch, Plus, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  adoptWorktree,
  createWorktree,
  discoverWorktrees,
  fetchRegisteredWorktrees,
  previewWorktreeRemoval,
  removeWorktree,
  unregisterWorktree,
  updateWorktreeAlias,
} from '@runtime/api.js';

import { roomSlice, useClientStore } from '../app/store.js';
import { roomUrl } from '../app/session.js';
import { Button, IconButton, Modal } from '../primitives/primitives.js';
import { DefaultRosterChoice } from './DefaultRosterChoice.js';

const EMPTY_REGISTERED: RegisteredWorktree[] = [];

export interface WorktreeGroupView {
  /** Main first, active secondaries alias-ordered — the server ordering. */
  registered: RegisteredWorktree[];
  children: RegisteredWorktree[];
  promoted: boolean;
  loaded: boolean;
  error?: string;
  /** Resolves after the store holds the fresh set, so callers can select a
   *  just-registered child without racing the stale projection. */
  refresh: () => Promise<void>;
}

/** Read the store-only registered projection into last-good group state. A
 * transient REST/socket failure keeps the previous set and reports the error
 * beside it; reconnect simply refreshes. */
export function useWorktreeGroup(root: string, token: () => string): WorktreeGroupView {
  const connected = useClientStore((state) => state.connected);
  const stored = useClientStore((state) => state.worktreeGroups[root]);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const alive = useRef(true);
  // The token getter is read through a ref so a parent re-render never
  // re-triggers the projection fetch.
  const tokenRef = useRef(token);
  tokenRef.current = token;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const refresh = useCallback((): Promise<void> => {
    const current = ++generation.current;
    return fetchRegisteredWorktrees(root, { token: tokenRef.current() }).then((projection) => {
      if (!alive.current || current !== generation.current) return;
      useClientStore.getState().setWorktreeGroup(root, {
        ...(projection.repository !== null && { repositoryId: projection.repository.id }),
        registered: projection.registered,
      });
      setError(undefined);
    }).catch((failure: unknown) => {
      if (!alive.current || current !== generation.current) return;
      setError(failure instanceof Error ? failure.message : String(failure));
    });
  }, [root]);

  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh]);

  const registered = stored?.registered ?? EMPTY_REGISTERED;
  const children = useMemo(() => registered.filter((worktree) => !worktree.primary), [registered]);
  return {
    registered,
    children,
    promoted: children.length > 0,
    loaded: stored?.loaded === true,
    ...(error !== undefined && { error }),
    refresh,
  };
}

// harn:assume native-worktree-rail-is-axe-valid ref=worktree-rail-dom-semantics
// harn:assume worktree-conversation-status-is-live-and-independent ref=worktree-conversation-status-model
/** Per-row status: CONNECTION (the connector's current-generation exact-room
 * readiness) is rendered on its own, never collapsed into ACTIVITY
 * (working/attention from the room's own recipient-scoped support and members,
 * Git availability from the registered record) or the unread badge — one state
 * can never mask another. */
function ChildRow(props: {
  root: string;
  worktree: RegisteredWorktree;
  selected: boolean;
  readiness: 'connecting' | 'connected' | 'offline' | 'unsubscribed';
  onSelect: () => void;
}) {
  const slice = useClientStore((state) => roomSlice(state, props.worktree.conversation_id));
  const unread = slice.support?.summary.unread ?? 0;
  const attention = slice.support?.summary.attention === true;
  const working = Object.values(slice.members)
    .some((member) => member.kind === 'agent' && (member.state === 'running' || member.state === 'queued'));
  const gitUnavailable = props.worktree.availability !== 'available';
  const connection = props.readiness === 'connected'
    ? 'live'
    : props.readiness === 'connecting'
      ? 'connecting…'
      : props.readiness === 'offline'
        ? 'offline'
        : 'not observed';
  const activity = working
    ? 'working…'
    : attention
      ? 'needs attention'
      : gitUnavailable
        ? 'checkout unavailable'
        : undefined;
  return (
    <a
      className={`nx-row nx-wt-row ${props.selected ? 'is-active' : ''}`}
      href={roomUrl(props.root, props.worktree.id)}
      aria-current={props.selected ? 'page' : undefined}
      data-testid={`worktree-link-${props.worktree.id}`}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        props.onSelect();
      }}
    >
      <GitBranch size={15} aria-hidden="true" className="nx-wt-row-icon" />
      <span className="nx-row-main">
        <span className="nx-row-top">
          <span className="nx-row-name">{props.worktree.alias}</span>
          {props.worktree.branch !== undefined && (
            <span className="nx-wt-branch">{props.worktree.branch}</span>
          )}
        </span>
        <span className="nx-row-bottom">
          {activity !== undefined && (
            <span
              className={`nx-row-preview ${attention ? 'is-error' : ''}`}
              data-testid={`worktree-status-${props.worktree.id}`}
            >
              {working && <span className="nx-typing" aria-hidden="true"><span /><span /><span /></span>}
              {activity}
            </span>
          )}
          <span
            className={`nx-wt-conn is-${props.readiness}`}
            data-testid={`worktree-connection-${props.worktree.id}`}
          >
            {connection}
          </span>
          {unread > 0 && (
            <span className="nx-unread" data-testid={`worktree-unread-${props.worktree.id}`}>
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </span>
      </span>
    </a>
  );
}
// harn:end worktree-conversation-status-is-live-and-independent

/** The group block under a promoted root: child rows plus the explicit
 * Create / Find entries. Main is the root channel row above, always first. */
export function WorktreeGroupSection(props: {
  root: string;
  token: () => string;
  group: WorktreeGroupView;
  selectedWorktree: string | undefined;
  readiness: (conversation: string) => 'connecting' | 'connected' | 'offline' | 'unsubscribed';
  canManage: boolean;
  onSelect: (worktreeId: string) => void;
  onOpenDialog: (dialog: 'create' | 'find' | { child: RegisteredWorktree }) => void;
}) {
  const { group } = props;
  // The readiness strings below are computed during THIS render from the
  // connector, so the section subscribes to the store's current-generation
  // live evidence: a room's own sync_complete (or a socket replacement
  // withdrawing every proof) re-renders the rows immediately.
  useClientStore((state) => state.roomLive);
  if (!group.promoted) return null;
  return (
    <section className="nx-wt-group" aria-label="Worktrees" data-testid="worktree-group">
      <div className="nx-wt-group-head">
        <span className="nx-wt-group-label">Worktrees</span>
        {props.canManage && (
          <span className="nx-wt-group-actions">
            <IconButton
              icon={Plus}
              label="Create worktree"
              size="sm"
              variant="quiet"
              data-testid="worktree-create-open"
              onClick={() => props.onOpenDialog('create')}
            />
            <IconButton
              icon={Search}
              label="Find worktrees"
              size="sm"
              variant="quiet"
              data-testid="worktree-find-open"
              onClick={() => props.onOpenDialog('find')}
            />
          </span>
        )}
      </div>
      {group.error !== undefined && (
        <p className="nx-wt-group-error" role="status" data-testid="worktree-group-error">
          {group.error}
        </p>
      )}
      <ul className="nx-wt-list">
        {group.children.map((worktree) => (
          <li key={worktree.id} className="nx-wt-item">
            <ChildRow
              root={props.root}
              worktree={worktree}
              selected={props.selectedWorktree === worktree.id}
              readiness={props.readiness(worktree.conversation_id)}
              onSelect={() => props.onSelect(worktree.id)}
            />
            {props.canManage && (
              <button
                type="button"
                className="nx-wt-manage"
                aria-label={`Manage worktree ${worktree.alias}`}
                data-testid={`worktree-manage-${worktree.id}`}
                onClick={() => props.onOpenDialog({ child: worktree })}
              >
                Manage
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
// harn:end native-worktree-rail-is-axe-valid
// harn:end registered-worktree-navigation-is-promotion-gated

// harn:assume worktree-lifecycle-ui-is-explicit-and-recoverable ref=worktree-lifecycle-dialogs
type DialogState = 'idle' | 'busy' | { error: string };

function dialogError(state: DialogState): string | undefined {
  return typeof state === 'object' ? state.error : undefined;
}

/** Create collects a normalized alias, a new local branch, a missing absolute
 * target, and the optional accepted default roster. Failure keeps the draft. */
export function WorktreeCreateDialog(props: {
  root: string;
  token: () => string;
  onClose: () => void;
  onCreated: (worktree: RegisteredWorktree) => void;
}) {
  const [alias, setAlias] = useState('');
  const [branch, setBranch] = useState('');
  const [path, setPath] = useState('');
  const [useRoster, setUseRoster] = useState(false);
  const [state, setState] = useState<DialogState>('idle');

  const submit = (): void => {
    setState('busy');
    void createWorktree(props.root, {
      alias,
      branch,
      path,
      ...(useRoster && { default_roster: true as const }),
    }, { token: props.token() }).then((result) => {
      props.onCreated(result.worktree);
    }).catch((failure: unknown) => {
      setState({ error: failure instanceof Error ? failure.message : String(failure) });
    });
  };

  return (
    <Modal label="Create worktree" testid="worktree-create-dialog" onClose={props.onClose} structured>
      <div className="nx-wt-dialog">
        <header className="nx-wt-dialog-head">
          <h2>Create worktree</h2>
          <p className="nx-field-note">
            Adds a new Git worktree on a new local branch and registers it as a child of this channel.
          </p>
        </header>
        <label className="nx-field">
          <span>Alias</span>
          <input
            value={alias}
            data-testid="worktree-create-alias"
            onChange={(event) => setAlias(event.target.value)}
            placeholder="review"
            autoComplete="off"
          />
        </label>
        <label className="nx-field">
          <span>New branch</span>
          <input
            value={branch}
            data-testid="worktree-create-branch"
            onChange={(event) => setBranch(event.target.value)}
            placeholder="feature/review"
            autoComplete="off"
          />
        </label>
        <label className="nx-field">
          <span>Target path (must not exist yet)</span>
          <input
            value={path}
            data-testid="worktree-create-path"
            onChange={(event) => setPath(event.target.value)}
            placeholder="/absolute/path/to/new-checkout"
            autoComplete="off"
          />
        </label>
        {/* harn:assume worktree-lifecycle-ui-is-explicit-and-recoverable ref=worktree-default-roster-choice-copy */}
        <DefaultRosterChoice
          token={props.token}
          selected={useRoster}
          onSelectedChange={setUseRoster}
          idPrefix="worktree-create"
          title="Default roster"
          note="Seed only this new worktree with the saved ordered group."
        />
        {/* harn:end worktree-lifecycle-ui-is-explicit-and-recoverable */}
        {dialogError(state) !== undefined && (
          <p className="nx-wt-dialog-error" role="alert" data-testid="worktree-create-error">
            {dialogError(state)}
          </p>
        )}
        <footer className="nx-wt-dialog-actions">
          <Button variant="quiet" type="button" onClick={props.onClose}>Cancel</Button>
          <Button
            type="button"
            data-testid="worktree-create-submit"
            disabled={state === 'busy' || alias.trim() === '' || branch.trim() === '' || path.trim() === ''}
            onClick={submit}
          >
            {state === 'busy' ? 'Creating…' : 'Create worktree'}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}

/** Find runs read-only discovery only after it opens, requires ONE selected
 * candidate plus a NONEMPTY alias, and never bulk-adopts. */
export function WorktreeFindDialog(props: {
  root: string;
  token: () => string;
  onClose: () => void;
  onAdopted: (worktree: RegisteredWorktree) => void;
}) {
  const [candidates, setCandidates] = useState<WorktreeDiscoveryCandidate[]>();
  const [loadError, setLoadError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [alias, setAlias] = useState('');
  const [state, setState] = useState<DialogState>('idle');
  const generation = useRef(0);
  const tokenRef = useRef(props.token);
  tokenRef.current = props.token;

  const discover = useCallback((): void => {
    const current = ++generation.current;
    setLoadError(undefined);
    void discoverWorktrees(props.root, { token: tokenRef.current() }).then((listing) => {
      if (current !== generation.current) return;
      setCandidates(listing.discovered.filter((candidate) =>
        candidate.registered_id === undefined
        && !candidate.primary
        && candidate.availability === 'available'
        && !candidate.locked));
    }).catch((failure: unknown) => {
      if (current !== generation.current) return;
      setLoadError(failure instanceof Error ? failure.message : String(failure));
    });
  }, [props.root]);

  useEffect(() => { discover(); }, [discover]);

  const selectedCandidate = candidates?.find((candidate) => candidate.path === selected);

  const adopt = (): void => {
    // Adoption names the child deliberately: one selected candidate AND a
    // nonempty alias, never a default derived from the branch.
    if (selectedCandidate === undefined || alias.trim() === '') return;
    setState('busy');
    void adoptWorktree(props.root, {
      path: selectedCandidate.path,
      alias: alias.trim(),
    }, { token: props.token() }).then((result) => {
      props.onAdopted(result.worktree);
    }).catch((failure: unknown) => {
      setState({ error: failure instanceof Error ? failure.message : String(failure) });
    });
  };

  return (
    <Modal label="Find worktrees" testid="worktree-find-dialog" onClose={props.onClose} structured>
      <div className="nx-wt-dialog">
        <header className="nx-wt-dialog-head">
          <h2>Find worktrees</h2>
          <p className="nx-field-note">
            Read-only discovery of this repository’s checkouts. Nothing is registered until you
            select one candidate and adopt it.
          </p>
        </header>
        {candidates === undefined && loadError === undefined && (
          <p className="nx-field-note" role="status" data-testid="worktree-find-loading">Discovering…</p>
        )}
        {loadError !== undefined && (
          <div className="nx-wt-dialog-error" role="alert" data-testid="worktree-find-error">
            <span>{loadError}</span>
            <Button variant="quiet" type="button" data-testid="worktree-find-retry" onClick={discover}>Retry</Button>
          </div>
        )}
        {candidates !== undefined && candidates.length === 0 && (
          <p className="nx-field-note" data-testid="worktree-find-empty">No unregistered worktrees found.</p>
        )}
        {candidates !== undefined && candidates.length > 0 && (
          <ul className="nx-wt-candidates" data-testid="worktree-find-candidates">
            {candidates.map((candidate) => (
              <li key={candidate.path}>
                <button
                  type="button"
                  className={`nx-wt-candidate ${selected === candidate.path ? 'is-selected' : ''}`}
                  aria-pressed={selected === candidate.path}
                  data-testid={`worktree-candidate-${candidate.branch ?? candidate.path}`}
                  onClick={() => {
                    setSelected(candidate.path);
                    setAlias(candidate.branch ?? '');
                  }}
                >
                  <span className="nx-wt-candidate-branch">{candidate.branch ?? '(detached)'}</span>
                  <span className="nx-wt-candidate-path">{candidate.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {selectedCandidate !== undefined && (
          <label className="nx-field">
            <span>Alias</span>
            <input
              value={alias}
              data-testid="worktree-adopt-alias"
              onChange={(event) => setAlias(event.target.value)}
              autoComplete="off"
            />
          </label>
        )}
        {dialogError(state) !== undefined && (
          <p className="nx-wt-dialog-error" role="alert" data-testid="worktree-adopt-error">
            {dialogError(state)}
          </p>
        )}
        <footer className="nx-wt-dialog-actions">
          <Button variant="quiet" type="button" onClick={props.onClose}>Cancel</Button>
          <Button
            type="button"
            data-testid="worktree-adopt-submit"
            disabled={state === 'busy' || selectedCandidate === undefined || alias.trim() === ''}
            onClick={adopt}
          >
            {state === 'busy' ? 'Adopting…' : 'Adopt selected'}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}

/** One child's deliberate acts: identity-preserving rename, DB-only
 * unregister, and preview-gated filesystem removal whose destructive step
 * repeats every check. Failure keeps the dialog and the selection. */
export function WorktreeChildDialog(props: {
  root: string;
  token: () => string;
  child: RegisteredWorktree;
  onClose: () => void;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const { child } = props;
  const [alias, setAlias] = useState(child.alias);
  const [renameState, setRenameState] = useState<DialogState>('idle');
  const [unregisterConfirm, setUnregisterConfirm] = useState(false);
  const [unregisterState, setUnregisterState] = useState<DialogState>('idle');
  const [preview, setPreview] = useState<WorktreeRemovalPreviewResponse>();
  const [previewError, setPreviewError] = useState<string>();
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [removeState, setRemoveState] = useState<DialogState>('idle');
  const previewGeneration = useRef(0);

  const loadPreview = useCallback((): void => {
    const current = ++previewGeneration.current;
    setPreviewError(undefined);
    void previewWorktreeRemoval(props.root, child.id, { token: props.token() }).then((result) => {
      if (current !== previewGeneration.current) return;
      setPreview(result);
    }).catch((failure: unknown) => {
      if (current !== previewGeneration.current) return;
      setPreview(undefined);
      setPreviewError(failure instanceof Error ? failure.message : String(failure));
    });
  }, [props.root, props.token, child.id]);

  useEffect(() => { loadPreview(); }, [loadPreview]);

  const rename = (): void => {
    setRenameState('busy');
    void updateWorktreeAlias(props.root, child.id, alias, { token: props.token() }).then(() => {
      props.onChanged();
      props.onClose();
    }).catch((failure: unknown) => {
      setRenameState({ error: failure instanceof Error ? failure.message : String(failure) });
    });
  };

  const unregisterSelected = (): void => {
    setUnregisterState('busy');
    void unregisterWorktree(props.root, child.id, { token: props.token() }).then(() => {
      props.onChanged();
      props.onClose();
    }).catch((failure: unknown) => {
      setUnregisterState({ error: failure instanceof Error ? failure.message : String(failure) });
    });
  };

  const removeSelected = (): void => {
    setRemoveState('busy');
    void removeWorktree(props.root, child.id, { token: props.token() }).then(() => {
      props.onRemoved();
      props.onClose();
    }).catch((failure: unknown) => {
      setRemoveState({ error: failure instanceof Error ? failure.message : String(failure) });
      setRemoveConfirm(false);
      loadPreview();
    });
  };

  const previewReady = preview?.state === 'clean';

  return (
    <Modal label={`Manage worktree ${child.alias}`} testid="worktree-child-dialog" onClose={props.onClose} structured>
      <div className="nx-wt-dialog">
        <header className="nx-wt-dialog-head">
          <h2>Worktree {child.alias}</h2>
          <p className="nx-field-note">{child.branch ?? 'detached'} · managed by stable id, never by path.</p>
        </header>

        <section className="nx-wt-dialog-section" aria-label="Rename worktree">
          <h3>Rename</h3>
          <label className="nx-field">
            <span>Alias</span>
            <input
              value={alias}
              data-testid="worktree-rename-input"
              onChange={(event) => setAlias(event.target.value)}
              autoComplete="off"
            />
          </label>
          {dialogError(renameState) !== undefined && (
            <p className="nx-wt-dialog-error" role="alert" data-testid="worktree-rename-error">
              {dialogError(renameState)}
            </p>
          )}
          <Button
            type="button"
            data-testid="worktree-rename-submit"
            disabled={renameState === 'busy' || alias.trim() === '' || alias.trim() === child.alias}
            onClick={rename}
          >
            {renameState === 'busy' ? 'Renaming…' : 'Save alias'}
          </Button>
        </section>

        <section className="nx-wt-dialog-section" aria-label="Unregister worktree">
          <h3>Unregister</h3>
          <p className="nx-field-note">
            Removes the registration only — the checkout, its branch, and the child transcript stay
            exactly as they are.
          </p>
          {dialogError(unregisterState) !== undefined && (
            <p className="nx-wt-dialog-error" role="alert" data-testid="worktree-unregister-error">
              {dialogError(unregisterState)}
            </p>
          )}
          {!unregisterConfirm ? (
            <Button
              variant="quiet"
              type="button"
              data-testid="worktree-unregister-open"
              onClick={() => setUnregisterConfirm(true)}
            >
              Unregister…
            </Button>
          ) : (
            <div className="nx-wt-confirm" data-testid="worktree-unregister-confirm">
              <Button
                type="button"
                data-testid="worktree-unregister-submit"
                disabled={unregisterState === 'busy'}
                onClick={unregisterSelected}
              >
                {unregisterState === 'busy' ? 'Unregistering…' : 'Confirm unregister'}
              </Button>
              <Button variant="quiet" type="button" onClick={() => setUnregisterConfirm(false)}>Cancel</Button>
            </div>
          )}
        </section>

        <section className="nx-wt-dialog-section" aria-label="Remove worktree files">
          <h3>Remove from disk</h3>
          {preview === undefined && previewError === undefined && (
            <p className="nx-field-note" role="status" data-testid="worktree-preview-loading">
              Checking worktree state…
            </p>
          )}
          {previewError !== undefined && (
            <div className="nx-wt-dialog-error" role="alert" data-testid="worktree-preview-error">
              <span>{previewError}</span>
              <Button variant="quiet" type="button" data-testid="worktree-preview-retry" onClick={loadPreview}>Retry</Button>
            </div>
          )}
          {preview !== undefined && (
            <p className="nx-wt-preview" data-testid="worktree-preview-state">
              {preview.state === 'clean'
                ? 'Clean and ready to remove.'
                : `Not removable: ${preview.state}${preview.detail !== undefined ? ` — ${preview.detail}` : ''}.`}
              {' '}The branch is always preserved.
            </p>
          )}
          {dialogError(removeState) !== undefined && (
            <p className="nx-wt-dialog-error" role="alert" data-testid="worktree-remove-error">
              {dialogError(removeState)}
            </p>
          )}
          {!removeConfirm ? (
            <Button
              variant="quiet"
              type="button"
              data-testid="worktree-remove-open"
              disabled={!previewReady}
              onClick={() => setRemoveConfirm(true)}
            >
              Remove files…
            </Button>
          ) : (
            <div className="nx-wt-confirm" data-testid="worktree-remove-confirm">
              <Button
                type="button"
                data-testid="worktree-remove-submit"
                disabled={removeState === 'busy'}
                onClick={removeSelected}
              >
                {removeState === 'busy' ? 'Removing…' : 'Delete files — branch is preserved'}
              </Button>
              <Button variant="quiet" type="button" onClick={() => setRemoveConfirm(false)}>Cancel</Button>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
// harn:end worktree-lifecycle-ui-is-explicit-and-recoverable
