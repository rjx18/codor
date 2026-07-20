import { describe, expect, it } from 'vitest';

import { estimateCostUsd, priceForModel } from './pricing.js';

describe('estimateCostUsd', () => {
  it('prices a known tokens-only model from input+output rates', () => {
    // gpt-5.5: $1.25/Mtok in, $10/Mtok out.
    // 1_000_000 in + 100_000 out = 1.25 + 1.00 = 2.25
    expect(estimateCostUsd('gpt-5.5', { input_tokens: 1_000_000, output_tokens: 100_000 })).toBeCloseTo(
      2.25,
      6,
    );
  });

  it('is case-insensitive on the model alias', () => {
    expect(estimateCostUsd('GPT-5.5', { input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(
      1.25,
      6,
    );
  });

  it('returns undefined for an unknown/unpriced model so usage stays uncosted', () => {
    expect(estimateCostUsd('auto', { input_tokens: 1000, output_tokens: 1000 })).toBeUndefined();
    expect(estimateCostUsd(undefined, { input_tokens: 1000, output_tokens: 1000 })).toBeUndefined();
  });

  it('estimates zero for zero tokens on a priced model', () => {
    expect(estimateCostUsd('gemini-2.5-pro', { input_tokens: 0, output_tokens: 0 })).toBe(0);
  });

  it('exposes the rate table via priceForModel', () => {
    expect(priceForModel('gemini-3-pro-preview')).toEqual({ inputPerMTok: 2, outputPerMTok: 12 });
    expect(priceForModel('nope')).toBeUndefined();
  });
});
