// harn:assume tokens-only-harness-cost-is-estimated-from-a-price-table ref=estimated-cost-pricing
/**
 * USD cost estimates for harnesses that report token counts but no dollar cost
 * (codex, gemini, ...). Claude Code and opencode self-report exact cost and
 * never consult this table — their `usage.cost_usd` is authoritative.
 *
 * The GPT-5.6 and gemini rows are the providers' published per-token rates
 * (OpenAI GPT-5.6 sheet; Google's Gemini API pricing page, verified 2026-07).
 * They use each model's base tier — the ≤200k-context rate and the
 * text/image/video input rate — so a very long prompt or audio input is
 * under-estimated; this is a spend gauge, not billing. Estimates are always
 * surfaced flagged as "est." so an operator never mistakes one for a
 * self-reported charge, and an unknown model stays in the "uncosted tokens"
 * bucket rather than guessed. Edit the table to match your contract pricing.
 *
 * Rates are USD per 1,000,000 tokens.
 */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

const MILLION = 1_000_000;

/** Keyed by the model alias carried on `Member.model` (adapter model catalogs). */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // codex (OpenAI) — GPT-5.6 published rates (GA 2026-07-09); luna→terra→sol is
  // the cost-optimized→balanced→flagship ladder.
  'gpt-5.6-luna': { inputPerMTok: 1, outputPerMTok: 6 }, // cost-optimized tier
  'gpt-5.6-terra': { inputPerMTok: 2.5, outputPerMTok: 15 }, // balanced tier
  'gpt-5.6-sol': { inputPerMTok: 5, outputPerMTok: 30 }, // flagship tier
  'gpt-5.5': { inputPerMTok: 1.25, outputPerMTok: 10 }, // prior-gen flagship
  // gemini — Google's published rates; keys match the adapter's model catalog.
  'gemini-3-pro-preview': { inputPerMTok: 2, outputPerMTok: 12 }, // Gemini 3.x Pro Preview, ≤200k tier
  'gemini-3-flash-preview': { inputPerMTok: 0.5, outputPerMTok: 3 },
  'gemini-2.5-pro': { inputPerMTok: 1.25, outputPerMTok: 10 }, // ≤200k tier
  'gemini-2.5-flash': { inputPerMTok: 0.3, outputPerMTok: 2.5 },
};

export function priceForModel(model: string | undefined): ModelPrice | undefined {
  if (model === undefined) return undefined;
  return MODEL_PRICES[model] ?? MODEL_PRICES[model.toLowerCase()];
}

/**
 * Estimate USD cost from token counts for a tokens-only harness. Returns
 * `undefined` when the model is unknown/unpriced, so callers keep that usage
 * in the uncosted bucket instead of reporting a fabricated dollar figure.
 */
export function estimateCostUsd(
  model: string | undefined,
  usage: { input_tokens: number; output_tokens: number },
): number | undefined {
  const price = priceForModel(model);
  if (price === undefined) return undefined;
  return (
    (usage.input_tokens * price.inputPerMTok + usage.output_tokens * price.outputPerMTok) / MILLION
  );
}
// harn:end tokens-only-harness-cost-is-estimated-from-a-price-table
