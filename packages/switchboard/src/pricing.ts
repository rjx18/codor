// harn:assume codex-price-table-models-cache-and-aliases ref=codex-price-table
/**
 * Public standard on-demand USD rates per 1,000,000 tokens, checked 2026-07-21.
 *
 * Sources:
 * - https://developers.openai.com/api/docs/models/gpt-5.6-sol
 * - https://developers.openai.com/api/docs/models/gpt-5.6-terra
 * - https://developers.openai.com/api/docs/models/gpt-5.6-luna
 * - https://developers.openai.com/api/docs/models/gpt-5.5
 * - https://ai.google.dev/gemini-api/docs/pricing
 * - https://ai.google.dev/gemini-api/docs/changelog
 *
 * OpenAI uses its higher full-request rate when input exceeds 272K tokens.
 * Gemini 3.1 Pro Preview and 2.5 Pro use their higher full-request rate when
 * input exceeds 200K tokens. These estimates do not model cache writes, audio,
 * batch, data-residency, negotiated, or other account-specific pricing. They
 * are an operator gauge, never a provider invoice.
 */
export interface TokenRate {
  inputPerMTok: number;
  cachedInputPerMTok?: number;
  outputPerMTok: number;
}

export interface ModelPrice {
  standard: TokenRate;
  longContext?: TokenRate & { aboveInputTokens: number };
}

const MILLION = 1_000_000;
const OPENAI_LONG_CONTEXT = 272_000;
const GEMINI_LONG_CONTEXT = 200_000;

const openAiPrice = (
  inputPerMTok: number,
  cachedInputPerMTok: number,
  outputPerMTok: number,
): ModelPrice => ({
  standard: { inputPerMTok, cachedInputPerMTok, outputPerMTok },
  longContext: {
    aboveInputTokens: OPENAI_LONG_CONTEXT,
    inputPerMTok: inputPerMTok * 2,
    cachedInputPerMTok: cachedInputPerMTok * 2,
    outputPerMTok: outputPerMTok * 1.5,
  },
});

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'gpt-5.6-luna': openAiPrice(1, 0.1, 6),
  'gpt-5.6-terra': openAiPrice(2.5, 0.25, 15),
  'gpt-5.6-sol': openAiPrice(5, 0.5, 30),
  'gpt-5.5': openAiPrice(5, 0.5, 30),
  'gemini-3.1-pro-preview': {
    standard: { inputPerMTok: 2, outputPerMTok: 12 },
    longContext: {
      aboveInputTokens: GEMINI_LONG_CONTEXT,
      inputPerMTok: 4,
      outputPerMTok: 18,
    },
  },
  // Stored-history compatibility only. The adapter catalog exposes 3.1.
  'gemini-3-pro-preview': {
    standard: { inputPerMTok: 2, outputPerMTok: 12 },
    longContext: {
      aboveInputTokens: GEMINI_LONG_CONTEXT,
      inputPerMTok: 4,
      outputPerMTok: 18,
    },
  },
  'gemini-3-flash-preview': {
    standard: { inputPerMTok: 0.5, outputPerMTok: 3 },
  },
  'gemini-2.5-pro': {
    standard: { inputPerMTok: 1.25, outputPerMTok: 10 },
    longContext: {
      aboveInputTokens: GEMINI_LONG_CONTEXT,
      inputPerMTok: 2.5,
      outputPerMTok: 15,
    },
  },
  'gemini-2.5-flash': {
    standard: { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  },
};

const MODEL_ALIASES: Readonly<Record<string, string>> = {
  'gpt-5.6': 'gpt-5.6-sol',
  'gpt-5.5-2026-04-23': 'gpt-5.5',
};

export function priceForModel(model: string | undefined): ModelPrice | undefined {
  if (model === undefined) return undefined;
  const normalized = model.toLowerCase();
  return MODEL_PRICES[MODEL_ALIASES[normalized] ?? normalized];
}

export function estimateCostUsd(
  model: string | undefined,
  usage: { input_tokens: number; cached_input_tokens?: number; output_tokens: number },
): number | undefined {
  const price = priceForModel(model);
  if (price === undefined) return undefined;
  const rate = price.longContext !== undefined && usage.input_tokens > price.longContext.aboveInputTokens
    ? price.longContext
    : price.standard;
  const cachedInputTokens = Math.min(usage.cached_input_tokens ?? 0, usage.input_tokens);
  const uncachedInputTokens = usage.input_tokens - cachedInputTokens;
  return (
    uncachedInputTokens * rate.inputPerMTok +
    cachedInputTokens * (rate.cachedInputPerMTok ?? rate.inputPerMTok) +
    usage.output_tokens * rate.outputPerMTok
  ) / MILLION;
}
// harn:end codex-price-table-models-cache-and-aliases
