import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AgentControls } from './AgentControls.js';
import type { AdapterLike, AgentConfig } from './agent-spec.js';

const adapter = (over: Partial<AdapterLike> = {}): AdapterLike => ({
  id: 'opencode',
  capabilities: { thinking: false },
  ...over,
});

const config = (over: Partial<AgentConfig> = {}): AgentConfig => ({
  harness: 'opencode', model: '', thinking: '', policy: '', ...over,
});

function render(adapters: AdapterLike[], current: AgentConfig): string {
  return renderToStaticMarkup(
    <AgentControls
      adapters={adapters}
      config={current}
      onChange={() => undefined}
      behaviourSection={2}
      permissionsSection={3}
      idPrefix="agent"
    />,
  );
}

// harn:assume adapters-own-their-model-catalog ref=adapter-model-discovery-dialog
describe('model discovery failure', () => {
  it('offers a retry when discovery failed instead of reporting no models', () => {
    // Requirement: a failed discovery reads as retryable, not as "no models".
    const markup = render([adapter({ models_error: 'timed out' })], config());
    expect(markup).toContain('data-testid="agent-model-error"');
    expect(markup).toContain('Press Refresh to retry');
    expect(markup).not.toContain('did not report a model list');
  });

  it('keeps the no-models note when discovery neither reported nor failed', () => {
    const markup = render([adapter()], config());
    expect(markup).toContain('did not report a model list');
    expect(markup).not.toContain('agent-model-error');
  });

  it('warns on a stale list after a later refresh failure', () => {
    // Requirement: a later failure keeps the working list but says so.
    const markup = render([adapter({ models: ['a/b'], models_error: 'timed out' })], config());
    expect(markup).toContain('data-testid="agent-model-stale"');
    expect(markup).toContain('a/b');
  });
});
