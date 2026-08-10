// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RegisteredWorktree } from '@codor/protocol';

const api = vi.hoisted(() => ({
  fetchRegisteredWorktrees: vi.fn(),
  discoverWorktrees: vi.fn(),
  adoptWorktree: vi.fn(),
  createWorktree: vi.fn(),
  updateWorktreeAlias: vi.fn(),
  previewWorktreeRemoval: vi.fn(),
  unregisterWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  fetchAgentPresets: vi.fn(),
  fetchDefaultRoster: vi.fn(),
}));
vi.mock('@runtime/api.js', () => api);

const { resetClientStoreForTest, roomSlice, useClientStore } = await import('../app/store.js');
const {
  useWorktreeGroup,
  WorktreeChildDialog,
  WorktreeCreateDialog,
  WorktreeFindDialog,
  WorktreeGroupSection,
} = await import('./WorktreeGroup.js');

const repository = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAA',
  room: 'eng',
  common_path: '/repo/.git',
  primary_path: '/repo',
  primary_git_admin_id: '/repo/.git',
  created_ts: '2026-08-07T00:00:00.000Z',
  updated_ts: '2026-08-07T00:00:00.000Z',
};

const record = (id: string, alias: string, primary: boolean): RegisteredWorktree => ({
  id,
  repository_id: repository.id,
  room: 'eng',
  conversation_id: primary ? 'eng' : `wt-${id.toLowerCase()}`,
  alias,
  path: primary ? '/repo' : `/repo-${alias}`,
  git_admin_id: primary ? '/repo/.git' : `/repo/.git/worktrees/${alias}`,
  primary,
  source: primary ? 'main' : 'adopted',
  lifecycle: 'active',
  availability: 'available',
  locked: false,
  branch: primary ? 'main' : `feature/${alias}`,
  registered_ts: repository.created_ts,
  updated_ts: repository.updated_ts,
});

const MAIN = record('01ARZ3NDEKTSV4RRFFQ69G5FAB', 'main', true);
const ALPHA = record('01ARZ3NDEKTSV4RRFFQ69G5FAC', 'alpha', false);
const BRAVO = record('01ARZ3NDEKTSV4RRFFQ69G5FAD', 'bravo', false);

let host: HTMLDivElement;
let root: Root | undefined;

const mount = async (node: React.ReactElement): Promise<void> => {
  root = createRoot(host);
  await act(async () => { root!.render(node); });
  await act(async () => { await Promise.resolve(); });
};

const flush = async (): Promise<void> => {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
};

const click = async (element: Element | null): Promise<void> => {
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
};

const type = async (element: Element | null, value: string): Promise<void> => {
  await act(async () => {
    const input = element as HTMLInputElement;
    // React's controlled-input tracker needs the NATIVE setter for onChange.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
};

const byTestId = (id: string): Element | null => host.querySelector(`[data-testid="${id}"]`)
  ?? document.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  resetClientStoreForTest();
  vi.clearAllMocks();
  api.fetchAgentPresets.mockResolvedValue([]);
  api.fetchDefaultRoster.mockResolvedValue({
    id: 'default', schema_version: 1, preset_ids: [], updated_ts: '2026-08-07T00:00:00.000Z',
  });
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  host.remove();
});

// harn:assume registered-worktree-navigation-is-promotion-gated ref=worktree-group-unit-regression
describe('worktree group state and navigation', () => {
  const Probe = (props: { room: string }) => {
    const group = useWorktreeGroup(props.room, () => 'token');
    return (
      <output
        data-testid="probe"
        data-promoted={String(group.promoted)}
        data-loaded={String(group.loaded)}
        data-error={group.error ?? ''}
      >
        {group.registered.map((worktree) => worktree.alias).join(',')}
      </output>
    );
  };

  it('keeps an ordinary channel unpromoted and marks the first secondary as promotion', async () => {
    useClientStore.getState().setConnected(true);
    api.fetchRegisteredWorktrees.mockResolvedValue({ repository: null, registered: [] });
    await mount(<Probe room="eng" />);
    const probe = byTestId('probe')!;
    expect(probe.getAttribute('data-promoted')).toBe('false');
    expect(probe.getAttribute('data-loaded')).toBe('true');
    expect(probe.textContent).toBe('');

    api.fetchRegisteredWorktrees.mockResolvedValue({ repository, registered: [MAIN, ALPHA] });
    await act(async () => { useClientStore.getState().setConnected(false); });
    await act(async () => { useClientStore.getState().setConnected(true); });
    await flush();
    expect(probe.getAttribute('data-promoted')).toBe('true');
    expect(probe.textContent).toBe('main,alpha');
  });

  it('retains the last-good group through a transient failure and reports the error', async () => {
    useClientStore.getState().setConnected(true);
    api.fetchRegisteredWorktrees.mockResolvedValue({ repository, registered: [MAIN, ALPHA] });
    await mount(<Probe room="eng" />);
    expect(byTestId('probe')!.textContent).toBe('main,alpha');

    api.fetchRegisteredWorktrees.mockRejectedValue(new Error('socket down'));
    await act(async () => { useClientStore.getState().setConnected(false); });
    await act(async () => { useClientStore.getState().setConnected(true); });
    await flush();
    expect(byTestId('probe')!.textContent).toBe('main,alpha');
    expect(byTestId('probe')!.getAttribute('data-error')).toBe('socket down');
  });

  // harn:assume worktree-child-conversations-stay-nested-and-isolated ref=worktree-nested-row-unit-regression
  it('renders only active children, selects by stable id, and gates controls by role', async () => {
    const selected: (string | undefined)[] = [];
    const group = {
      registered: [MAIN, ALPHA, BRAVO],
      children: [ALPHA, BRAVO],
      promoted: true,
      loaded: true,
      refresh: () => Promise.resolve(),
    };
    await mount(
      <WorktreeGroupSection
        root="eng"
        token={() => 'token'}
        group={group}
        selectedWorktree={ALPHA.id}
        readiness={() => 'connected'}
        canManage={false}
        onSelect={(id) => selected.push(id)}
        onOpenDialog={() => undefined}
      />,
    );
    expect(byTestId('worktree-group')).not.toBeNull();
    expect(byTestId(`worktree-link-${ALPHA.id}`)?.getAttribute('aria-current')).toBe('page');
    expect(byTestId(`worktree-link-${BRAVO.id}`)?.getAttribute('aria-current')).toBeNull();
    expect(byTestId(`worktree-branch-${ALPHA.id}`)?.textContent).toBe(ALPHA.branch);
    expect(byTestId(`worktree-branch-${ALPHA.id}`)?.textContent).not.toBe(ALPHA.alias);
    expect(byTestId(`worktree-connection-${ALPHA.id}`)?.textContent).toBe('');
    expect(byTestId(`worktree-connection-${ALPHA.id}`)?.getAttribute('aria-label')).toBe('Connected');
    // Copied/new-tab hrefs carry BOTH the public root and the stable child id.
    expect(byTestId(`worktree-link-${ALPHA.id}`)?.getAttribute('href'))
      .toBe(`/?room=eng&worktree=${encodeURIComponent(ALPHA.id)}`);
    expect(byTestId(`worktree-link-${BRAVO.id}`)?.getAttribute('href'))
      .toBe(`/?room=eng&worktree=${encodeURIComponent(BRAVO.id)}`);
    // Role gating: no mutation controls for members.
    expect(byTestId('worktree-create-open')).toBeNull();
    expect(byTestId('worktree-find-open')).toBeNull();
    expect(byTestId(`worktree-manage-${ALPHA.id}`)).toBeNull();

    await click(byTestId(`worktree-link-${BRAVO.id}`));
    expect(selected).toEqual([BRAVO.id]);
  });
  // harn:end worktree-child-conversations-stay-nested-and-isolated

  // harn:assume worktree-rail-uses-branch-only-compact-status ref=worktree-branch-status-unit-regression
  it('shows connection independently of working, availability, and unread', async () => {
    const missing = { ...BRAVO, availability: 'missing' as const };
    const group = {
      registered: [MAIN, ALPHA, missing],
      children: [ALPHA, missing],
      promoted: true,
      loaded: true,
      refresh: () => Promise.resolve(),
    };
    // ALPHA's room is working with unread mail — last-good content that must
    // stay visible WHILE the row honestly reads offline.
    const prior = useClientStore.getState();
    useClientStore.setState({
      rooms: {
        ...prior.rooms,
        [ALPHA.conversation_id]: {
          ...roomSlice(prior, ALPHA.conversation_id),
          members: {
            a1: { id: 'a1', kind: 'agent', state: 'running', handle: 'coder' },
          },
          support: { room: ALPHA.conversation_id, summary: { unread: 3, attention: false } },
        },
      },
    } as never);
    await mount(
      <WorktreeGroupSection
        root="eng"
        token={() => 'token'}
        group={group}
        selectedWorktree={undefined}
        readiness={(conversation) => conversation === ALPHA.conversation_id ? 'offline' : 'connecting'}
        canManage={true}
        onSelect={() => undefined}
        onOpenDialog={() => undefined}
      />,
    );
    // Activity and connection are separate accessible indicators: one never
    // masks the other or spends a narrow row on status prose.
    expect(byTestId(`worktree-status-${ALPHA.id}`)?.textContent).toBe('');
    expect(byTestId(`worktree-status-${ALPHA.id}`)?.getAttribute('aria-label')).toBe('Working');
    expect(byTestId(`worktree-connection-${ALPHA.id}`)?.textContent).toBe('');
    expect(byTestId(`worktree-connection-${ALPHA.id}`)?.getAttribute('aria-label')).toBe('Unavailable');
    expect(byTestId(`worktree-unread-${ALPHA.id}`)?.textContent).toBe('3');
    expect(byTestId(`worktree-status-${BRAVO.id}`)?.textContent).toBe('');
    expect(byTestId(`worktree-status-${BRAVO.id}`)?.getAttribute('aria-label')).toBe('Checkout unavailable');
    expect(byTestId(`worktree-connection-${BRAVO.id}`)?.textContent).toBe('');
    expect(byTestId(`worktree-connection-${BRAVO.id}`)?.getAttribute('aria-label')).toBe('Connecting');
    expect(byTestId('worktree-group')?.textContent).not.toContain('Live');
    expect(byTestId('worktree-create-open')).not.toBeNull();
    expect(byTestId('worktree-find-open')).not.toBeNull();
  });
  // harn:end worktree-rail-uses-branch-only-compact-status

  it('re-renders a row when current-generation live evidence lands in the store', async () => {
    const group = {
      registered: [MAIN, ALPHA],
      children: [ALPHA],
      promoted: true,
      loaded: true,
      refresh: () => Promise.resolve(),
    };
    await mount(
      <WorktreeGroupSection
        root="eng"
        token={() => 'token'}
        group={group}
        selectedWorktree={undefined}
        readiness={() => useClientStore.getState().roomLive[ALPHA.conversation_id] === true
          ? 'connected'
          : 'connecting'}
        canManage={false}
        onSelect={() => undefined}
        onOpenDialog={() => undefined}
      />,
    );
    expect(byTestId(`worktree-connection-${ALPHA.id}`)?.getAttribute('aria-label')).toBe('Connecting');
    await act(async () => {
      useClientStore.getState().markRoomLive(ALPHA.conversation_id);
      await Promise.resolve();
    });
    expect(byTestId(`worktree-connection-${ALPHA.id}`)?.getAttribute('aria-label')).toBe('Connected');
    await act(async () => {
      useClientStore.getState().markRoomsConnecting([ALPHA.conversation_id]);
      await Promise.resolve();
    });
    expect(byTestId(`worktree-connection-${ALPHA.id}`)?.getAttribute('aria-label')).toBe('Connecting');
  });
});
// harn:end registered-worktree-navigation-is-promotion-gated

// harn:assume native-worktree-rail-is-axe-valid ref=worktree-rail-unit-regression
describe('native worktree rail accessibility structure', () => {
  it('uses direct list rows with a link and adjacent manage control', async () => {
    const group = {
      registered: [MAIN, ALPHA, BRAVO],
      children: [ALPHA, BRAVO],
      promoted: true,
      loaded: true,
      refresh: () => Promise.resolve(),
    };
    await mount(
      <WorktreeGroupSection
        root="eng"
        token={() => 'token'}
        group={group}
        selectedWorktree={undefined}
        readiness={() => 'connected'}
        canManage={true}
        onSelect={() => undefined}
        onOpenDialog={() => undefined}
      />,
    );

    const groupElement = byTestId('worktree-group')!;
    const list = groupElement.querySelector('ul.nx-wt-list')!;
    const rows = Array.from(list.children);
    expect(rows.map((row) => row.tagName)).toEqual(['LI', 'LI']);
    for (const row of rows) {
      expect(row.classList.contains('nx-wt-item')).toBe(true);
      expect(row.querySelector('li')).toBeNull();
      expect(Array.from(row.children).map((child) => child.tagName)).toEqual(['A', 'BUTTON']);
    }
    expect(groupElement.querySelector('.nx-wt-group-label')?.textContent).toBe('Worktrees');
  });
});
// harn:end native-worktree-rail-is-axe-valid

// harn:assume worktree-lifecycle-ui-is-explicit-and-recoverable ref=worktree-lifecycle-unit-regression
describe('worktree lifecycle dialogs', () => {
  it('discovers only after Find opens and requires one selected candidate', async () => {
    expect(api.discoverWorktrees).not.toHaveBeenCalled();
    api.discoverWorktrees.mockResolvedValue({
      repository,
      registered: [MAIN],
      discovered: [
        { path: '/repo-free', git_admin_id: '/repo/.git/worktrees/free', primary: false, availability: 'available', locked: false, branch: 'feature/free' },
        { path: '/repo-taken', git_admin_id: '/repo/.git/worktrees/taken', primary: false, availability: 'available', locked: false, branch: 'feature/taken', registered_id: ALPHA.id },
        { path: '/repo', git_admin_id: '/repo/.git', primary: true, availability: 'available', locked: false },
      ],
    });
    api.adoptWorktree.mockResolvedValue({ repository, worktree: ALPHA });
    const adopted: RegisteredWorktree[] = [];
    await mount(
      <WorktreeFindDialog
        root="eng"
        token={() => 'token'}
        onClose={() => undefined}
        onAdopted={(worktree) => adopted.push(worktree)}
      />,
    );
    await flush();
    expect(api.discoverWorktrees).toHaveBeenCalledTimes(1);
    // Only the unregistered, non-primary, available candidate is offered.
    expect(byTestId('worktree-candidate-feature/free')).not.toBeNull();
    expect(byTestId('worktree-candidate-feature/taken')).toBeNull();
    expect((byTestId('worktree-adopt-submit') as HTMLButtonElement).disabled).toBe(true);

    await click(byTestId('worktree-candidate-feature/free'));
    expect((byTestId('worktree-adopt-alias') as HTMLInputElement).value).toBe('feature/free');
    // Adoption requires a NONEMPTY alias: clearing the prefilled branch name
    // disables the act, and a blank alias never reaches the server.
    await type(byTestId('worktree-adopt-alias'), '   ');
    expect((byTestId('worktree-adopt-submit') as HTMLButtonElement).disabled).toBe(true);
    await click(byTestId('worktree-adopt-submit'));
    expect(api.adoptWorktree).not.toHaveBeenCalled();
    await type(byTestId('worktree-adopt-alias'), 'Free Review');
    expect((byTestId('worktree-adopt-submit') as HTMLButtonElement).disabled).toBe(false);
    await click(byTestId('worktree-adopt-submit'));
    await flush();
    expect(api.adoptWorktree).toHaveBeenCalledWith(
      'eng',
      { path: '/repo-free', alias: 'Free Review' },
      expect.anything(),
    );
    expect(adopted).toHaveLength(1);
  });

  it('keeps the Find dialog and draft on failure', async () => {
    api.discoverWorktrees.mockResolvedValue({
      repository,
      registered: [MAIN],
      discovered: [
        { path: '/repo-free', git_admin_id: '/repo/.git/worktrees/free', primary: false, availability: 'available', locked: false, branch: 'feature/free' },
      ],
    });
    api.adoptWorktree.mockRejectedValue(new Error('worktree alias is already in use: free'));
    await mount(
      <WorktreeFindDialog root="eng" token={() => 'token'} onClose={() => undefined} onAdopted={() => undefined} />,
    );
    await flush();
    await click(byTestId('worktree-candidate-feature/free'));
    await click(byTestId('worktree-adopt-submit'));
    await flush();
    expect(byTestId('worktree-adopt-error')?.textContent).toContain('already in use');
    expect(byTestId('worktree-find-dialog')).not.toBeNull();
    expect((byTestId('worktree-adopt-alias') as HTMLInputElement).value).toBe('feature/free');
  });

  it('sends the literal roster opt-in only when selected and validates the draft', async () => {
    api.createWorktree.mockResolvedValue({ repository, worktree: ALPHA });
    await mount(
      <WorktreeCreateDialog root="eng" token={() => 'token'} onClose={() => undefined} onCreated={() => undefined} />,
    );
    expect((byTestId('worktree-create-submit') as HTMLButtonElement).disabled).toBe(true);
    await type(byTestId('worktree-create-alias'), 'Created');
    await type(byTestId('worktree-create-branch'), 'feature/created');
    await type(byTestId('worktree-create-path'), '/repo-created');
    expect((byTestId('worktree-create-submit') as HTMLButtonElement).disabled).toBe(false);
    await click(byTestId('worktree-create-submit'));
    await flush();
    expect(api.createWorktree).toHaveBeenCalledWith(
      'eng',
      { alias: 'Created', branch: 'feature/created', path: '/repo-created' },
      expect.anything(),
    );
  });

  it('gates filesystem removal behind a fresh clean preview and a second confirmation', async () => {
    api.previewWorktreeRemoval.mockResolvedValue({
      repository, worktree: ALPHA, state: 'dirty', branch_preserved: true, detail: 'untracked files',
    });
    await mount(
      <WorktreeChildDialog
        root="eng"
        token={() => 'token'}
        child={ALPHA}
        onClose={() => undefined}
        onChanged={() => undefined}
        onRemoved={() => undefined}
      />,
    );
    await flush();
    expect(byTestId('worktree-preview-state')?.textContent).toContain('dirty');
    expect(byTestId('worktree-preview-state')?.textContent).toContain('branch is always preserved');
    expect((byTestId('worktree-remove-open') as HTMLButtonElement).disabled).toBe(true);

    // A clean preview enables the destructive step; the act itself still
    // requires the second explicit confirmation.
    await act(async () => { root?.unmount(); });
    root = undefined;
    api.previewWorktreeRemoval.mockResolvedValue({
      repository, worktree: ALPHA, state: 'clean', branch_preserved: true,
    });
    const removed: string[] = [];
    api.removeWorktree.mockResolvedValue({ repository, worktree: { ...ALPHA, lifecycle: 'removed' } });
    await mount(
      <WorktreeChildDialog
        root="eng"
        token={() => 'token'}
        child={ALPHA}
        onClose={() => undefined}
        onChanged={() => undefined}
        onRemoved={() => removed.push(ALPHA.id)}
      />,
    );
    await flush();
    expect((byTestId('worktree-remove-open') as HTMLButtonElement).disabled).toBe(false);
    await click(byTestId('worktree-remove-open'));
    expect(api.removeWorktree).not.toHaveBeenCalled();
    await click(byTestId('worktree-remove-submit'));
    await flush();
    expect(api.removeWorktree).toHaveBeenCalledWith('eng', ALPHA.id, expect.anything());
    expect(removed).toEqual([ALPHA.id]);
  });

  it('renames through the stable id and keeps the dialog on conflict', async () => {
    api.previewWorktreeRemoval.mockResolvedValue({
      repository, worktree: ALPHA, state: 'clean', branch_preserved: true,
    });
    api.updateWorktreeAlias.mockRejectedValue(new Error('worktree alias is already in use: bravo'));
    await mount(
      <WorktreeChildDialog
        root="eng"
        token={() => 'token'}
        child={ALPHA}
        onClose={() => undefined}
        onChanged={() => undefined}
        onRemoved={() => undefined}
      />,
    );
    await flush();
    await type(byTestId('worktree-rename-input'), 'bravo');
    await click(byTestId('worktree-rename-submit'));
    await flush();
    expect(api.updateWorktreeAlias).toHaveBeenCalledWith('eng', ALPHA.id, 'bravo', expect.anything());
    expect(byTestId('worktree-rename-error')?.textContent).toContain('already in use');
    expect(byTestId('worktree-child-dialog')).not.toBeNull();
  });
});
// harn:end worktree-lifecycle-ui-is-explicit-and-recoverable
