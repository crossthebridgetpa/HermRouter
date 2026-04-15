/**
 * Pinchbench leaderboard fetcher.
 *
 * Pulls benchmark data from api.pinchbench.com so the /stats UI can show
 * how each model in the current config compares on score/cost/speed.
 * Cached for an hour — leaderboard updates on human timescales, not
 * per-request.
 */

const API = "https://api.pinchbench.com/api/leaderboard?official=true&limit=200";
const CACHE_MS = 60 * 60 * 1000;

export type PinchRow = {
  model: string;
  provider: string;
  best_score_percentage: number;
  average_score_percentage: number;
  average_execution_time_seconds: number;
  best_execution_time_seconds: number;
  average_cost_usd: number;
  best_cost_usd: number;
  submission_count: number;
  latest_submission: string;
};

export type PinchLookup = {
  fetchedAt: string;
  rows: PinchRow[];
  byModel: Record<string, PinchRow>;
  error?: string;
};

let cached: { at: number; data: PinchLookup } | null = null;

export async function getPinchbench(): Promise<PinchLookup> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;
  try {
    const r = await fetch(API);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { leaderboard?: PinchRow[] };
    const rows = j.leaderboard ?? [];
    const byModel: Record<string, PinchRow> = {};
    for (const row of rows) byModel[row.model] = row;
    const data: PinchLookup = {
      fetchedAt: new Date().toISOString(),
      rows,
      byModel,
    };
    cached = { at: Date.now(), data };
    return data;
  } catch (e) {
    const data: PinchLookup = {
      fetchedAt: new Date().toISOString(),
      rows: [],
      byModel: {},
      error: e instanceof Error ? e.message : String(e),
    };
    // Cache failures briefly so we don't hammer the API on every /stats hit.
    cached = { at: Date.now() - (CACHE_MS - 60_000), data };
    return data;
  }
}

/**
 * Normalize a freerouter model reference (e.g. "ppq/qwen/qwen3.5-flash-02-23"
 * or "ppq/claude-sonnet-4.6") and try to find it in the pinchbench leaderboard.
 *
 * Strategy: strip the freerouter "ppq/" provider prefix, then try:
 *   1. direct match on the full key
 *   2. any leaderboard model ending with "/" + the stripped name
 *      (handles bare "gpt-5.4" → "openai/gpt-5.4")
 *   3. any leaderboard model containing the stripped basename
 */
export function findPinchRow(
  modelRef: string,
  lookup: PinchLookup,
): PinchRow | null {
  const stripped = modelRef.replace(/^ppq\//, "").replace(/^anthropic\//, "");
  if (lookup.byModel[stripped]) return lookup.byModel[stripped];
  for (const row of lookup.rows) {
    if (row.model === stripped) return row;
    if (row.model.endsWith("/" + stripped)) return row;
  }
  // Fall back to basename match (e.g. "claude-sonnet-4.6" vs "anthropic/claude-sonnet-4.6")
  const base = stripped.split("/").pop() ?? stripped;
  for (const row of lookup.rows) {
    const rowBase = row.model.split("/").pop() ?? row.model;
    if (rowBase === base) return row;
  }
  return null;
}

/**
 * Walk the tier config (chat tiers, agentic tiers, vision tier) and return
 * every distinct model reference with the tier(s) it appears in.
 */
export type ConfigModelUsage = {
  model: string;
  slots: string[]; // e.g. ["chat.SIMPLE.primary", "agentic.MEDIUM.fallback[0]"]
};

export function collectConfiguredModels(cfg: {
  tiers?: Record<string, { primary?: string; fallback?: string[] }>;
  agenticTiers?: Record<string, { primary?: string; fallback?: string[] }>;
  visionTier?: { primary?: string; fallback?: string[] };
}): ConfigModelUsage[] {
  const seen: Record<string, string[]> = {};
  const add = (model: string | undefined, slot: string) => {
    if (!model) return;
    (seen[model] ??= []).push(slot);
  };
  for (const [tier, t] of Object.entries(cfg.tiers ?? {})) {
    add(t.primary, `chat.${tier}.primary`);
    (t.fallback ?? []).forEach((m, i) => add(m, `chat.${tier}.fallback[${i}]`));
  }
  for (const [tier, t] of Object.entries(cfg.agenticTiers ?? {})) {
    add(t.primary, `agentic.${tier}.primary`);
    (t.fallback ?? []).forEach((m, i) => add(m, `agentic.${tier}.fallback[${i}]`));
  }
  if (cfg.visionTier) {
    add(cfg.visionTier.primary, "vision.primary");
    (cfg.visionTier.fallback ?? []).forEach((m, i) => add(m, `vision.fallback[${i}]`));
  }
  return Object.entries(seen).map(([model, slots]) => ({ model, slots }));
}
