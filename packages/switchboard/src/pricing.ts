// harn:assume estimate-price-table-matches-curated-models ref=estimate-price-table
/**
 * Public standard on-demand USD rates per 1,000,000 tokens, checked 2026-07-21.
 *
 * Sources:
 * - https://developers.openai.com/api/docs/models/compare
 * - https://developers.openai.com/api/docs/models/gpt-5.5
 * - https://ai.google.dev/gemini-api/docs/pricing
 * - https://ai.google.dev/gemini-api/docs/changelog
 *
 * OpenAI uses its higher full-request rate when input exceeds 272K tokens.
 * Gemini 3.1 Pro Preview and 2.5 Pro use their higher full-request rate when
 * input exceeds 200K tokens. These estimates intentionally do not model cached
 * input, audio, batch, data-residency, negotiated, or other account-specific
 * pricing. They are an operator gauge, never a provider invoice.
 */
export interface TokenRate {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface ModelPrice {
  standard: TokenRate;
  longContext?: TokenRate & { aboveInputTokens: number };
}

const MILLION = 1_000_000;
const OPENAI_LONG_CONTEXT = 272_000;
const GEMINI_LONG_CONTEXT = 200_000;

const openAiPrice = (inputPerMTok: number, outputPerMTok: number): ModelPrice => ({
  standard: { inputPerMTok, outputPerMTok },
  longContext: {
    aboveInputTokens: OPENAI_LONG_CONTEXT,
    inputPerMTok: inputPerMTok * 2,
    outputPerMTok: outputPerMTok * 1.5,
  },
});

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'gpt-5.6-luna': openAiPrice(1, 6),
  'gpt-5.6-terra': openAiPrice(2.5, 15),
  'gpt-5.6-sol': openAiPrice(5, 30),
  'gpt-5.5': openAiPrice(5, 30),
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

export function priceForModel(model: string | undefined): ModelPrice | undefined {
  if (model === undefined) return undefined;
  return MODEL_PRICES[model.toLowerCase()];
}

export function estimateCostUsd(
  model: string | undefined,
  usage: { input_tokens: number; output_tokens: number },
): number | undefined {
  const price = priceForModel(model);
  if (price === undefined) return undefined;
  const rate = price.longContext !== undefined && usage.input_tokens > price.longContext.aboveInputTokens
    ? price.longContext
    : price.standard;
  return (
    usage.input_tokens * rate.inputPerMTok + usage.output_tokens * rate.outputPerMTok
  ) / MILLION;
}
// harn:end estimate-price-table-matches-curated-models
