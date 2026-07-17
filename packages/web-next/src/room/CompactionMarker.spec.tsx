import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CompactionMarker, compactionMarkerLabel } from './CompactionMarker.js';

// harn:assume web-compaction-markers-upgrade-in-place ref=web-compaction-marker-regression
describe('CompactionMarker', () => {
  it('matches paseo labels for every marker state', () => {
    expect(compactionMarkerLabel({ status: 'loading' })).toBe('Compacting…');
    expect(compactionMarkerLabel({ status: 'completed', trigger: 'auto' }))
      .toBe('Context automatically compacted');
    expect(compactionMarkerLabel({ status: 'completed', trigger: 'manual' }))
      .toBe('Context manually compacted');
    expect(compactionMarkerLabel({ status: 'completed', preTokens: 12_345 }))
      .toBe('Context compacted (12K tokens)');
    expect(compactionMarkerLabel({ status: 'completed' })).toBe('Context compacted');
  });

  it('renders a loading divider with accessible status text', () => {
    const markup = renderToStaticMarkup(<CompactionMarker status="loading" />);
    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-label="Compacting…"');
    expect(markup).toContain('is-loading');
    expect(markup).toContain('nx-spin');
  });

  it('renders completed trigger and token metadata on the divider', () => {
    const markup = renderToStaticMarkup(
      <CompactionMarker status="completed" trigger="manual" preTokens={149_900} />,
    );
    expect(markup).toContain('Context manually compacted');
    expect(markup).toContain('data-trigger="manual"');
    expect(markup).toContain('data-pre-tokens="149900"');
    expect(markup).toContain('lucide-scissors');
  });
});
// harn:end web-compaction-markers-upgrade-in-place
