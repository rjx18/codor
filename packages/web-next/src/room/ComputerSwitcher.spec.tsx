// @vitest-environment happy-dom
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ manager: undefined as {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => unknown;
  activate: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
  forget: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
} | undefined }));
vi.mock('../runtime/relay-mode.js', () => ({ relayUrlConfigured: () => 'wss://relay.test' }));
vi.mock('../app/computer-sessions.js', () => ({ computerSessions: () => harness.manager }));

const { ComputerSwitcher } = await import('./ComputerSwitcher.js');

const view = (overrides: Record<string, unknown> = {}) => ({
  id: 'A',
  label: 'Desk',
  active: true,
  ready: true,
  connected: true,
  authRefused: false,
  unread: 0,
  attention: false,
  attentionCount: 0,
  working: 0,
  ...overrides,
});

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;

async function render(computers: unknown[]) {
  const snapshot = { activeId: 'A', computers };
  harness.manager = {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    activate: vi.fn(async () => true),
    add: vi.fn(async () => true),
    forget: vi.fn(async () => true),
    rename: vi.fn(async () => undefined),
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => { root!.render(<ComputerSwitcher />); });
}

async function openCustomize(id = 'A'): Promise<HTMLElement> {
  const testid = id === 'A' ? 'computer-current' : `computer-avatar-${id}`;
  const avatar = document.body.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement;
  avatar.focus();
  await act(async () => {
    avatar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
  return document.body.querySelector('[data-testid="computer-customize-modal"]') as HTMLElement;
}

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host?.remove();
  document.querySelectorAll('[data-testid$="-modal"]').forEach((node) => node.remove());
  harness.manager = undefined;
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('ComputerSwitcher avatar rail', () => {
  it('renders one avatar per computer with independent activity badges and truthful status', async () => {
    await render([
      view(),
      view({ id: 'B', label: 'Laptop', active: false, unread: 2, attention: true, attentionCount: 2, working: 1 }),
      view({ id: 'C', label: 'Offline', active: false, ready: false, connected: true, authRefused: true }),
    ]);
    expect(host!.querySelectorAll('[data-computer-avatar="true"]')).toHaveLength(3);
    expect(host!.querySelector('[data-testid="computer-avatar-unread-B"]')?.textContent).toBe('2');
    expect(host!.querySelector('[data-testid="computer-avatar-working-B"]')?.textContent).toBe('1');
    expect(host!.querySelector('[data-testid="computer-avatar-attention-B"]')?.textContent).toBe('2');
    expect(host!.querySelector('[data-testid="computer-avatar-unread-A"]')).toBeNull();
    expect(host!.querySelector('[data-testid="computer-avatar-working-A"]')).toBeNull();
    expect(host!.querySelector('[data-testid="computer-avatar-attention-A"]')).toBeNull();
    expect(host!.querySelector('.nx-computer-avatar-status')).toBeNull();
    expect(host!.querySelector('[data-testid="computer-current"] .nx-computer-avatar-tooltip')?.textContent).toBe('Desk');
    const active = host!.querySelector('[data-testid="computer-current"]') as HTMLButtonElement;
    expect(active.getAttribute('aria-label')).toContain('Desk, Active, Connected');
    expect(host!.querySelector('[data-testid="computer-avatar-C"]')?.getAttribute('aria-label')).toContain('Repair required');
    expect(host!.querySelector('.nx-computer-menu')).toBeNull();
  });

  it('activates a warm inactive computer without a popup or new presentation state', async () => {
    await render([view(), view({ id: 'B', label: 'Laptop', active: false })]);
    await act(async () => { (host!.querySelector('[data-testid="computer-avatar-B"]') as HTMLButtonElement).click(); });
    expect(harness.manager!.activate).toHaveBeenCalledWith('B');
  });

  it('opens the browser-local customization dialog from context menu and returns focus', async () => {
    await render([view()]);
    const modal = await openCustomize();
    expect(modal).not.toBeNull();
    expect(modal.contains(document.activeElement)).toBe(true);
    expect(modal.getAttribute('role')).toBe('dialog');
    expect(document.body.querySelectorAll('[role="menu"]')).toHaveLength(0);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.body.querySelector('[data-testid="computer-customize-modal"]')).toBeNull();
    expect(document.activeElement).toBe(host!.querySelector('[data-testid="computer-current"]'));
  });

  it('accepts Shift+F10 and persists icon/color choices independently per computer', async () => {
    await render([view(), view({ id: 'B', label: 'Laptop', active: false })]);
    const avatar = host!.querySelector('[data-testid="computer-avatar-B"]') as HTMLButtonElement;
    avatar.focus();
    await act(async () => { avatar.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })); });
    const modal = document.body.querySelector('[data-testid="computer-customize-modal"]') as HTMLElement;
    const cat = [...modal.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'Use 🐈 icon') as HTMLButtonElement;
    expect(cat).toBeTruthy();
    await act(async () => { cat.click(); });
    const color = modal.querySelector('[data-testid="computer-color-0f766e"]') as HTMLButtonElement;
    await act(async () => { color.click(); });
    expect(JSON.parse(window.localStorage.getItem('codor.computer-appearance.v1') ?? '{}')).toEqual({
      B: { glyph: '🐈', color: '#0f766e' },
    });
  });

  it('keeps the existing two-step Add Computer flow and Forget action', async () => {
    await render([view()]);
    await act(async () => { (host!.querySelector('[data-testid="computer-add"]') as HTMLButtonElement).click(); });
    const modal = document.body.querySelector('[data-testid="computer-add-modal"]') as HTMLElement;
    expect(modal.contains(document.activeElement)).toBe(true);
    expect(modal.querySelector('[data-testid="computer-add-step-1"]')).not.toBeNull();
    expect(modal.querySelector('[data-testid="computer-add-step-2"]')).not.toBeNull();
    expect(modal.textContent).toContain('single-use');
    expect(modal.textContent).toContain('ten minutes');
    await act(async () => { (modal.querySelector('[data-testid="computer-add-copy"]') as HTMLButtonElement).click(); });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('codor pair');

    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await openCustomize();
    await act(async () => {
      (document.querySelector('[data-testid="computer-glyph-🐈"]') as HTMLButtonElement).click();
    });
    expect(JSON.parse(window.localStorage.getItem('codor.computer-appearance.v1') ?? '{}')).toHaveProperty('A');
    await act(async () => { (document.querySelector('[data-testid="computer-forget-A"]') as HTMLButtonElement).click(); });
    expect(harness.manager!.forget).toHaveBeenCalledWith('A');
    expect(JSON.parse(window.localStorage.getItem('codor.computer-appearance.v1') ?? '{}')).not.toHaveProperty('A');
  });
});
