/**
 * Routing Feedback Scorer — evaluates past routing decisions.
 *
 * Compares actual output tokens (from PPQ) against tier expectations to
 * determine if each request was correctly classified, over-classified
 * (wasted money on a too-powerful model), or under-classified (cheap
 * model had to stretch).
 *
 * Feeds the dashboard with accuracy metrics and tier boundary suggestions.
 */

// ─── Tier output expectations ───
//
// These are output-token ranges that characterize "normal" work for each tier.
// If a COMPLEX request produces fewer tokens than MEDIUM's upper bound, it was
// probably over-classified. If a SIMPLE request produces more than MEDIUM's
// lower bound, it was probably under-classified.

export type TierExpectation = {
  /** Typical output token ceiling — responses shorter than this are "easy" */
  lowBar: number;
  /** Typical output token floor for hard work — responses longer suggest under-classification */
  highBar: number;
};

const TIER_EXPECTATIONS: Record<string, TierExpectation> = {
  SIMPLE:    { lowBar: 0,    highBar: 200 },
  MEDIUM:    { lowBar: 100,  highBar: 800 },
  COMPLEX:   { lowBar: 400,  highBar: 2000 },
  REASONING: { lowBar: 800,  highBar: 4000 },
};

export type FeedbackVerdict = "correct" | "over" | "under" | "unknown";

export type ScoredDecision = {
  tier: string;
  routedModel: string;
  verdict: FeedbackVerdict;
  outTokens: number;
  actualCostUsd: number;
  /** What tier we think it should have been */
  suggestedTier: string | null;
  /** Estimated cost at the suggested tier (null if correct) */
  potentialCostUsd: number | null;
  /** Wasted spend (positive = overspent, negative = underspent) */
  wastedUsd: number;
};

export type FeedbackSummary = {
  /** Total decisions with PPQ data (scorable) */
  scored: number;
  /** Decisions without PPQ data (can't judge) */
  unscored: number;
  correct: number;
  over: number;
  under: number;
  /** Accuracy: correct / scored */
  accuracy: number;
  /** Over-classification rate: over / scored */
  overRate: number;
  /** Total wasted spend from over-classification */
  wastedUsd: number;
  /** Per-tier breakdown */
  byTier: Record<string, { scored: number; correct: number; over: number; under: number; wastedUsd: number }>;
  /** Individual scored decisions (for the UI table) */
  decisions: ScoredDecision[];
  /** Suggested boundary adjustments */
  suggestions: BoundarySuggestion[];
};

export type BoundarySuggestion = {
  boundary: "simpleMedium" | "mediumComplex" | "complexReasoning";
  currentValue: number;
  suggestedValue: number;
  direction: "raise" | "lower";
  reason: string;
  estimatedSavingsUsd: number;
};

/**
 * Determine what tier a request "should" have been based on actual output tokens.
 */
function suggestTier(outTokens: number): string {
  if (outTokens <= TIER_EXPECTATIONS.SIMPLE.highBar) return "SIMPLE";
  if (outTokens <= TIER_EXPECTATIONS.MEDIUM.highBar) return "MEDIUM";
  if (outTokens <= TIER_EXPECTATIONS.COMPLEX.highBar) return "COMPLEX";
  return "REASONING";
}

/** Tier ordering for comparison */
const TIER_RANK: Record<string, number> = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2, REASONING: 3 };

/**
 * Score a single enriched routing decision.
 *
 * Expects the fields added by the stats handler's PPQ enrichment:
 * ppqCostUsd, ppqOutTok.
 */
export function scoreDecision(entry: {
  tier: string;
  routedModel: string;
  ppqCostUsd?: number;
  ppqOutTok?: number;
  estInputCostUsd?: number;
}): ScoredDecision | null {
  // Can't score without actual output token data
  if (entry.ppqOutTok == null || entry.ppqCostUsd == null) return null;

  const tier = entry.tier;
  const outTokens = entry.ppqOutTok;
  const actualCost = entry.ppqCostUsd;

  // Skip non-routed tiers
  if (!TIER_RANK.hasOwnProperty(tier)) return null;

  const suggested = suggestTier(outTokens);
  const tierRank = TIER_RANK[tier] ?? 1;
  const suggestedRank = TIER_RANK[suggested] ?? 1;

  let verdict: FeedbackVerdict;
  if (suggestedRank === tierRank) {
    verdict = "correct";
  } else if (suggestedRank < tierRank) {
    verdict = "over"; // paid for expensive tier, cheap one would've worked
  } else {
    verdict = "under"; // cheap tier had to stretch
  }

  // Estimate what it would have cost at the suggested tier.
  // Rough heuristic: cost scales ~linearly with tier rank difference.
  // We use the actual cost and tier price ratios.
  const TIER_COST_MULTIPLIER: Record<string, number> = {
    SIMPLE: 1,
    MEDIUM: 3,
    COMPLEX: 30,
    REASONING: 50,
  };
  const currentMult = TIER_COST_MULTIPLIER[tier] ?? 1;
  const suggestedMult = TIER_COST_MULTIPLIER[suggested] ?? 1;
  const potentialCost = verdict === "correct" ? null : actualCost * (suggestedMult / currentMult);
  const wasted = verdict === "over" ? actualCost - (potentialCost ?? actualCost) : 0;

  return {
    tier,
    routedModel: entry.routedModel,
    verdict,
    outTokens,
    actualCostUsd: actualCost,
    suggestedTier: verdict === "correct" ? null : suggested,
    potentialCostUsd: potentialCost,
    wastedUsd: wasted,
  };
}

/**
 * Score a batch of enriched decisions and produce a summary with suggestions.
 */
export function scoreBatch(
  entries: Array<{
    tier: string;
    routedModel: string;
    ppqCostUsd?: number;
    ppqOutTok?: number;
    estInputCostUsd?: number;
  }>,
  currentBoundaries: { simpleMedium: number; mediumComplex: number; complexReasoning: number },
): FeedbackSummary {
  const decisions: ScoredDecision[] = [];
  let unscored = 0;

  for (const entry of entries) {
    const scored = scoreDecision(entry);
    if (scored) {
      decisions.push(scored);
    } else {
      unscored++;
    }
  }

  const scored = decisions.length;
  const correct = decisions.filter(d => d.verdict === "correct").length;
  const over = decisions.filter(d => d.verdict === "over").length;
  const under = decisions.filter(d => d.verdict === "under").length;
  const wastedUsd = decisions.reduce((sum, d) => sum + d.wastedUsd, 0);

  // Per-tier breakdown
  const byTier: FeedbackSummary["byTier"] = {};
  for (const d of decisions) {
    const t = byTier[d.tier] ??= { scored: 0, correct: 0, over: 0, under: 0, wastedUsd: 0 };
    t.scored++;
    t[d.verdict === "unknown" ? "correct" : d.verdict]++;
    t.wastedUsd += d.wastedUsd;
  }

  // Generate boundary suggestions
  const suggestions = generateSuggestions(decisions, byTier, currentBoundaries);

  return {
    scored,
    unscored,
    correct,
    over,
    under,
    accuracy: scored > 0 ? correct / scored : 1,
    overRate: scored > 0 ? over / scored : 0,
    wastedUsd,
    byTier,
    decisions,
    suggestions,
  };
}

/**
 * Analyze over/under patterns and suggest boundary changes.
 */
function generateSuggestions(
  decisions: ScoredDecision[],
  byTier: FeedbackSummary["byTier"],
  boundaries: { simpleMedium: number; mediumComplex: number; complexReasoning: number },
): BoundarySuggestion[] {
  const suggestions: BoundarySuggestion[] = [];
  const MIN_SAMPLE = 5; // need at least this many to suggest

  // Check MEDIUM → SIMPLE over-classification (raise simpleMedium)
  const mediumStats = byTier["MEDIUM"];
  if (mediumStats && mediumStats.scored >= MIN_SAMPLE) {
    const overRate = mediumStats.over / mediumStats.scored;
    if (overRate > 0.3) {
      suggestions.push({
        boundary: "simpleMedium",
        currentValue: boundaries.simpleMedium,
        suggestedValue: Math.min(boundaries.simpleMedium + 0.02, boundaries.mediumComplex - 0.01),
        direction: "raise",
        reason: `${(overRate * 100).toFixed(0)}% of MEDIUM requests were over-classified (could be SIMPLE)`,
        estimatedSavingsUsd: mediumStats.wastedUsd,
      });
    }
  }

  // Check COMPLEX → MEDIUM over-classification (raise mediumComplex)
  const complexStats = byTier["COMPLEX"];
  if (complexStats && complexStats.scored >= MIN_SAMPLE) {
    const overRate = complexStats.over / complexStats.scored;
    if (overRate > 0.3) {
      suggestions.push({
        boundary: "mediumComplex",
        currentValue: boundaries.mediumComplex,
        suggestedValue: Math.min(boundaries.mediumComplex + 0.02, boundaries.complexReasoning - 0.01),
        direction: "raise",
        reason: `${(overRate * 100).toFixed(0)}% of COMPLEX requests were over-classified (could be MEDIUM or lower)`,
        estimatedSavingsUsd: complexStats.wastedUsd,
      });
    }
  }

  // Check REASONING → COMPLEX over-classification (raise complexReasoning)
  const reasoningStats = byTier["REASONING"];
  if (reasoningStats && reasoningStats.scored >= MIN_SAMPLE) {
    const overRate = reasoningStats.over / reasoningStats.scored;
    if (overRate > 0.3) {
      suggestions.push({
        boundary: "complexReasoning",
        currentValue: boundaries.complexReasoning,
        suggestedValue: Math.min(boundaries.complexReasoning + 0.02, 0.5),
        direction: "raise",
        reason: `${(overRate * 100).toFixed(0)}% of REASONING requests were over-classified (could be COMPLEX or lower)`,
        estimatedSavingsUsd: reasoningStats.wastedUsd,
      });
    }
  }

  // Check SIMPLE under-classification (lower simpleMedium)
  const simpleStats = byTier["SIMPLE"];
  if (simpleStats && simpleStats.scored >= MIN_SAMPLE) {
    const underRate = simpleStats.under / simpleStats.scored;
    if (underRate > 0.3) {
      suggestions.push({
        boundary: "simpleMedium",
        currentValue: boundaries.simpleMedium,
        suggestedValue: Math.max(boundaries.simpleMedium - 0.02, -0.3),
        direction: "lower",
        reason: `${(underRate * 100).toFixed(0)}% of SIMPLE requests were under-classified (needed MEDIUM or higher)`,
        estimatedSavingsUsd: 0, // under-classification doesn't waste money, it risks quality
      });
    }
  }

  return suggestions;
}
