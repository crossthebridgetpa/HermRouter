/**
 * PPQ account activity fetcher.
 *
 * Pulls balance + recent query history from api.ppq.ai so the /stats UI
 * can show real $ spend alongside the routing decisions. 30s in-memory
 * cache — PPQ rate-limits and polling every stats refresh is wasteful.
 *
 * Credit ID is read from ~/.freerouter/ppq-credit-id (chmod 600). If the
 * file is missing, the snapshot returns disabled:true and the UI hides
 * the panel.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CREDIT_ID_FILE = join(homedir(), ".freerouter", "ppq-credit-id");
const BASE = "https://api.ppq.ai";
const CACHE_MS = 30_000;
const HISTORY_PAGE_SIZE = 100;

export type PpqHistoryRow = {
  timestamp: string;
  model: string;
  input_count: number;
  output_count: number;
  price_in_usd: number;
  query_type: string;
  query_source: string;
};

export type PpqSnapshot = {
  disabled: boolean;
  fetchedAt: string;
  balance: number | null;
  last24h: {
    totalUsd: number;
    requests: number;
    byModel: Record<string, { usd: number; count: number; inTok: number; outTok: number }>;
  };
  recent: PpqHistoryRow[];
  error?: string;
};

let cached: { at: number; snap: PpqSnapshot } | null = null;
let creditId: string | null | undefined;

async function loadCreditId(): Promise<string | null> {
  if (creditId !== undefined) return creditId;
  try {
    const raw = await readFile(CREDIT_ID_FILE, "utf-8");
    creditId = raw.trim() || null;
  } catch {
    creditId = null;
  }
  return creditId;
}

async function fetchBalance(id: string): Promise<number | null> {
  const r = await fetch(`${BASE}/credits/balance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credit_id: id }),
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { balance?: number };
  return typeof j.balance === "number" ? j.balance : null;
}

async function fetchHistory(id: string): Promise<PpqHistoryRow[]> {
  const url = `${BASE}/queries/history?credit_id=${encodeURIComponent(id)}&page=1&page_count=${HISTORY_PAGE_SIZE}`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const j = (await r.json()) as { data?: PpqHistoryRow[] };
  return Array.isArray(j.data) ? j.data : [];
}

export async function getPpqSnapshot(): Promise<PpqSnapshot> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.snap;

  const id = await loadCreditId();
  if (!id) {
    const snap: PpqSnapshot = {
      disabled: true,
      fetchedAt: new Date().toISOString(),
      balance: null,
      last24h: { totalUsd: 0, requests: 0, byModel: {} },
      recent: [],
    };
    cached = { at: Date.now(), snap };
    return snap;
  }

  try {
    const [balance, history] = await Promise.all([fetchBalance(id), fetchHistory(id)]);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const byModel: PpqSnapshot["last24h"]["byModel"] = {};
    let totalUsd = 0;
    let requests = 0;
    for (const row of history) {
      const t = Date.parse(row.timestamp);
      if (!Number.isFinite(t) || t < cutoff) continue;
      totalUsd += row.price_in_usd || 0;
      requests += 1;
      const m = (byModel[row.model] ??= { usd: 0, count: 0, inTok: 0, outTok: 0 });
      m.usd += row.price_in_usd || 0;
      m.count += 1;
      m.inTok += row.input_count || 0;
      m.outTok += row.output_count || 0;
    }
    const snap: PpqSnapshot = {
      disabled: false,
      fetchedAt: new Date().toISOString(),
      balance,
      last24h: { totalUsd, requests, byModel },
      recent: history,
    };
    cached = { at: Date.now(), snap };
    return snap;
  } catch (e) {
    const snap: PpqSnapshot = {
      disabled: false,
      fetchedAt: new Date().toISOString(),
      balance: null,
      last24h: { totalUsd: 0, requests: 0, byModel: {} },
      recent: [],
      error: e instanceof Error ? e.message : String(e),
    };
    cached = { at: Date.now(), snap };
    return snap;
  }
}
