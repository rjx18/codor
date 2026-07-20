import { describe, expect, it } from 'vitest';

import { costProvenanceLabel } from './spend-label.js';

describe('costProvenanceLabel', () => {
  it('keeps exact, estimated, and unknown provenance explicit', () => {
    expect(costProvenanceLabel({ cost_usd: 1.5 })).toBe('$1.50');
    expect(costProvenanceLabel({ cost_usd: 0, estimated_cost_usd: 2.25 }))
      .toBe('~$2.25 est.');
    expect(costProvenanceLabel({ cost_usd: 1.5, estimated_cost_usd: 2.25 }))
      .toBe('$1.50 exact + ~$2.25 est.');
    expect(costProvenanceLabel({ cost_usd: 0, uncosted_tokens: 1_500 }))
      .toBe('1.5K unpriced tokens');
    expect(costProvenanceLabel({
      cost_usd: 1.5,
      estimated_cost_usd: 2.25,
      uncosted_tokens: 1_500,
    })).toBe('$1.50 exact + ~$2.25 est. + 1.5K unpriced tokens');
  });

  it('shows a truthful zero when no cost bucket has usage', () => {
    expect(costProvenanceLabel({ cost_usd: 0 })).toBe('$0.00');
  });
});
