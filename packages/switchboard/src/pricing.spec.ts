import { describe, expect, it } from 'vitest';

import { estimateCostUsd, priceForModel } from './pricing.js';

// harn:assume estimate-price-table-matches-curated-models ref=estimate-price-regression
describe('estimateCostUsd', () => {
  it('uses the corrected GPT-5.5 standard rate', () => {
    expect(estimateCostUsd('gpt-5.5', {
      input_tokens: 200_000,
      output_tokens: 100_000,
    })).toBeCloseTo(4, 9);
  });

  it('uses the OpenAI long-context rate only above 272K input tokens', () => {
    expect(estimateCostUsd('gpt-5.6-luna', {
      input_tokens: 272_000,
      output_tokens: 10_000,
    })).toBeCloseTo(0.332, 9);
    expect(estimateCostUsd('gpt-5.6-luna', {
      input_tokens: 272_001,
      output_tokens: 10_000,
    })).toBeCloseTo(0.634002, 9);
  });

  it('uses the Gemini Pro long-context rate only above 200K input tokens', () => {
    expect(estimateCostUsd('gemini-3.1-pro-preview', {
      input_tokens: 200_000,
      output_tokens: 10_000,
    })).toBeCloseTo(0.52, 9);
    expect(estimateCostUsd('gemini-3.1-pro-preview', {
      input_tokens: 200_001,
      output_tokens: 10_000,
    })).toBeCloseTo(0.980004, 9);
  });

  it('retains the retired Gemini Pro spelling only as stored-history compatibility', () => {
    const usage = { input_tokens: 10_000, output_tokens: 1_000 };
    expect(estimateCostUsd('gemini-3-pro-preview', usage))
      .toBe(estimateCostUsd('gemini-3.1-pro-preview', usage));
  });

  it('matches aliases case-insensitively and does not guess an unknown model', () => {
    expect(priceForModel('GPT-5.6-SOL')).toEqual(priceForModel('gpt-5.6-sol'));
    expect(estimateCostUsd('auto', { input_tokens: 1_000, output_tokens: 1_000 }))
      .toBeUndefined();
    expect(estimateCostUsd(undefined, { input_tokens: 1_000, output_tokens: 1_000 }))
      .toBeUndefined();
  });
});
// harn:end estimate-price-table-matches-curated-models
