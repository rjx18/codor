// harn:assume registered-worktree-navigation-is-promotion-gated ref=worktree-group-navigation
// Group navigation is a projection of the PERSISTED registered set: it appears
// only after at least one secondary is active, keeps stable main first, and
// never surfaces discovered, unregistered, or removed records. All Git
// discovery lives behind the explicit Find dialog.
import type { RegisteredWorktree, WorktreeDiscoveryCandidate, WorktreeRemovalPreviewResponse } from '@codor/protocol';
import { GitBranch, MoreVertical, Plus, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  adoptWorktree,
  createWorktree,
  discoverWorktrees,
  fetchRegisteredWorktrees,
  previewWorktreeRemoval,
  removeWorktree,
  unregisterWorktree,
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
// harn:assume worktree-child-conversations-stay-nested-and-isolated ref=worktree-nested-row-navigation
// harn:assume worktree-rail-uses-branch-only-compact-status ref=worktree-branch-status-row
// harn:assume worktree-rail-is-one-line-and-working-replaces-the-branch-glyph ref=worktree-one-line-row
/** Per-row status remains truthful in the accessible name/title while the
 * compact row spends its icon slot only on the branch/working affordance. */
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
    ? 'Connected'
    : props.readiness === 'connecting'
      ? 'Connecting'
      : props.readiness === 'offline'
        ? 'Unavailable'
        : 'Not subscribed';
  const activityLabels = [
    ...(working ? ['Working'] : []),
    ...(attention ? ['Needs attention'] : []),
    ...(gitUnavailable ? ['Checkout unavailable'] : []),
  ];
  const displayName = props.worktree.branch ?? 'Detached HEAD';
  const accessibleState = [
    connection,
    ...activityLabels,
    ...(unread > 0 ? [`${String(unread)} unread`] : []),
  ].join(', ');
  const accessibleLabel = `${displayName}; ${accessibleState}`;
  return (
    <a
      className={`nx-row nx-wt-row ${props.selected ? 'is-active' : ''}`}
      href={roomUrl(props.root, props.worktree.id)}
      aria-current={props.selected ? 'page' : undefined}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      data-testid={`worktree-link-${props.worktree.id}`}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        props.onSelect();
      }}
    >
      <span className="nx-wt-row-icon" aria-hidden="true">
        {working ? (
          <span className="nx-wt-working-dots" data-testid={`worktree-working-${props.worktree.id}`}>
            <span /><span /><span />
          </span>
        ) : (
          <GitBranch size={15} />
        )}
      </span>
      <span className="nx-row-name" data-testid={`worktree-branch-${props.worktree.id}`}>
        {displayName}
      </span>
      {unread > 0 && (
        <span className="nx-unread" data-testid={`worktree-unread-${props.worktree.id}`}>
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </a>
  );
}
// harn:end worktree-rail-is-one-line-and-working-replaces-the-branch-glyph
// harn:end worktree-rail-uses-branch-only-compact-status
// harn:end worktree-child-conversations-stay-nested-and-isolated
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
  onOpenDialog: (dialog: 'create' | 'find') => void;
  onChildChanged?: () => void;
  onChildRemoved?: (worktreeId: string) => void;
}) {
  const { group } = props;
  const [openMenuId, setOpenMenuId] = useState<string>();
  const triggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const closeMenu = useCallback((worktreeId: string): void => {
    setOpenMenuId((current) => current === worktreeId ? undefined : current);
    const restoreFocus = (): void => {
      const trigger = document.querySelector<HTMLButtonElement>(
        `[data-testid="worktree-menu-trigger-${worktreeId}"]`,
      );
      trigger?.focus();
    };
    restoreFocus();
    // An outside pointer event can apply its default focus after this handler;
    // restore once more after that browser default has settled.
    globalThis.setTimeout(restoreFocus, 50);
  }, []);
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
              <>
                <button
                  type="button"
                  className="nx-iconbtn nx-wt-menu-trigger"
                  aria-label={`Manage worktree ${worktree.branch ?? 'Detached HEAD'}`}
                  title={`Manage worktree ${worktree.branch ?? 'Detached HEAD'}`}
                  data-testid={`worktree-menu-trigger-${worktree.id}`}
                  aria-haspopup="menu"
                  aria-expanded={openMenuId === worktree.id}
                  aria-controls={`worktree-menu-${worktree.id}`}
                  ref={(element) => { triggerRefs.current[worktree.id] = element; }}
                  onClick={() => {
                    setOpenMenuId((current) => current === worktree.id ? undefined : worktree.id);
                  }}
                >
                  <MoreVertical aria-hidden="true" size={17} strokeWidth={1.75} />
                </button>
                {openMenuId === worktree.id && (
                  <WorktreeChildMenu
                    root={props.root}
                    token={props.token}
                    child={worktree}
                    onClose={() => closeMenu(worktree.id)}
                    onChanged={() => {
                      props.onChildChanged?.();
                      closeMenu(worktree.id);
                    }}
                    onRemoved={() => {
                      props.onChildRemoved?.(worktree.id);
                      closeMenu(worktree.id);
                    }}
                  />
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
// harn:end native-worktree-rail-is-axe-valid
// harn:end registered-worktree-navigation-is-promotion-gated

// harn:assume worktree-lifecycle-ui-follows-branch-identity ref=worktree-lifecycle-dialogs
type DialogState = 'idle' | 'busy' | { error: string };

function dialogError(state: DialogState): string | undefined {
  return typeof state === 'object' ? state.error : undefined;
}

/** Create collects a new local branch, a missing absolute target, and the
 * optional accepted default roster. The branch is the only user-facing name. */
export function WorktreeCreateDialog(props: {
  root: string;
  token: () => string;
  onClose: () => void;
  onCreated: (worktree: RegisteredWorktree) => void;
}) {
  const [branch, setBranch] = useState('');
  const [path, setPath] = useState('');
  const [useRoster, setUseRoster] = useState(false);
  const [state, setState] = useState<DialogState>('idle');

  const submit = (): void => {
    setState('busy');
    void createWorktree(props.root, {
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
        {/* harn:assume worktree-lifecycle-ui-follows-branch-identity ref=worktree-default-roster-choice-copy */}
        <DefaultRosterChoice
          token={props.token}
          selected={useRoster}
          onSelectedChange={setUseRoster}
          idPrefix="worktree-create"
          title="Default roster"
          note="Seed only this new worktree with the saved ordered group."
        />
        {/* harn:end worktree-lifecycle-ui-follows-branch-identity */}
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
            disabled={state === 'busy' || branch.trim() === '' || path.trim() === ''}
            onClick={submit}
          >
            {state === 'busy' ? 'Creating…' : 'Create worktree'}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}

/** Find runs read-only discovery only after it opens, requires one selected
 * candidate, and never bulk-adopts. The discovered branch owns its name. */
export function WorktreeFindDialog(props: {
  root: string;
  token: () => string;
  onClose: () => void;
  onAdopted: (worktree: RegisteredWorktree) => void;
}) {
  const [candidates, setCandidates] = useState<WorktreeDiscoveryCandidate[]>();
  const [loadError, setLoadError] = useState<string>();
  const [selected, setSelected] = useState<string>();
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
    if (selectedCandidate === undefined) return;
    setState('busy');
    void adoptWorktree(props.root, {
      path: selectedCandidate.path,
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
                  onClick={() => setSelected(candidate.path)}
                >
                  <span className="nx-wt-candidate-branch">{candidate.branch ?? '(detached)'}</span>
                  <span className="nx-wt-candidate-path">{candidate.path}</span>
                </button>
              </li>
            ))}
          </ul>
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
            disabled={state === 'busy' || selectedCandidate === undefined}
            onClick={adopt}
          >
            {state === 'busy' ? 'Adopting…' : 'Adopt selected'}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}

/** One child's deliberate acts stay in a small anchored menu. Filesystem
 * removal still requires a fresh preview and a second explicit confirmation. */
export function WorktreeChildMenu(props: {
  root: string;
  token: () => string;
  child: RegisteredWorktree;
  onClose: () => void;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const { child } = props;
  const menuRef = useRef<HTMLDivElement>(null);
  const tokenRef = useRef(props.token);
  tokenRef.current = props.token;
  const [mode, setMode] = useState<'actions' | 'unregister' | 'remove'>('actions');
  const [unregisterConfirm, setUnregisterConfirm] = useState(false);
  const [unregisterState, setUnregisterState] = useState<DialogState>('idle');
  const [preview, setPreview] = useState<WorktreeRemovalPreviewResponse>();
  const [previewError, setPreviewError] = useState<string>();
  const [removeState, setRemoveState] = useState<DialogState>('idle');
  const previewGeneration = useRef(0);

  const closeAndRestoreFocus = useCallback((): void => {
    props.onClose();
    const restore = (): void => {
      document.querySelector<HTMLButtonElement>(
        `[data-testid="worktree-menu-trigger-${child.id}"]`,
      )?.focus();
    };
    requestAnimationFrame(() => {
      restore();
      globalThis.setTimeout(restore, 50);
    });
  }, [child.id, props.onClose]);

  const loadPreview = useCallback((): void => {
    const current = ++previewGeneration.current;
    setPreviewError(undefined);
    setPreview(undefined);
    void previewWorktreeRemoval(props.root, child.id, { token: tokenRef.current() }).then((result) => {
      if (current !== previewGeneration.current) return;
      setPreview(result);
    }).catch((failure: unknown) => {
      if (current !== previewGeneration.current) return;
      setPreview(undefined);
      setPreviewError(failure instanceof Error ? failure.message : String(failure));
    });
  }, [props.root, child.id]);

  useEffect(() => {
    const first = menuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])');
    first?.focus();
    const onPointerDown = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) {
        // Keep the opener as the active element after the browser would
        // otherwise move focus to the outside click target.
        event.preventDefault();
        closeAndRestoreFocus();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeAndRestoreFocus();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [closeAndRestoreFocus]);

  useEffect(() => {
    const first = menuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])');
    first?.focus();
  }, [mode, preview, previewError]);

  const unregisterSelected = (): void => {
    setUnregisterState('busy');
    void unregisterWorktree(props.root, child.id, { token: tokenRef.current() }).then(() => {
      props.onChanged();
      props.onClose();
    }).catch((failure: unknown) => {
      setUnregisterState({ error: failure instanceof Error ? failure.message : String(failure) });
    });
  };

  const removeSelected = (): void => {
    setRemoveState('busy');
    void removeWorktree(props.root, child.id, { token: tokenRef.current() }).then(() => {
      props.onRemoved();
      props.onClose();
    }).catch((failure: unknown) => {
      setRemoveState({ error: failure instanceof Error ? failure.message : String(failure) });
      loadPreview();
    });
  };

  const previewReady = preview?.state === 'clean';
  const menuLabel = `Manage worktree ${child.branch ?? 'detached'}`;

  return (
    <div
      ref={menuRef}
      id={`worktree-menu-${child.id}`}
      className="nx-wt-menu"
      role="menu"
      aria-label={menuLabel}
      data-testid={`worktree-menu-${child.id}`}
    >
      <div className="nx-wt-menu-head" role="presentation">
        <strong>{child.branch ?? 'Detached HEAD'}</strong>
        <span className="nx-wt-menu-note">Managed by stable id</span>
      </div>
      {mode === 'actions' && (
        <div className="nx-wt-menu-actions" role="group" aria-label="Worktree actions">
          <button
            type="button"
            role="menuitem"
            className="nx-wt-menu-item"
            data-testid="worktree-unregister-open"
            onClick={() => {
              setMode('unregister');
              setUnregisterConfirm(true);
              setUnregisterState('idle');
            }}
          >
            Unregister
          </button>
          <button
            type="button"
            role="menuitem"
            className="nx-wt-menu-item"
            data-testid="worktree-remove-open"
            onClick={() => {
              setMode('remove');
              setRemoveState('idle');
              loadPreview();
            }}
          >
            Remove from disk
          </button>
        </div>
      )}
      {mode === 'unregister' && unregisterConfirm && (
        <div className="nx-wt-menu-confirm" role="group" aria-label="Confirm unregister" data-testid="worktree-unregister-confirm">
          <p className="nx-wt-menu-copy">
            Remove the registration only. The checkout, branch, and child transcript stay unchanged.
          </p>
          {dialogError(unregisterState) !== undefined && (
            <p className="nx-wt-menu-error" role="alert" data-testid="worktree-unregister-error">
              {dialogError(unregisterState)}
            </p>
          )}
          <div className="nx-wt-menu-buttons">
            <button
              type="button"
              role="menuitem"
              className="nx-wt-menu-item is-danger"
              data-testid="worktree-unregister-submit"
              disabled={unregisterState === 'busy'}
              onClick={unregisterSelected}
            >
              {unregisterState === 'busy' ? 'Unregistering…' : 'Confirm unregister'}
            </button>
            <button
              type="button"
              role="menuitem"
              className="nx-wt-menu-item"
              onClick={() => { setMode('actions'); setUnregisterConfirm(false); }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {mode === 'remove' && (
        <div className="nx-wt-menu-confirm" role="group" aria-label="Confirm removal" data-testid="worktree-remove-confirm">
          <p className="nx-wt-menu-copy">Check the current checkout before removing its files.</p>
          {preview === undefined && previewError === undefined && (
            <p className="nx-wt-menu-copy" role="status" data-testid="worktree-preview-loading">
              Checking worktree state…
            </p>
          )}
          {previewError !== undefined && (
            <div className="nx-wt-menu-error" role="alert" data-testid="worktree-preview-error">
              <span>{previewError}</span>
              <button type="button" role="menuitem" className="nx-wt-menu-item" data-testid="worktree-preview-retry" onClick={loadPreview}>Retry</button>
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
            <p className="nx-wt-menu-error" role="alert" data-testid="worktree-remove-error">
              {dialogError(removeState)}
            </p>
          )}
          <div className="nx-wt-menu-buttons">
            {previewReady && (
              <button
                type="button"
                role="menuitem"
                className="nx-wt-menu-item is-danger"
                data-testid="worktree-remove-submit"
                disabled={removeState === 'busy'}
                onClick={removeSelected}
              >
                {removeState === 'busy' ? 'Removing…' : 'Remove files — branch preserved'}
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className="nx-wt-menu-item"
              data-testid="worktree-remove-cancel"
              onClick={() => { setMode('actions'); }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
// Keep the old local export name source-compatible for focused consumers; it
// now renders the anchored menu rather than a modal.
export const WorktreeChildDialog = WorktreeChildMenu;
// harn:end worktree-lifecycle-ui-follows-branch-identity
