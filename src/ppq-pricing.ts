/**
 * PPQ per-token pricing.
 *
 * Hardcoded from https://ppq.ai/pricing so the /stats UI can show real
 * per-request cost alongside pinchbench scores. Update this table when
 * PPQ adjusts prices or when you add models to the config that aren't
 * listed here.
 *
 * Keys match the basename (no provider prefix) — the lookup helper
 * strips "ppq/" and any leading provider segment before matching.
 */

export type PpqPrice = {
  /** USD per million input tokens. */
  inputPerM: number;
  /** USD per million output tokens. */
  outputPerM: number;
};

const PRICES: Record<string, PpqPrice> = {
  "claude-opus-4.6":           { inputPerM: 5.25, outputPerM: 26.25 },
  "claude-sonnet-4.6":         { inputPerM: 3.15, outputPerM: 15.75 },
  "gpt-5.4":                   { inputPerM: 2.63, outputPerM: 15.75 },
  "gemini-3-flash-preview":    { inputPerM: 0.35, outputPerM:  2.10 },
  "gemini-3.1-pro-preview":    { inputPerM: 1.40, outputPerM:  8.40 },
  "gemini-2.5-flash":          { inputPerM: 0.21, outputPerM:  1.75 },
  "gemini-2.5-flash-lite":     { inputPerM: 0.07, outputPerM:  0.28 },
  "qwen3.5-flash-02-23":       { inputPerM: 0.07, outputPerM:  0.27 },
  "qwen3.6-plus":              { inputPerM: 0.34, outputPerM:  2.05 },
  "grok-4-fast":               { inputPerM: 0.21, outputPerM:  0.53 },
};

export function findPpqPrice(modelRef: string): PpqPrice | null {
  const parts = modelRef.split("/");
  for (let i = parts.length - 1; i >= 0; i--) {
    const key = parts.slice(i).join("/");
    if (PRICES[key]) return PRICES[key];
  }
  const base = parts[parts.length - 1];
  return PRICES[base] ?? null;
}

/**
 * Cost for a representative 50K-input + 200-output request.
 * Matches the Hermes traffic pattern we're seeing in the routing log.
 */
export function exampleRequestCost(price: PpqPrice): number {
  return (50_000 / 1e6) * price.inputPerM + (200 / 1e6) * price.outputPerM;
}

/**
 * Blended price per 1K tokens, weighted 80% input / 20% output.
 * A single number for quick model-to-model comparison.
 */
export function blendedPricePerK(price: PpqPrice): number {
  return (0.8 * price.inputPerM + 0.2 * price.outputPerM) / 1000;
}
