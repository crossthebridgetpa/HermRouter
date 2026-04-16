/**
 * Spend Tracker — budget enforcement for HermRouter.
 *
 * Primary source: PPQ API (actual USD spend) via getPpqSnapshot().
 * Between PPQ cache refreshes (30s), an in-memory accumulator tracks
 * estimated costs so requests can't blow past the limit in a burst.
 *
 * On startup, seeds from PPQ snapshot. Resets daily/monthly accumulators
 * on calendar boundaries.
 */

import { getPpqSnapshot, type PpqSnapshot } from "./ppq-usage.js";
import { getConfig, type SpendLimits } from "./config.js";
import { logger } from "./logger.js";

export type SpendStatus = "ok" | "warning" | "exceeded";

export type SpendState = {
  /** Actual 24h spend from PPQ API (null if PPQ disabled) */
  ppqLast24h: number | null;
  /** Estimated spend accumulated in memory since last PPQ sync */
  pendingEstimate: number;
  /** Combined daily spend: ppq actual + pending estimate */
  dailySpend: number;
  /** Combined monthly spend (PPQ 24h is all we get — monthly is estimated) */
  monthlySpend: number;
  /** Current limits from config */
  limits: SpendLimits | null;
  /** Overall status */
  dailyStatus: SpendStatus;
  monthlyStatus: SpendStatus;
  /** Burn rate in USD/hour (based on last PPQ snapshot) */
  burnRatePerHour: number;
  /** Last PPQ sync time */
  lastSync: string | null;
};

// ─── Internal state ───

/** Estimated cost accumulated since last PPQ sync */
let pendingEstimate = 0;

/** Timestamp of last PPQ sync */
let lastSyncAt = 0;

/** Last known PPQ 24h total (to avoid double-counting) */
let lastPpq24h = 0;

/** Monthly accumulator — sum of daily actuals, reset on month boundary */
let monthlyAccumulated = 0;

/** Track current day/month for rollover */
let currentDay = new Date().getUTCDate();
let currentMonth = new Date().getUTCMonth();

/**
 * Check calendar boundaries and reset accumulators.
 */
function checkRollover(): void {
  const now = new Date();
  const day = now.getUTCDate();
  const month = now.getUTCMonth();

  if (month !== currentMonth) {
    // New month — reset everything
    monthlyAccumulated = 0;
    pendingEstimate = 0;
    lastPpq24h = 0;
    currentMonth = month;
    currentDay = day;
    logger.info("Spend tracker: monthly rollover");
  } else if (day !== currentDay) {
    // New day — roll daily into monthly, reset daily accumulator
    monthlyAccumulated += lastPpq24h;
    pendingEstimate = 0;
    lastPpq24h = 0;
    currentDay = day;
    logger.info("Spend tracker: daily rollover");
  }
}

/**
 * Record an estimated cost for a request (called before forwarding).
 * This covers the gap between PPQ cache refreshes.
 */
export function recordEstimatedCost(usd: number): void {
  if (usd > 0) pendingEstimate += usd;
}

/**
 * Sync with PPQ snapshot. Called periodically or on /stats.
 * When PPQ updates, the pending estimate resets since PPQ's 24h total
 * now includes those requests.
 */
async function syncWithPpq(): Promise<PpqSnapshot> {
  const snap = await getPpqSnapshot();

  if (!snap.disabled && snap.last24h.totalUsd > 0) {
    // PPQ has caught up — its 24h total supersedes our estimates
    const ppqTotal = snap.last24h.totalUsd;
    if (ppqTotal >= lastPpq24h) {
      // PPQ advanced — the delta is real spend that was previously estimated
      lastPpq24h = ppqTotal;
      // Reset pending since PPQ now reflects those requests
      pendingEstimate = 0;
    }
    lastSyncAt = Date.now();
  }

  return snap;
}

export type CanSpendResult = {
  allowed: boolean;
  reason?: string;
  status: SpendStatus;
};

/**
 * Check whether a request with the given estimated cost should proceed.
 * Returns { allowed, reason, status }.
 */
export async function canSpend(estimatedCostUsd: number): Promise<CanSpendResult> {
  const cfg = getConfig();
  const limits = cfg.spendLimits;

  // No limits configured — always allow
  if (!limits || (!limits.daily && !limits.monthly)) {
    return { allowed: true, status: "ok" };
  }

  checkRollover();

  // Sync with PPQ if cache is stale (>30s)
  if (Date.now() - lastSyncAt > 30_000) {
    await syncWithPpq();
  }

  const dailySpend = lastPpq24h + pendingEstimate + estimatedCostUsd;
  const monthlySpend = monthlyAccumulated + dailySpend;

  // Check monthly first (higher priority)
  if (limits.monthly && monthlySpend > limits.monthly) {
    const reason = `Monthly budget of $${limits.monthly.toFixed(2)} exceeded ($${monthlySpend.toFixed(2)} spent)`;
    if (limits.action === "block") {
      return { allowed: false, reason, status: "exceeded" };
    }
    logger.warn(`Spend warning: ${reason}`);
    return { allowed: true, reason, status: "exceeded" };
  }

  // Check daily
  if (limits.daily && dailySpend > limits.daily) {
    const reason = `Daily budget of $${limits.daily.toFixed(2)} exceeded ($${dailySpend.toFixed(2)} spent)`;
    if (limits.action === "block") {
      return { allowed: false, reason, status: "exceeded" };
    }
    logger.warn(`Spend warning: ${reason}`);
    return { allowed: true, reason, status: "exceeded" };
  }

  // Warning threshold at 80%
  if (limits.daily && dailySpend > limits.daily * 0.8) {
    return { allowed: true, status: "warning" };
  }
  if (limits.monthly && monthlySpend > limits.monthly * 0.8) {
    return { allowed: true, status: "warning" };
  }

  return { allowed: true, status: "ok" };
}

/**
 * Get full spend state for the /stats endpoint and UI.
 */
export async function getSpendState(): Promise<SpendState> {
  checkRollover();

  const snap = await syncWithPpq();
  const cfg = getConfig();
  const limits = cfg.spendLimits ?? null;

  const ppqLast24h = snap.disabled ? null : snap.last24h.totalUsd;
  const dailySpend = (ppqLast24h ?? 0) + pendingEstimate;
  const monthlySpend = monthlyAccumulated + dailySpend;

  // Burn rate: PPQ 24h requests / hours since first request in window
  let burnRatePerHour = 0;
  if (snap.recent.length >= 2) {
    const oldest = snap.recent[snap.recent.length - 1];
    const newest = snap.recent[0];
    const spanMs = Date.parse(newest.timestamp) - Date.parse(oldest.timestamp);
    const spanHours = spanMs / (1000 * 60 * 60);
    if (spanHours > 0) {
      const windowSpend = snap.last24h.totalUsd;
      burnRatePerHour = windowSpend / Math.min(spanHours, 24);
    }
  }

  // Compute statuses
  let dailyStatus: SpendStatus = "ok";
  let monthlyStatus: SpendStatus = "ok";

  if (limits?.daily) {
    if (dailySpend >= limits.daily) dailyStatus = "exceeded";
    else if (dailySpend >= limits.daily * 0.8) dailyStatus = "warning";
  }
  if (limits?.monthly) {
    if (monthlySpend >= limits.monthly) monthlyStatus = "exceeded";
    else if (monthlySpend >= limits.monthly * 0.8) monthlyStatus = "warning";
  }

  return {
    ppqLast24h,
    pendingEstimate,
    dailySpend,
    monthlySpend,
    limits,
    dailyStatus,
    monthlyStatus,
    burnRatePerHour,
    lastSync: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
  };
}
