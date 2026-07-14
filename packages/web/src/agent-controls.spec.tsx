// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentControls, type AgentControlsValue } from './agent-controls.js';
import type { AdapterRegistration } from './api.js';

const DISTINCT = { 'read-only': 'plan', 'workspace-write': 'acceptEdits', 'full-access': 'bypassPermissions' };
// A harness that emits a flag only for full-access: the other two levels are NOT
// enforced by us — they defer to whatever that harness is configured to allow.
const DEFERS = { 'read-only': null, 'workspace-write': null, 'full-access': '--auto' };

const adapters = [
  // A harness that reported a short curated list.
  {
    id: 'claude-code',
    capabilities: {
      resume: true,
      thinking: true,
      thinking_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
      policies: DISTINCT,
    },
    models: ['haiku', 'sonnet', 'opus'],
    models_source: 'curated',
  },
  {
    id: 'codex',
    capabilities: {
      resume: true,
      thinking: true,
      thinking_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      policies: { ...DISTINCT, 'full-access': '--yolo' },
    },
  },
  // A harness that reported nothing at all.
  { id: 'gemini', capabilities: { resume: true, thinking: false, policies: DISTINCT } },
  // A harness that discovered many models from the operator's own providers, and that
  // cannot enforce either of the two lower permission levels.
  {
    id: 'opencode',
    capabilities: {
      resume: true,
      thinking: true,
      thinking_levels: ['low', 'medium', 'high'],
      policies: DEFERS,
    },
    models: Array.from({ length: 40 }, (_, index) => `openai/model-${String(index)}`),
    models_source: 'discovered',
  },
] as unknown as AdapterRegistration[];

// harn:assume agent-controls-shared-by-both-dialogs ref=agent-controls-unit-regression
describe('agent controls', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: AgentControlsValue;

  function Harness(props: { allowNone?: boolean }) {
    const [value, setValue] = useState<AgentControlsValue>({
      harness: 'claude-code',
      model: '',
      thinking: '',
      policy: 'read-only',
    });
    latest = value;
    return (
      <AgentControls
        adapters={adapters}
        idPrefix="t"
        allowNone={props.allowNone}
        value={value}
        onChange={setValue}
      />
    );
  }

  const render = (allowNone?: boolean): void => {
    act(() => root.render(<Harness allowNone={allowNone} />));
  };
  const at = <T extends HTMLElement>(testid: string): T | null =>
    container.querySelector<T>(`[data-testid="${testid}"]`);
  const click = (testid: string): void => {
    act(() => at(testid)!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders one tile per registered adapter', () => {
    render();
    for (const adapter of adapters) expect(at(`t-harness-${adapter.id}`)).not.toBeNull();
  });

  it('picks a reported model without typing', () => {
    render();
    click('t-model-opus');
    expect(latest.model).toBe('opus');
  });

  it('clears a model that belongs to the previous harness', () => {
    render();
    click('t-model-opus');
    click('t-harness-gemini');
    // An Anthropic alias would fail only once the gemini agent was already starting.
    expect(latest.model).toBe('');
  });

  it('offers a searchable list, not a button row, when the harness reports many models', () => {
    render();
    click('t-harness-opencode');
    expect(at('t-model-openai/model-0')).toBeNull();
    const search = at<HTMLInputElement>('t-model-search')!;
    expect(search.placeholder).toBe('Search 40 models');
    expect(container.querySelectorAll('#t-model-options option')).toHaveLength(40);
  });

  it('keeps the search mounted while it is being typed into', () => {
    render();
    click('t-harness-opencode');
    const search = at<HTMLInputElement>('t-model-search')!;
    // Every keystroke is a half-typed model. Treating that as "off-catalog" would
    // unmount the search box mid-search, which is what shipped in 03e03e8.
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(search, 'openai/mod');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(latest.model).toBe('openai/mod');
    expect(at('t-model-search')).not.toBeNull();
  });

  it('keeps a typed custom model when the selected harness is re-picked', () => {
    render();
    click('t-model-custom');
    const input = at<HTMLInputElement>('t-model-custom-input')!;
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(input, 'claude-sonnet-5-20260101');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(latest.model).toBe('claude-sonnet-5-20260101');

    // Re-picking the harness that is already selected is not a harness change.
    click('t-harness-claude-code');
    expect(latest.model).toBe('claude-sonnet-5-20260101');

    // Actually switching still clears it.
    click('t-harness-gemini');
    expect(latest.model).toBe('');
  });

  // harn:assume harness-declares-supported-thinking-levels ref=agent-thinking-level-regression
  it('offers only the selected harness native thinking levels', () => {
    render();
    for (const level of ['xhigh', 'max', 'ultracode']) {
      expect(at(`t-thinking-${level}`), `Claude should offer ${level}`).not.toBeNull();
    }
    expect(at('t-thinking-ultra')).toBeNull();

    click('t-thinking-ultracode');
    expect(latest.thinking).toBe('ultracode');
    click('t-harness-opencode');
    expect(latest.thinking).toBe('');
    expect(at('t-thinking-xhigh')).toBeNull();

    click('t-harness-codex');
    for (const level of ['xhigh', 'max', 'ultra']) {
      expect(at(`t-thinking-${level}`), `Codex should offer ${level}`).not.toBeNull();
    }
    expect(at('t-thinking-ultracode')).toBeNull();
  });
  // harn:end harness-declares-supported-thinking-levels

  it('strands no thinking level on a harness that cannot accept one', () => {
    render();
    click('t-thinking-high');
    expect(latest.thinking).toBe('high');
    click('t-harness-gemini');
    // gemini declares thinking:false, so every level button is disabled — a level
    // left behind here could never be cleared, and the spawn would be rejected.
    expect(latest.thinking).toBe('');
  });

  it('still offers the custom escape when the harness reported nothing', () => {
    render();
    click('t-harness-gemini');
    expect(at('t-model-note')).not.toBeNull();
    click('t-model-custom');
    expect(at('t-model-custom-input')).not.toBeNull();
  });

  it('disables the thinking row exactly when the adapter does not support it', () => {
    render();
    expect(at<HTMLButtonElement>('t-thinking-high')!.disabled).toBe(false);
    click('t-harness-gemini');
    expect(at<HTMLButtonElement>('t-thinking-high')!.disabled).toBe(true);
  });

  it('offers no-agent only where the dialog allows it', () => {
    render();
    expect(at('t-harness-none')).toBeNull();
    render(true);
    expect(at('t-harness-none')).not.toBeNull();
  });

  it('is the single agent-control surface in both dialogs', () => {
    // Two dialogs drifting apart is exactly what R2 exists to prevent.
    for (const dialog of ['components.tsx', 'shell.tsx']) {
      const source = readFileSync(`src/${dialog}`, 'utf8');
      expect(source, `${dialog} must render the shared controls`).toContain(
        "import { AgentControls } from './agent-controls.js'",
      );
      expect(source, `${dialog} must not keep its own harness picker`).not.toMatch(
        /data-testid="(spawn|create-room)-harness"/,
      );
    }
  });

  it('hardcodes no model id anywhere in the web package', () => {
    // Model ids churn. The adapter that spawns the harness is the only thing that
    // can know what it accepts, so every id must arrive over /api/adapters.
    const source = readFileSync('src/agent-controls.tsx', 'utf8');
    expect(source).not.toMatch(/claude-(opus|sonnet|haiku|fable)-|gpt-5|gemini-\d/);
  });
});
// harn:end agent-controls-shared-by-both-dialogs

// harn:assume one-control-chooses-an-agent-everywhere ref=shared-policy-control-regression
describe('the permission control tells the truth about the harness', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: AgentControlsValue;

  function Harness(props: { harness: string }) {
    const [value, setValue] = useState<AgentControlsValue>({
      harness: props.harness,
      model: '',
      thinking: '',
      policy: 'read-only',
    });
    latest = value;
    return <AgentControls adapters={adapters} idPrefix="t" value={value} onChange={setValue} />;
  }

  const render = (harness: string): void => {
    act(() => root.render(<Harness harness={harness} />));
  };
  const click = (testid: string): void => {
    act(() => {
      container.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)!.click();
    });
  };
  const text = (testid: string): string | undefined =>
    container.querySelector(`[data-testid="${testid}"]`)?.textContent ?? undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows what each level actually becomes on the selected harness', () => {
    render('claude-code');
    expect(text('t-policy-read-only-native')).toBe('plan');
    expect(text('t-policy-workspace-write-native')).toBe('acceptEdits');
    expect(text('t-policy-full-access-native')).toBe('bypassPermissions');
  });

  it('picks the policy through the one shared control', () => {
    render('claude-code');
    click('t-policy-full-access');
    expect(latest.policy).toBe('full-access');
  });

  it('warns on EITHER level a harness cannot enforce, not just read-only', () => {
    // The whole point: on opencode, workspace-write is no more enforced than read-only.
    // Warning about one and not the other would trade a false promise for a quieter one.
    render('opencode');
    expect(text('t-policy-deferred'), 'read-only must warn').toContain('does not take this setting');

    click('t-policy-workspace-write');
    expect(text('t-policy-deferred'), 'workspace-write must warn too').toContain('does not take this setting');

    click('t-policy-full-access');
    expect(text('t-policy-deferred'), 'full-access IS enforced, so it must not warn').toBeUndefined();
  });

  it('says plainly that an unenforced level is not enforced', () => {
    render('opencode');
    expect(text('t-policy-read-only-native')).toBe('not enforced');
    expect(text('t-policy-workspace-write-native')).toBe('not enforced');
    expect(text('t-policy-full-access-native')).toBe('--auto');
  });

  it('hardcodes no harness knowledge of its own', () => {
    // The mapping is the adapter's to declare. A native mode name spelled out in this
    // package would go stale silently — and this staleness is a safety one.
    const source = readFileSync('src/agent-controls.tsx', 'utf8');
    for (const native of ['acceptEdits', 'bypassPermissions', 'danger-full-access', 'auto_edit', 'yolo', '--allow-all']) {
      expect(source, `${native} belongs to the adapter, not the UI`).not.toContain(native);
    }
  });
});
