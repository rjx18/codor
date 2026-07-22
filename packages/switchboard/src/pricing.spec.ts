import { describe, expect, it } from 'vitest';

import { estimateCostUsd, priceForModel } from './pricing.js';

// harn:assume codex-price-table-models-cache-and-aliases ref=codex-price-regression
describe('estimateCostUsd', () => {
  it.each([
    ['gpt-5.6-luna', 0.124],
    ['gpt-5.6-terra', 0.31],
    ['gpt-5.6-sol', 0.62],
    ['gpt-5.5', 0.62],
  ])('uses current uncached/cached/output rates for %s', (model, expected) => {
    expect(estimateCostUsd(model, {
      input_tokens: 100_000,
      cached_input_tokens: 40_000,
      output_tokens: 10_000,
    })).toBeCloseTo(expected, 9);
  });

  it('uses the corrected GPT-5.5 standard rate', () => {
    expect(estimateCostUsd('gpt-5.5', {
      input_tokens: 200_000,
      output_tokens: 100_000,
    })).toBeCloseTo(4, 9);
  });

  it('prices cached Codex input separately from uncached input and output', () => {
    expect(estimateCostUsd('gpt-5.6-sol', {
      input_tokens: 1_000_000,
      cached_input_tokens: 400_000,
      output_tokens: 100_000,
    })).toBeCloseTo(10.9, 9);
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
    expect(priceForModel('gpt-5.6')).toEqual(priceForModel('gpt-5.6-sol'));
    expect(priceForModel('gpt-5.5-2026-04-23')).toEqual(priceForModel('gpt-5.5'));
    expect(estimateCostUsd('auto', { input_tokens: 1_000, output_tokens: 1_000 }))
      .toBeUndefined();
    expect(estimateCostUsd(undefined, { input_tokens: 1_000, output_tokens: 1_000 }))
      .toBeUndefined();
  });
});
// harn:end codex-price-table-models-cache-and-aliases
