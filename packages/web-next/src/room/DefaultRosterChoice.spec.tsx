// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchAgentPresets: vi.fn(),
  fetchDefaultRoster: vi.fn(),
}));
vi.mock('@runtime/api.js', () => api);

const { DefaultRosterChoice } = await import('./DefaultRosterChoice.js');

const emptyRoster = {
  id: 'default',
  schema_version: 1,
  preset_ids: [],
  updated_ts: '2026-08-10T00:00:00.000Z',
};

const preset = {
  id: 'preset-1',
  label: 'Reviewer',
  handle: 'reviewer',
  harness: 'fake',
  display_name: 'Reviewer',
  policy: 'read-only',
  created_ts: '2026-08-10T00:00:00.000Z',
  updated_ts: '2026-08-10T00:00:00.000Z',
};

let host: HTMLDivElement;
let root: Root | undefined;

const mount = async (node: React.ReactElement): Promise<void> => {
  root = createRoot(host);
  await act(async () => { root!.render(node); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
};

const flush = async (): Promise<void> => {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
};

const byTestId = (id: string): Element | null => host.querySelector(`[data-testid="${id}"]`);

const click = async (element: Element | null): Promise<void> => {
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  vi.clearAllMocks();
  api.fetchAgentPresets.mockResolvedValue([]);
  api.fetchDefaultRoster.mockResolvedValue(emptyRoster);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  host.remove();
});

// harn:assume empty-default-roster-is-unconfigured-state ref=empty-roster-choice-regression
describe('DefaultRosterChoice empty and failure states', () => {
  it('does not render an empty roster as a selectable zero-agent choice', async () => {
    const onSelectedChange = vi.fn();
    const onSettings = vi.fn();
    await mount(
      <DefaultRosterChoice
        token={() => 'token'}
        selected={false}
        onSelectedChange={onSelectedChange}
        onSettings={onSettings}
        idPrefix="choice"
      />,
    );
    await flush();

    expect(byTestId('choice-roster-empty')).not.toBeNull();
    expect(byTestId('choice-roster-select')).toBeNull();
    expect(byTestId('choice-roster-empty')?.textContent).toContain('No default roster configured');
    await click(byTestId('choice-roster-settings'));
    expect(onSettings).toHaveBeenCalledOnce();
    expect(onSelectedChange).not.toHaveBeenCalled();
  });

  it('clears a stale selection when a previously selected roster becomes empty', async () => {
    const onSelectedChange = vi.fn();
    await mount(
      <DefaultRosterChoice
        token={() => 'token'}
        selected
        onSelectedChange={onSelectedChange}
        idPrefix="choice"
      />,
    );
    await flush();

    expect(byTestId('choice-roster-select')).toBeNull();
    expect(onSelectedChange).toHaveBeenCalledWith(false);
  });

  it('explains first-channel setup when Settings is not mounted', async () => {
    await mount(
      <DefaultRosterChoice
        token={() => 'token'}
        selected={false}
        onSelectedChange={vi.fn()}
        idPrefix="choice"
      />,
    );
    await flush();

    expect(byTestId('choice-roster-empty')?.textContent).toContain(
      'Create the first channel with Starting agent, then configure presets and the Default roster in Settings.',
    );
    expect(byTestId('choice-roster-settings')).toBeNull();
  });

  it('retains the selectable choice for a nonempty roster', async () => {
    api.fetchAgentPresets.mockResolvedValue([preset]);
    api.fetchDefaultRoster.mockResolvedValue({ ...emptyRoster, preset_ids: [preset.id] });
    const onSelectedChange = vi.fn();
    await mount(
      <DefaultRosterChoice
        token={() => 'token'}
        selected={false}
        onSelectedChange={onSelectedChange}
        idPrefix="choice"
      />,
    );
    await flush();

    expect(byTestId('choice-roster-select')).not.toBeNull();
    await click(byTestId('choice-roster-select'));
    expect(onSelectedChange).toHaveBeenCalledWith(true);
  });

  // harn:assume empty-roster-refresh-clears-selection-before-action ref=empty-roster-refresh-unit-regression
  it('invalidates a selected roster when refresh returns an empty roster', async () => {
    api.fetchAgentPresets.mockResolvedValueOnce([preset]).mockResolvedValue([]);
    api.fetchDefaultRoster
      .mockResolvedValueOnce({ ...emptyRoster, preset_ids: [preset.id] })
      .mockResolvedValue(emptyRoster);
    const onSelectedChange = vi.fn();
    await mount(
      <DefaultRosterChoice
        token={() => 'token'}
        selected
        onSelectedChange={onSelectedChange}
        idPrefix="choice"
      />,
    );
    await flush();

    expect(byTestId('choice-roster-select')).not.toBeNull();
    await click(byTestId('choice-roster-refresh'));
    await flush();

    expect(byTestId('choice-roster-empty')).not.toBeNull();
    expect(byTestId('choice-roster-select')).toBeNull();
    expect(onSelectedChange).toHaveBeenCalledWith(false);
  });
  // harn:end empty-roster-refresh-clears-selection-before-action

  it('keeps the Starting agent fallback and Retry action for transport failure', async () => {
    api.fetchAgentPresets.mockRejectedValue(new Error('temporary transport failure'));
    const onSelectedChange = vi.fn();
    await mount(
      <DefaultRosterChoice
        token={() => 'token'}
        selected
        onSelectedChange={onSelectedChange}
        idPrefix="choice"
      />,
    );
    await flush();

    expect(byTestId('choice-roster-error')?.textContent).toContain('Starting agent remains available');
    expect(byTestId('choice-roster-retry')).not.toBeNull();
    await click(byTestId('choice-roster-deselect'));
    expect(onSelectedChange).toHaveBeenCalledWith(false);
  });
});
// harn:end empty-default-roster-is-unconfigured-state
