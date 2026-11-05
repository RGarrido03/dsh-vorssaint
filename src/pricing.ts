/**
 * What one response billed, and what the plugin charges for it.
 *
 * Vorssaint values a DSH session from the `cost` the plugin writes, because
 * it has no DeepSeek price list of its own and DSH reports no price per call.
 * The plugin therefore ships no rates: a user opts in with the `pricing`
 * config, keyed by the exact model id the provider route reports (with `*`
 * as a fallback). Without a rate the feed still carries tokens; cost stays
 * absent rather than guessed.
 *
 * @module dsh-vorssaint/pricing
 */

/** Token counts in the shape both DSH and Vorssaint use. */
export interface TokenCounts {
  /** Prompt tokens that missed the cache. */
  input: number
  /** Prompt tokens written to the cache. */
  cacheWrite: number
  /** Prompt tokens served from the cache. */
  cacheRead: number
  /** Completion tokens; reasoning tokens are included. */
  output: number
  /** Reasoning tokens included in `output`, kept for display. */
  reasoning: number
}

/** US dollars per million tokens, as published by the provider. */
export interface ModelRate {
  input: number
  output: number
  /** Defaults to the input rate, as providers without a cache do. */
  cacheRead?: number
  cacheWrite?: number
}

/** Rates by exact model id; `*` is the fallback. */
export type Pricing = Record<string, ModelRate>

const PER_MILLION = 1_000_000

/**
 * The rate that prices one model.
 * @param pricing - configured rates.
 * @param model - exact model id from the assistant message.
 * @returns the model's rate, the wildcard rate, or undefined.
 */
export function resolveRate(pricing: Pricing | undefined, model: string): ModelRate | undefined {
  if (pricing === undefined || model === '') return undefined
  return pricing[model] ?? pricing['*']
}

/**
 * The API list value of one response.
 * @param rate - its model's rate, or undefined when unknown.
 * @param tokens - the response's token counts.
 * @returns US dollars, or undefined when the model has no rate.
 */
export function costOf(rate: ModelRate | undefined, tokens: TokenCounts): number | undefined {
  if (rate === undefined) return undefined
  const cacheRead = rate.cacheRead ?? rate.input
  const cacheWrite = rate.cacheWrite ?? rate.input
  const value =
    (tokens.input * rate.input +
      tokens.cacheWrite * cacheWrite +
      tokens.cacheRead * cacheRead +
      tokens.output * rate.output) /
    PER_MILLION
  return Number.isFinite(value) && value >= 0 ? value : undefined
}
