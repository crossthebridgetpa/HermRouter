/**
 * HermRouter routing decision log.
 *
 * Appends one JSON line per request to ~/.freerouter/routing.jsonl so the
 * `/stats` endpoint (and UI panel) can show why each request was routed the
 * way it was — tier, classifier score, reasoning, overrides — not just
 * aggregate counters.
 */

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type RouteOverride = "none" | "vision" | "mode" | "tools" | "explicit";

export type RouteLogEntry = {
  ts: string;
  requestId: number;
  clientModel: string;
  routedModel: string;
  tier: string;
  reasoning: string;
  override: RouteOverride;
  classifierConfidence: number | null;
  promptLen: number;
  toolCount: number;
  imagePresent: boolean;
  systemPromptLen: number;
};

const LOG_DIR = join(homedir(), ".freerouter");
const LOG_FILE = join(LOG_DIR, "routing.jsonl");

let dirReady = false;
async function ensureDir() {
  if (dirReady) return;
  await mkdir(LOG_DIR, { recursive: true });
  dirReady = true;
}

export async function logRoutingDecision(entry: RouteLogEntry): Promise<void> {
  try {
    await ensureDir();
    await appendFile(LOG_FILE, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Swallow — logging must never break request handling.
  }
}

/**
 * Read the last N entries from the log. Reads the tail only when the file
 * is large so we don't slurp megabytes into memory.
 */
export async function readRecentDecisions(limit = 50): Promise<RouteLogEntry[]> {
  try {
    const s = await stat(LOG_FILE);
    // Heuristic: 1KB per line is generous. Grab the last limit*2KB.
    const tailBytes = Math.min(s.size, Math.max(limit * 2048, 64 * 1024));
    const buf = await readFile(LOG_FILE);
    const slice = buf.subarray(buf.length - tailBytes).toString("utf-8");
    const lines = slice.split("\n").filter(Boolean);
    const tail = lines.slice(-limit);
    const out: RouteLogEntry[] = [];
    for (const line of tail) {
      try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    return out;
  } catch {
    return [];
  }
}

export function getLogPath(): string {
  return LOG_FILE;
}
