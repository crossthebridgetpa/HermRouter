/**
 * HermRouter Proxy Server
 *
 * OpenAI-compatible HTTP server that classifies incoming requests
 * using the 14-dimension weighted scorer and routes to the best backend.
 *
 * Endpoints:
 *   POST /v1/chat/completions  — OpenAI-compatible chat completions
 *   GET  /v1/models            — list available models
 *   GET  /health               — health check
 *
 * Zero external deps. Uses Node.js built-in http + native fetch.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { route } from "./router/index.js";
import { getRoutingConfig } from "./router/config.js";
import { buildPricingMap } from "./models.js";
import { forwardRequest, TimeoutError, type ChatRequest } from "./provider.js";
import { reloadAuth } from "./auth.js";
import { loadConfig, getConfig, reloadConfig, writeConfig, getSanitizedConfig, getConfigPath, type FreeRouterConfig } from "./config.js";
import { logger, setLogLevel } from "./logger.js";
import { logRoutingDecision, readRecentDecisions, getLogPath, type RouteOverride } from "./routing-log.js";
import { getPpqSnapshot } from "./ppq-usage.js";
import { getPinchbench, findPinchRow, collectConfiguredModels } from "./pinchbench.js";
import { findPpqPrice, exampleRequestCost, blendedPricePerK } from "./ppq-pricing.js";

// Load config at startup
const appConfig = loadConfig();
const PORT = parseInt(process.env.CLAWROUTER_PORT ?? String(appConfig.port), 10);
const HOST = process.env.CLAWROUTER_HOST ?? appConfig.host ?? "127.0.0.1";

// Build pricing map once at startup
const modelPricing = buildPricingMap();

// Stats
const stats = {
  started: new Date().toISOString(),
  requests: 0,
  errors: 0,
  timeouts: 0,
  byTier: { SIMPLE: 0, MEDIUM: 0, COMPLEX: 0, REASONING: 0 } as Record<string, number>,
  byModel: {} as Record<string, number>,
};

/**
 * Read request body as JSON.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Send JSON error response.
 */
function sendError(res: ServerResponse, status: number, message: string, type = "server_error") {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    error: { message, type, code: status },
  }));
}

/**
 * Detect if any message contains an image part (OpenAI or Anthropic format).
 */
function hasImageContent(messages: ChatRequest["messages"]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      const t = (part as { type?: string }).type;
      if (t === "image_url" || t === "image" || t === "input_image") return true;
    }
  }
  return false;
}

/**
 * Extract the user's prompt text from messages for classification.
 */
function extractPromptForClassification(messages: ChatRequest["messages"]): {
  prompt: string;
  systemPrompt: string | undefined;
} {
  let systemPrompt: string | undefined;
  let lastUserMsg = "";

  for (const msg of messages) {
    const text = typeof msg.content === "string"
      ? msg.content
      : (msg.content ?? []).filter(b => b.type === "text").map(b => b.text ?? "").join("\n");

    if (msg.role === "system" || msg.role === "developer") {
      systemPrompt = (systemPrompt ? systemPrompt + "\n" : "") + text;
    } else if (msg.role === "user") {
      lastUserMsg = text;
    }
  }

  return { prompt: lastUserMsg, systemPrompt };
}


/**
 * Detect user-requested mode override in prompt text.
 * Users can prefix or include mode directives to force a specific tier:
 *   "simple mode: ..."  or  "/simple ..."   → SIMPLE
 *   "medium mode: ..."  or  "/medium ..."   → MEDIUM  
 *   "complex mode: ..." or  "/complex ..."  → COMPLEX
 *   "max mode: ..."     or  "/max ..."      → REASONING
 *   "reasoning mode: ..." or "/reasoning ..." → REASONING
 * 
 * Returns the forced tier and cleaned prompt (directive stripped), or null if no override.
 */
function detectModeOverride(prompt: string): { tier: string; cleanedPrompt: string } | null {
  const modeMap: Record<string, string> = {
    simple: "SIMPLE",
    basic: "SIMPLE",
    cheap: "SIMPLE",
    medium: "MEDIUM",
    balanced: "MEDIUM",
    complex: "COMPLEX",
    advanced: "COMPLEX",
    max: "REASONING",
    reasoning: "REASONING",
    think: "REASONING",
    deep: "REASONING",
  };

  // Pattern 1: "/mode ..." at start of message
  const slashMatch = prompt.match(/^\/([a-z]+)\s+/i);
  if (slashMatch) {
    const mode = slashMatch[1].toLowerCase();
    if (modeMap[mode]) {
      return { tier: modeMap[mode], cleanedPrompt: prompt.slice(slashMatch[0].length).trim() };
    }
  }

  // Pattern 2: "mode mode: ..." or "mode mode, ..." at start  
  const prefixMatch = prompt.match(/^([a-z]+)\s+mode[:\s,]+/i);
  if (prefixMatch) {
    const mode = prefixMatch[1].toLowerCase();
    if (modeMap[mode]) {
      return { tier: modeMap[mode], cleanedPrompt: prompt.slice(prefixMatch[0].length).trim() };
    }
  }

  // Pattern 3: "[mode]" at start
  const bracketMatch = prompt.match(/^\[([a-z]+)\]\s*/i);
  if (bracketMatch) {
    const mode = bracketMatch[1].toLowerCase();
    if (modeMap[mode]) {
      return { tier: modeMap[mode], cleanedPrompt: prompt.slice(bracketMatch[0].length).trim() };
    }
  }

  return null;
}

/**
 * Handle POST /v1/chat/completions
 */
async function handleChatCompletions(req: IncomingMessage, res: ServerResponse) {
  const bodyStr = await readBody(req);
  let chatReq: ChatRequest;

  try {
    chatReq = JSON.parse(bodyStr);
  } catch {
    return sendError(res, 400, "Invalid JSON body");
  }

  if (!chatReq.model) {
    return sendError(res, 400, "model field is required");
  }

  if (!chatReq.messages || !Array.isArray(chatReq.messages) || chatReq.messages.length === 0) {
    return sendError(res, 400, "messages array is required");
  }

  const stream = chatReq.stream ?? false;
  const maxTokens = chatReq.max_tokens ?? 4096;

  // Extract prompt for classification
  const { prompt, systemPrompt } = extractPromptForClassification(chatReq.messages);

  if (!prompt) {
    return sendError(res, 400, "No user message found");
  }

  // Route through classifier
  const requestedModel = chatReq.model ?? "auto";
  let routedModel: string;
  let tier: string;
  let reasoning: string;
  let override: RouteOverride = "none";
  let classifierConfidence: number | null = null;

  const imagesPresent = hasImageContent(chatReq.messages);
  const visionCfg = getConfig().visionTier;

  if (requestedModel === "auto" || requestedModel === "clawrouter/auto" || requestedModel === "blockrun/auto") {
    // Vision override: image parts present + visionTier configured → force vision tier
    if (imagesPresent && visionCfg?.primary) {
      routedModel = visionCfg.primary;
      tier = "VISION";
      reasoning = "image content detected → visionTier";
      override = "vision";
      logger.info(`[${stats.requests + 1}] Vision override: model=${routedModel} | ${reasoning}`);
    } else {
    // Check for user mode override (e.g., "max mode: ...", "/complex ...", "[reasoning] ...")
    const modeOverride = detectModeOverride(prompt);

    if (modeOverride) {
      // User explicitly requested a tier — honor it
      const routingCfg = getRoutingConfig();
      const tierConfig = routingCfg.tiers[modeOverride.tier as keyof typeof routingCfg.tiers];
      routedModel = tierConfig?.primary ?? "anthropic/claude-opus-4-6";
      tier = modeOverride.tier;
      reasoning = `user-mode: ${modeOverride.tier.toLowerCase()}`;
      override = "mode";
      logger.info(`[${stats.requests + 1}] Mode override: tier=${tier} model=${routedModel} | ${reasoning}`);
    } else {
      // Run the classifier. Force agentic tiers when the request carries tool
      // schemas — otherwise tool-capable work may land on a SIMPLE-tier model
      // that silently ignores the tools array.
      const routingCfg = getRoutingConfig();
      const hasTools = Array.isArray(chatReq.tools) && chatReq.tools.length > 0;
      const cfgForRoute = hasTools
        ? { ...routingCfg, overrides: { ...routingCfg.overrides, agenticMode: true } }
        : routingCfg;
      const decision = route(prompt, systemPrompt, maxTokens, {
        config: cfgForRoute,
        modelPricing,
      });

      routedModel = decision.model;
      tier = decision.tier;
      reasoning = decision.reasoning;
      classifierConfidence = decision.confidence;
      if (hasTools) override = "tools";

      logger.info(`[${stats.requests + 1}] Classified: tier=${tier} model=${routedModel} confidence=${decision.confidence.toFixed(2)} | ${reasoning}`);
    }
    }
  } else {
    // Explicit model requested — pass through
    routedModel = requestedModel;
    tier = "EXPLICIT";
    reasoning = `explicit model: ${requestedModel}`;
    override = "explicit";
    logger.info(`[${stats.requests + 1}] Passthrough: model=${routedModel}`);
  }

  // Update stats
  stats.requests++;
  stats.byTier[tier] = (stats.byTier[tier] ?? 0) + 1;
  stats.byModel[routedModel] = (stats.byModel[routedModel] ?? 0) + 1;

  // Estimate input cost from char-length (chars / 4 ≈ tokens) + PPQ pricing
  const ppqPrice = findPpqPrice(routedModel);
  const estInputTokens = (prompt.length + (systemPrompt ?? "").length) / 4;
  const estInputCostUsd = ppqPrice ? (estInputTokens / 1e6) * ppqPrice.inputPerM : undefined;

  // Persist per-request decision (fire-and-forget, never blocks the request)
  void logRoutingDecision({
    ts: new Date().toISOString(),
    requestId: stats.requests,
    clientModel: requestedModel,
    routedModel,
    tier,
    reasoning,
    override,
    classifierConfidence,
    promptLen: prompt.length,
    toolCount: Array.isArray(chatReq.tools) ? chatReq.tools.length : 0,
    imagePresent: imagesPresent,
    systemPromptLen: (systemPrompt ?? "").length,
    estInputCostUsd,
  });

  // Add routing info headers
  res.setHeader("X-ClawRouter-Model", routedModel);
  res.setHeader("X-ClawRouter-Tier", tier);
  res.setHeader("X-ClawRouter-Reasoning", reasoning.slice(0, 200));

  // Build model list: primary + fallbacks
  const modelsToTry: string[] = [routedModel];
  if (tier === "VISION") {
    for (const fb of visionCfg?.fallback ?? []) {
      if (fb !== routedModel) modelsToTry.push(fb);
    }
  } else if (tier !== "EXPLICIT") {
    const routingCfg = getRoutingConfig();
    const hasTools = Array.isArray(chatReq.tools) && chatReq.tools.length > 0;
    const tierMap = (hasTools && routingCfg.agenticTiers) ? routingCfg.agenticTiers : routingCfg.tiers;
    const tierConfig = tierMap[tier as keyof typeof tierMap];
    if (tierConfig?.fallback) {
      for (const fb of tierConfig.fallback) {
        if (fb !== routedModel) modelsToTry.push(fb);
      }
    }
  }

  let lastError: string = "";
  for (const modelToTry of modelsToTry) {
    try {
      if (modelToTry !== routedModel) {
        logger.info(`[${stats.requests}] Falling back to ${modelToTry}`);
        res.setHeader("X-ClawRouter-Model", modelToTry);
      }
      await forwardRequest(chatReq, modelToTry, tier, res, stream);
      return; // success
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const isTimeout = err instanceof TimeoutError;
      if (isTimeout) {
        stats.timeouts++;
        logger.error(`\u23f1 TIMEOUT (${modelToTry}): ${lastError} — trying fallback...`);
      } else {
        logger.error(`Forward error (${modelToTry}): ${lastError}`);
      }
      if (res.headersSent) break; // can't retry if already streaming
    }
  }

  stats.errors++;
  if (!res.headersSent) {
    sendError(res, 502, `Backend error: ${lastError}`, "upstream_error");
  } else if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify({ error: { message: lastError } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

/**
 * Handle GET /v1/models — dynamic list derived from the current config so
 * Hermes and other clients see the models that are actually wired up.
 */
function handleListModels(_req: IncomingMessage, res: ServerResponse) {
  const cfg = getConfig();
  const now = Math.floor(Date.now() / 1000);
  const ids = new Set<string>();
  ids.add("auto");
  for (const t of ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]) ids.add(t);
  const collect = (tm: { primary?: string; fallback?: string[] } | undefined) => {
    if (!tm) return;
    if (tm.primary) ids.add(tm.primary);
    for (const fb of tm.fallback ?? []) if (fb) ids.add(fb);
  };
  for (const t of Object.values(cfg.tiers ?? {})) collect(t);
  for (const t of Object.values(cfg.agenticTiers ?? {})) collect(t);
  collect(cfg.visionTier);

  const models = [...ids].map(id => ({
    id,
    object: "model",
    created: now,
    owned_by: id.includes("/") ? id.split("/")[0] : "clawrouter",
  }));

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ object: "list", data: models }));
}

/**
 * Handle GET /health
 */
function handleHealth(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    version: "1.1.0",
    uptime: process.uptime(),
    stats,
  }));
}

/**
 * Handle GET /stats
 *
 * Returns the in-memory counters plus a recent window of individual routing
 * decisions pulled from ~/.freerouter/routing.jsonl. The UI uses `recent` to
 * render the tier-distribution bars and the decisions table.
 */
async function handleStats(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/stats", "http://x");
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));
  const [recent, ppq, pinch] = await Promise.all([
    readRecentDecisions(limit),
    getPpqSnapshot(),
    getPinchbench(),
  ]);

  // Cross-reference current config against pinchbench leaderboard.
  const cfg = getConfig();
  const configured = collectConfiguredModels(cfg);
  const pinchConfig = configured.map(({ model, slots }) => {
    const row = findPinchRow(model, pinch);
    const price = findPpqPrice(model);
    return {
      model,
      slots,
      pinch: row
        ? {
            matchedAs: row.model,
            bestScore: row.best_score_percentage,
            avgScore: row.average_score_percentage,
          }
        : null,
      price: price
        ? {
            inputPerM: price.inputPerM,
            outputPerM: price.outputPerM,
            blendedPerK: blendedPricePerK(price),
            exampleRequest: exampleRequestCost(price),
          }
        : null,
    };
  }).sort((a, b) => {
    const av = a.pinch?.bestScore ?? -1;
    const bv = b.pinch?.bestScore ?? -1;
    return bv - av;
  });

  // Enrich recent routing decisions with actual PPQ costs by matching
  // routing log entries to PPQ history rows (same model basename, timestamp within 10s).
  type EnrichedEntry = typeof recent[number] & { ppqCostUsd?: number; ppqInTok?: number; ppqOutTok?: number };
  const enriched: EnrichedEntry[] = recent.map(r => ({ ...r }));
  if (!ppq.disabled && ppq.recent.length > 0) {
    const ppqRows = ppq.recent.map(h => ({
      ...h,
      tsMs: Date.parse(h.timestamp),
      base: h.model.split("/").pop() ?? h.model,
    }));
    for (const entry of enriched) {
      const entryMs = Date.parse(entry.ts);
      const entryBase = entry.routedModel.split("/").pop() ?? entry.routedModel;
      // Find closest PPQ row with same model basename within 10s
      let best: typeof ppqRows[number] | null = null;
      let bestDiff = Infinity;
      for (const p of ppqRows) {
        if (p.base !== entryBase) continue;
        const diff = Math.abs(p.tsMs - entryMs);
        if (diff < bestDiff && diff < 10_000) {
          best = p;
          bestDiff = diff;
        }
      }
      if (best) {
        entry.ppqCostUsd = best.price_in_usd;
        entry.ppqInTok = best.input_count;
        entry.ppqOutTok = best.output_count;
      }
    }
  }

  // Roll up the recent window so the UI can show "what's happening lately"
  // instead of process-lifetime totals.
  const windowByTier: Record<string, number> = {};
  const windowByModel: Record<string, number> = {};
  const windowByOverride: Record<string, number> = {};
  for (const r of recent) {
    windowByTier[r.tier] = (windowByTier[r.tier] ?? 0) + 1;
    windowByModel[r.routedModel] = (windowByModel[r.routedModel] ?? 0) + 1;
    windowByOverride[r.override] = (windowByOverride[r.override] ?? 0) + 1;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    ...stats,
    logPath: getLogPath(),
    window: {
      size: recent.length,
      byTier: windowByTier,
      byModel: windowByModel,
      byOverride: windowByOverride,
    },
    recent: enriched,
    ppq,
    pinch: {
      fetchedAt: pinch.fetchedAt,
      totalModels: pinch.rows.length,
      error: pinch.error ?? null,
      configured: pinchConfig,
    },
  }, null, 2));
}


/**
 * Handle GET /config — show sanitized config (no secrets)
 */
function handleConfig(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    configPath: getConfigPath(),
    config: getSanitizedConfig(),
  }, null, 2));
}

/**
 * Handle POST /reload-config — reload config + auth without restart
 */
function handleReloadConfig(_req: IncomingMessage, res: ServerResponse) {
  reloadConfig();
  reloadAuth();
  const cfg = getConfig();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "reloaded",
    configPath: getConfigPath(),
    providers: Object.keys(cfg.providers),
    tiers: Object.keys(cfg.tiers),
  }));
}

const UI_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>HermRouter config</title>
<style>
body{font:14px/1.4 system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;background:#0f1115;color:#e6e6e6}
h1{font-size:18px;margin:0 0 .5rem} h2{font-size:14px;margin:1rem 0 .5rem;color:#9db2c7}
textarea{width:100%;min-height:480px;font:12px/1.4 ui-monospace,monospace;background:#1a1d24;color:#e6e6e6;border:1px solid #2a2f3a;border-radius:4px;padding:.5rem;box-sizing:border-box}
button{background:#2563eb;color:#fff;border:0;padding:.5rem 1rem;border-radius:4px;cursor:pointer;font-size:13px;margin-right:.5rem}
button.secondary{background:#374151}
button:disabled{opacity:.5;cursor:not-allowed}
.status{margin:.5rem 0;padding:.5rem;border-radius:4px;display:none}
.status.ok{display:block;background:#064e3b;color:#a7f3d0}
.status.err{display:block;background:#7f1d1d;color:#fecaca;white-space:pre-wrap;font:12px/1.4 ui-monospace,monospace}
.meta{color:#6b7280;font-size:12px;margin-bottom:.5rem}
details{margin:.5rem 0} summary{cursor:pointer;color:#9db2c7}
pre{background:#1a1d24;padding:.5rem;border-radius:4px;overflow:auto;font-size:12px}
.mctrl{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin:.5rem 0}
.mctrl label{font-size:12px;color:#9db2c7}
.mctrl select,.mctrl input{background:#1a1d24;color:#e6e6e6;border:1px solid #2a2f3a;border-radius:4px;padding:.25rem .4rem;font:12px/1.4 system-ui}
.mgroup{margin:.5rem 0;background:#1a1d24;border-radius:4px}
.mgroup>summary{padding:.5rem .75rem;font:600 12px/1.4 system-ui;color:#9db2c7;text-transform:uppercase;letter-spacing:.04em;cursor:pointer;list-style:none}
.mgroup>summary::-webkit-details-marker{display:none}
.mgroup>summary::before{content:"▸ ";display:inline-block;transition:transform .15s}
.mgroup[open]>summary::before{content:"▾ "}
.mgroup>div.mbody{padding:0 .75rem .5rem}
table.mtab{width:100%;border-collapse:collapse;font:12px/1.4 ui-monospace,monospace}
table.mtab th{text-align:left;color:#6b7280;font-weight:500;padding:.2rem .4rem;border-bottom:1px solid #2a2f3a;text-transform:uppercase;font-size:10px;letter-spacing:.05em}
table.mtab td{padding:.2rem .4rem;border-bottom:1px solid #1f242e;color:#e6e6e6;vertical-align:top}
table.mtab tr:hover td{background:#242934}
td.mprov{color:#9db2c7}
td.mcost{color:#fbbf24;white-space:nowrap;text-align:right}
.card{background:#1a1d24;border-radius:4px;padding:.5rem .75rem;margin:.35rem 0}
.row{display:flex;gap:.75rem;flex-wrap:wrap;align-items:flex-end;margin:.25rem 0}
.row>label{display:flex;flex-direction:column;gap:.15rem;font-size:11px;color:#9db2c7;flex:1;min-width:140px}
.row input[type=text],.row input[type=number],.row textarea{background:#0f1115;color:#e6e6e6;border:1px solid #2a2f3a;border-radius:4px;padding:.3rem .4rem;font:12px/1.4 ui-monospace,monospace;width:100%;box-sizing:border-box}
.row textarea{min-height:60px;resize:vertical}
.tier{background:#0f1115;border:1px solid #2a2f3a;border-radius:4px;padding:.5rem .75rem;margin:.35rem 0}
.tier h3{font:600 11px/1 system-ui;color:#93c5fd;margin:.1rem 0 .35rem;text-transform:uppercase;letter-spacing:.05em}
.fb{display:flex;gap:.25rem;align-items:center;margin:.15rem 0}
.fb input{flex:1}
button.x{background:#374151;color:#fff;border:0;padding:.25rem .5rem;border-radius:4px;font-size:11px;cursor:pointer;margin:0}
button.add{background:#1f2937;color:#93c5fd;border:1px dashed #374151;padding:.25rem .5rem;border-radius:4px;font-size:11px;cursor:pointer;margin:.1rem 0}
.tabnav{display:flex;gap:.25rem;margin:.5rem 0 1rem;border-bottom:1px solid #2a2f3a}
.tabnav button{background:transparent;color:#9db2c7;border:0;border-bottom:2px solid transparent;padding:.5rem 1rem;margin:0;border-radius:0;font-size:13px;cursor:pointer}
.tabnav button:hover{color:#e6e6e6}
.tabnav button.active{color:#93c5fd;border-bottom-color:#2563eb}
.tip{background:#1a1d24;border-left:3px solid #2563eb;padding:.5rem .75rem;margin:.5rem 0;border-radius:0 4px 4px 0;color:#cbd5e1;font-size:12px;line-height:1.5}
.tip b{color:#93c5fd}
.tip code{background:#0f1115;padding:0 .25rem;border-radius:2px;color:#fbbf24}
</style></head><body>
<h1>HermRouter</h1>
<div class="meta" id="meta">loading…</div>
<nav class="tabnav">
  <button id="tabBtnConfig" class="active" type="button">config</button>
  <button id="tabBtnStats" type="button">live stats</button>
</nav>
<div id="tabConfig">
<details><summary>how this works (click to expand)</summary>
<div style="padding:.5rem .75rem;background:#1a1d24;border-radius:4px;color:#cbd5e1">
<p style="margin:.25rem 0"><b>What it does.</b> HermRouter classifies each incoming prompt on 14 dimensions, scores complexity 0–1, and routes to one of four tiers: <code>SIMPLE</code>, <code>MEDIUM</code>, <code>COMPLEX</code>, <code>REASONING</code>. Each tier names a <code>primary</code> model and an ordered <code>fallback</code> list used on error.</p>
<p style="margin:.25rem 0"><b>Tier boundaries.</b> <code>tierBoundaries</code> holds three cut points on the 0–1 score. Score &lt; <code>simpleMedium</code> → SIMPLE; &lt; <code>mediumComplex</code> → MEDIUM; &lt; <code>complexReasoning</code> → COMPLEX; otherwise REASONING. Raise a boundary to push more traffic into the cheaper tier below it.</p>
<p style="margin:.25rem 0"><b>Tools vs. chat.</b> <code>tiers</code> is for plain chat. <code>agenticTiers</code> overrides when the request contains tool calls — use it to force models with solid tool-use on agent workloads.</p>
<p style="margin:.25rem 0"><b>Model IDs.</b> Always <code>&lt;provider&gt;/&lt;model&gt;</code>. <code>provider</code> must exist under <code>providers</code> in this config; <code>model</code> is passed upstream verbatim, slashes and all (e.g. <code>ppq/openai/gpt-5.2-pro</code>). Expand the PPQ model list below to copy valid IDs.</p>
<p style="margin:.25rem 0"><b>Providers.</b> Each entry needs <code>baseUrl</code> (must include the API version path, e.g. <code>/v1</code> for OpenAI-compatible), <code>api</code> (<code>openai</code> or <code>anthropic</code>), and optional <code>auth</code>. Default auth pulls credentials from Hermes <code>~/.hermes/auth.json</code>; set <code>auth: {"type":"env","key":"FOO_API_KEY"}</code> to read from an env var instead.</p>
<p style="margin:.25rem 0"><b>Thinking.</b> <code>thinking.adaptive</code> lists model-name substrings that get dynamic reasoning budgets. <code>thinking.enabled</code> pins a fixed token budget for other models.</p>
<p style="margin:.25rem 0"><b>Saving.</b> <i>save + reload</i> writes this JSON to the active config file and hot-reloads providers, tiers, and auth — no restart needed. <i>revert</i> discards unsaved edits. <i>reload from disk</i> re-reads the file (use after editing it on the filesystem directly).</p>
<p style="margin:.25rem 0"><b>Systemd.</b> Logs: <code>journalctl --user -u freerouter -f</code> (also tee'd to <code>/tmp/freerouter.log</code>). Restart: <code>systemctl --user restart freerouter</code>.</p>
</div>
</details>
<div class="status" id="status"></div>
<datalist id="ppqdl"></datalist>
<div id="form">
  <h2>tier boundaries <span class="meta">complexity score cut points (0–1)</span></h2>
  <div class="card"><div class="row">
    <label>simple → medium<input type="number" id="b_sm" step="0.01" min="0" max="1"></label>
    <label>medium → complex<input type="number" id="b_mc" step="0.01" min="0" max="1"></label>
    <label>complex → reasoning<input type="number" id="b_cr" step="0.01" min="0" max="1"></label>
  </div></div>
  <h2>chat tiers <span class="meta">used when the request has no tool calls</span></h2>
  <div id="tiersBox"></div>
  <h2>agentic tiers <span class="meta">overrides when the request contains tool calls</span></h2>
  <div id="agTiersBox"></div>
  <h2>vision tier <span class="meta">overrides when the request contains image content (leave primary blank to disable)</span></h2>
  <div id="visionBox"></div>
  <h2>thinking</h2>
  <div class="card"><div class="row">
    <label style="flex:2">adaptive (model substrings, one per line)<textarea id="th_adaptive"></textarea></label>
    <label style="flex:2">enabled models (one per line)<textarea id="th_enabled"></textarea></label>
    <label style="flex:1;min-width:100px">budget (tokens)<input type="number" id="th_budget" step="256" min="0"></label>
  </div></div>
</div>
<div style="margin-top:.75rem">
  <button id="save" disabled>save + reload</button>
  <button class="secondary" id="revert" disabled>revert</button>
  <button class="secondary" id="reloadOnly">reload from disk</button>
</div>
<details><summary>advanced: raw JSON editor (providers, auth, scoring)</summary>
<div class="meta" style="margin:.25rem 0">use this to add providers or edit fields not exposed above</div>
<textarea id="ed" spellcheck="false" disabled>loading…</textarea>
<div style="margin-top:.5rem"><button id="saveRaw" disabled>save raw JSON + reload</button></div>
</details>
<details open><summary>available PPQ models (grouped by category)</summary>
<div class="meta" style="margin:.25rem 0">click any model ID to copy <code>ppq/&lt;id&gt;</code></div>
<div class="mctrl">
  <label>provider <select id="mfProvider"><option value="">(all)</option></select></label>
  <label>sort <select id="mfSort">
    <option value="cost-asc">cost per request ↑</option>
    <option value="cost-desc">cost per request ↓</option>
    <option value="name">name</option>
  </select></label>
  <label>search <input id="mfSearch" placeholder="filter id/name"></label>
  <span class="meta" id="mfCount"></span>
</div>
<div id="models">not loaded</div></details>
</div>
<div id="tabStats" hidden>
<div class="meta" style="margin:.25rem 0">auto-refreshes every 5 seconds — every request HermRouter handles is logged to <code id="s_logPathInline">~/.freerouter/routing.jsonl</code></div>
<div id="ppqPanel" class="card" style="padding:.75rem;margin-bottom:.75rem" hidden>
  <div style="display:flex;justify-content:space-between;align-items:baseline">
    <h2 style="margin:0">ppq account activity</h2>
    <span class="meta" id="ppq_fetched">—</span>
  </div>
  <div style="display:flex;gap:1.5rem;flex-wrap:wrap;margin:.5rem 0">
    <div><div class="meta">balance</div><div id="ppq_balance" style="font:600 20px/1 system-ui;color:#34d399">—</div></div>
    <div><div class="meta">24h spend</div><div id="ppq_spend" style="font:600 20px/1 system-ui">—</div></div>
    <div><div class="meta">24h requests</div><div id="ppq_reqs" style="font:600 20px/1 system-ui">—</div></div>
  </div>
  <div class="meta" style="margin-top:.5rem">cost by model (last 24h)</div>
  <div id="ppq_byModel" style="margin:.25rem 0;font:12px/1.5 ui-monospace,monospace"></div>
  <div class="meta" id="ppq_err" style="color:#fca5a5;display:none"></div>
</div>
<div id="pinchPanel" class="card" style="padding:.75rem;margin-bottom:.75rem">
  <div style="display:flex;justify-content:space-between;align-items:baseline">
    <h2 style="margin:0">your config vs. pinchbench</h2>
    <span class="meta" id="pinch_meta">—</span>
  </div>
  <div class="meta" style="margin-top:.25rem">scores from <a href="https://pinchbench.com/?view=graphs&amp;graph=radar" target="_blank" style="color:#60a5fa">pinchbench</a> openclaw leaderboard · prices from <a href="https://ppq.ai/pricing" target="_blank" style="color:#60a5fa">ppq.ai/pricing</a> · example = 50k input + 200 output tokens (typical hermes turn)</div>
  <div style="max-height:420px;overflow:auto;margin-top:.5rem;background:#0f1115;border:1px solid #2a2f3a;border-radius:4px">
  <table class="mtab" style="width:100%;font:12px/1.4 ui-monospace,monospace">
    <thead><tr>
      <th style="text-align:left">model</th>
      <th style="text-align:right">score</th>
      <th style="text-align:right" title="USD per million input tokens / per million output tokens">in/out $/1M</th>
      <th style="text-align:right" title="80% input + 20% output, per 1k tokens">blend $/1k</th>
      <th style="text-align:right" title="50k input + 200 output tokens — typical Hermes turn">ex. req</th>
      <th style="text-align:left">slots</th>
    </tr></thead>
    <tbody id="pinch_rows"></tbody>
  </table>
  </div>
  <div class="meta" id="pinch_err" style="color:#fca5a5;display:none;margin-top:.5rem"></div>
</div>
<div id="statsPanel" class="card" style="padding:.75rem">
  <div class="meta" id="statsMeta">loading…</div>
  <div style="display:flex;gap:1.5rem;flex-wrap:wrap;margin:.5rem 0">
    <div><div class="meta">total requests</div><div id="s_total" style="font:600 20px/1 system-ui">—</div></div>
    <div><div class="meta">errors</div><div id="s_err" style="font:600 20px/1 system-ui;color:#fca5a5">—</div></div>
    <div><div class="meta">timeouts</div><div id="s_to" style="font:600 20px/1 system-ui;color:#fcd34d">—</div></div>
    <div><div class="meta">window size</div><div id="s_win" style="font:600 20px/1 system-ui">—</div></div>
  </div>
  <div class="meta" style="margin-top:.5rem">tier distribution (last window)</div>
  <div id="s_tierBars" style="margin:.25rem 0"></div>
  <div class="meta" style="margin-top:.5rem">top routed models (last window)</div>
  <div id="s_topModels" style="margin:.25rem 0;font:12px/1.5 ui-monospace,monospace"></div>
  <div class="meta" style="margin-top:.5rem">recent decisions</div>
  <div style="max-height:360px;overflow:auto;background:#0f1115;border:1px solid #2a2f3a;border-radius:4px">
  <table class="mtab" style="width:100%"><thead><tr>
    <th>time</th><th>tier</th><th>model</th><th>override</th><th style="text-align:right">conf</th><th style="text-align:right">est. cost</th><th>reasoning</th>
  </tr></thead><tbody id="s_rows"></tbody></table>
  </div>
  <div class="meta" style="margin-top:.5rem">log file: <span id="s_logPath">—</span></div>
</div>
<h2 style="margin-top:1rem">what to watch for</h2>
<div class="tip"><b>SIMPLE / MEDIUM appearing often?</b> Those tiers currently point at non-Claude backends (arcee, qwen) — the most likely cause of quality drops. If most of your real work is landing there, raise the tier floor in the <i>chat tiers</i> and <i>agentic tiers</i> sections to point at <code>ppq/claude-haiku-4.5</code> or <code>ppq/claude-sonnet-4.6</code>.</div>
<div class="tip"><b>Low classifier confidence (&lt;60%) routing to a cheap tier?</b> The classifier is unsure but still downgrading. Raise <code>simple → medium</code> and <code>medium → complex</code> under <i>tier boundaries</i> — that pushes ambiguous requests up to stronger models.</div>
<div class="tip"><b>Claude Code requests not showing <code>override: tools</code>?</b> The tool-forcing logic isn't firing, which means agentic work is going through the chat tiers instead of <i>agentic tiers</i>. Check that your client is actually sending a <code>tools</code> array in the request.</div>
<div class="tip"><b>Lots of <code>override: vision</code>?</b> Expected if you paste a lot of screenshots. Make sure <i>vision tier</i> primary is set to a model you trust with images.</div>
<div class="tip"><b>High fallback / error rate on a specific model?</b> It's failing upstream. Swap the primary for something more reliable, or reorder the fallback list.</div>
<div class="tip"><b>Context compacting too early in your client?</b> Not visible here — that's a client-side decision based on the model name in the request. Check what <code>clientModel</code> shows in the recent-decisions table; if it's an unknown name, the client is falling back to a conservative default window.</div>
</div>
<script>
const ed=document.getElementById('ed'),st=document.getElementById('status'),meta=document.getElementById('meta');
const save=document.getElementById('save'),rev=document.getElementById('revert'),rel=document.getElementById('reloadOnly');
const saveRaw=document.getElementById('saveRaw');
const tabBtns={config:document.getElementById('tabBtnConfig'),stats:document.getElementById('tabBtnStats')};
const tabPanes={config:document.getElementById('tabConfig'),stats:document.getElementById('tabStats')};
function switchTab(name){
  for(const k of Object.keys(tabPanes)){
    tabPanes[k].hidden=(k!==name);
    tabBtns[k].classList.toggle('active',k===name);
  }
  try{history.replaceState(null,'','#'+name)}catch(e){}
  if(name==='stats')loadStats();
}
tabBtns.config.onclick=()=>switchTab('config');
tabBtns.stats.onclick=()=>switchTab('stats');
if(location.hash==='#stats')switchTab('stats');
const TIERS=['SIMPLE','MEDIUM','COMPLEX','REASONING'];
let lastCfg=null, workingCfg=null;
function clone(x){return JSON.parse(JSON.stringify(x))}
function show(kind,msg){st.className='status '+kind;st.textContent=msg}
function clr(){st.className='status';st.textContent=''}
function copyText(s){
  try{if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(s);return true}}catch(e){}
  const ta=document.createElement('textarea');ta.value=s;ta.style.cssText='position:fixed;top:0;left:0;opacity:0;pointer-events:none';document.body.appendChild(ta);ta.focus();ta.select();
  let ok=false;try{ok=document.execCommand('copy')}catch(e){}
  document.body.removeChild(ta);return ok;
}
function buildTierCards(hostId,section){
  const host=document.getElementById(hostId);host.innerHTML='';
  workingCfg[section]=workingCfg[section]||{};
  for(const t of TIERS){
    const tier=workingCfg[section][t]||{primary:'',fallback:[]};
    tier.fallback=tier.fallback||[];
    workingCfg[section][t]=tier;
    const card=document.createElement('div');card.className='tier';
    const h=document.createElement('h3');h.textContent=t;card.appendChild(h);
    const pl=document.createElement('label');pl.style.fontSize='11px';pl.style.color='#9db2c7';pl.style.display='block';pl.textContent='primary';
    const pi=document.createElement('input');pi.type='text';pi.value=tier.primary||'';pi.setAttribute('list','ppqdl');pi.placeholder='ppq/claude-opus-4.6';pi.style.cssText='width:100%;background:#0f1115;color:#e6e6e6;border:1px solid #2a2f3a;border-radius:4px;padding:.3rem .4rem;font:12px/1.4 ui-monospace,monospace;margin-top:.15rem;box-sizing:border-box';
    pi.oninput=()=>{tier.primary=pi.value};
    pl.appendChild(pi);card.appendChild(pl);
    const fl=document.createElement('div');fl.style.cssText='font-size:11px;color:#9db2c7;margin:.35rem 0 .1rem';fl.textContent='fallback (tried in order on error)';
    card.appendChild(fl);
    const fbHost=document.createElement('div');card.appendChild(fbHost);
    function redraw(){
      fbHost.innerHTML='';
      tier.fallback.forEach((v,i)=>{
        const row=document.createElement('div');row.className='fb';
        const inp=document.createElement('input');inp.type='text';inp.value=v;inp.setAttribute('list','ppqdl');inp.placeholder='ppq/...';inp.style.cssText='flex:1;background:#0f1115;color:#e6e6e6;border:1px solid #2a2f3a;border-radius:4px;padding:.3rem .4rem;font:12px/1.4 ui-monospace,monospace';
        inp.oninput=()=>{tier.fallback[i]=inp.value};
        const x=document.createElement('button');x.className='x';x.type='button';x.textContent='×';x.title='remove';
        x.onclick=()=>{tier.fallback.splice(i,1);redraw()};
        row.append(inp,x);fbHost.appendChild(row);
      });
      const add=document.createElement('button');add.className='add';add.type='button';add.textContent='+ add fallback';
      add.onclick=()=>{tier.fallback.push('');redraw()};
      fbHost.appendChild(add);
    }
    redraw();
    host.appendChild(card);
  }
}
function buildVisionCard(){
  const host=document.getElementById('visionBox');host.innerHTML='';
  if(!workingCfg.visionTier)workingCfg.visionTier={primary:'',fallback:[]};
  const tier=workingCfg.visionTier;tier.fallback=tier.fallback||[];
  const card=document.createElement('div');card.className='tier';
  const pl=document.createElement('label');pl.style.cssText='font-size:11px;color:#9db2c7;display:block';pl.textContent='primary (blank to disable vision override)';
  const pi=document.createElement('input');pi.type='text';pi.value=tier.primary||'';pi.setAttribute('list','ppqdl');pi.placeholder='ppq/claude-opus-4.6';pi.style.cssText='width:100%;background:#0f1115;color:#e6e6e6;border:1px solid #2a2f3a;border-radius:4px;padding:.3rem .4rem;font:12px/1.4 ui-monospace,monospace;margin-top:.15rem;box-sizing:border-box';
  pi.oninput=()=>{tier.primary=pi.value};
  pl.appendChild(pi);card.appendChild(pl);
  const fl=document.createElement('div');fl.style.cssText='font-size:11px;color:#9db2c7;margin:.35rem 0 .1rem';fl.textContent='fallback (tried in order on error)';
  card.appendChild(fl);
  const fbHost=document.createElement('div');card.appendChild(fbHost);
  function redraw(){
    fbHost.innerHTML='';
    tier.fallback.forEach((v,i)=>{
      const row=document.createElement('div');row.className='fb';
      const inp=document.createElement('input');inp.type='text';inp.value=v;inp.setAttribute('list','ppqdl');inp.placeholder='ppq/...';inp.style.cssText='flex:1;background:#0f1115;color:#e6e6e6;border:1px solid #2a2f3a;border-radius:4px;padding:.3rem .4rem;font:12px/1.4 ui-monospace,monospace';
      inp.oninput=()=>{tier.fallback[i]=inp.value};
      const x=document.createElement('button');x.className='x';x.type='button';x.textContent='×';x.title='remove';
      x.onclick=()=>{tier.fallback.splice(i,1);redraw()};
      row.append(inp,x);fbHost.appendChild(row);
    });
    const add=document.createElement('button');add.className='add';add.type='button';add.textContent='+ add fallback';
    add.onclick=()=>{tier.fallback.push('');redraw()};
    fbHost.appendChild(add);
  }
  redraw();host.appendChild(card);
}
function buildForm(){
  workingCfg=clone(lastCfg);
  workingCfg.tierBoundaries=workingCfg.tierBoundaries||{simpleMedium:0,mediumComplex:0,complexReasoning:0};
  const bindNum=(id,path)=>{
    const el=document.getElementById(id);
    el.value=path();
    el.oninput=()=>{const n=parseFloat(el.value);path(Number.isFinite(n)?n:0)};
  };
  const tb=workingCfg.tierBoundaries;
  bindNum('b_sm',v=>v===undefined?tb.simpleMedium??0:(tb.simpleMedium=v));
  bindNum('b_mc',v=>v===undefined?tb.mediumComplex??0:(tb.mediumComplex=v));
  bindNum('b_cr',v=>v===undefined?tb.complexReasoning??0:(tb.complexReasoning=v));
  buildTierCards('tiersBox','tiers');
  buildTierCards('agTiersBox','agenticTiers');
  buildVisionCard();
  workingCfg.thinking=workingCfg.thinking||{};
  workingCfg.thinking.enabled=workingCfg.thinking.enabled||{models:[],budget:4096};
  const adap=document.getElementById('th_adaptive');
  adap.value=(workingCfg.thinking.adaptive||[]).join('\\n');
  adap.oninput=()=>{workingCfg.thinking.adaptive=adap.value.split('\\n').map(s=>s.trim()).filter(Boolean)};
  const ena=document.getElementById('th_enabled');
  ena.value=(workingCfg.thinking.enabled.models||[]).join('\\n');
  ena.oninput=()=>{workingCfg.thinking.enabled.models=ena.value.split('\\n').map(s=>s.trim()).filter(Boolean)};
  const bud=document.getElementById('th_budget');
  bud.value=workingCfg.thinking.enabled.budget??4096;
  bud.oninput=()=>{workingCfg.thinking.enabled.budget=parseInt(bud.value)||0};
  ed.value=JSON.stringify(lastCfg,null,2);
}
async function load(){
  clr();
  const r=await fetch('/config');
  const j=await r.json();
  lastCfg=j.config;
  meta.textContent='file: '+(j.configPath||'(defaults)');
  buildForm();
  ed.disabled=false;save.disabled=false;rev.disabled=false;saveRaw.disabled=false;
  loadStats();
}
const TIER_COLORS={SIMPLE:'#34d399',MEDIUM:'#60a5fa',COMPLEX:'#a78bfa',REASONING:'#f472b6',VISION:'#fbbf24',EXPLICIT:'#9ca3af'};
function escHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function loadStats(){
  try{
    const r=await fetch('/stats?limit=50');
    const j=await r.json();
    document.getElementById('s_total').textContent=j.requests??0;
    document.getElementById('s_err').textContent=j.errors??0;
    document.getElementById('s_to').textContent=j.timeouts??0;
    document.getElementById('s_win').textContent=j.window?.size??0;
    document.getElementById('statsMeta').textContent='started '+(j.started||'?');
    document.getElementById('s_logPath').textContent=j.logPath||'—';

    // PPQ panel
    const ppq=j.ppq;
    const ppqPanel=document.getElementById('ppqPanel');
    if(ppq&&!ppq.disabled){
      ppqPanel.hidden=false;
      const bal=ppq.balance;
      document.getElementById('ppq_balance').textContent=bal==null?'—':'$'+bal.toFixed(4);
      document.getElementById('ppq_spend').textContent='$'+(ppq.last24h?.totalUsd||0).toFixed(4);
      document.getElementById('ppq_reqs').textContent=ppq.last24h?.requests||0;
      const fetchedEl=document.getElementById('ppq_fetched');
      try{fetchedEl.textContent='fetched '+new Date(ppq.fetchedAt).toTimeString().slice(0,8)}catch(e){fetchedEl.textContent='—'}
      const bm=document.getElementById('ppq_byModel');
      const rows=Object.entries(ppq.last24h?.byModel||{}).sort((a,b)=>b[1].usd-a[1].usd);
      bm.innerHTML=rows.length
        ? rows.map(([m,v])=>'<div style="display:flex;gap:.75rem"><span style="color:#34d399;width:72px">$'+v.usd.toFixed(4)+'</span><span style="color:#9db2c7;width:48px">'+v.count+'×</span><span style="color:#6b7280;width:120px">'+(v.inTok/1000).toFixed(0)+'k in / '+v.outTok+' out</span><span>'+escHtml(m)+'</span></div>').join('')
        : '<span class="meta">no ppq traffic in last 24h</span>';
      const errEl=document.getElementById('ppq_err');
      if(ppq.error){errEl.style.display='block';errEl.textContent='ppq error: '+ppq.error}
      else errEl.style.display='none';
    }else{
      ppqPanel.hidden=true;
    }

    // Pinchbench config comparison
    const pinch=j.pinch;
    const pinchRows=document.getElementById('pinch_rows');
    const pinchMeta=document.getElementById('pinch_meta');
    const pinchErr=document.getElementById('pinch_err');
    if(pinch){
      try{pinchMeta.textContent=pinch.totalModels+' models on leaderboard · fetched '+new Date(pinch.fetchedAt).toTimeString().slice(0,8)}catch(e){pinchMeta.textContent='—'}
      if(pinch.error){pinchErr.style.display='block';pinchErr.textContent='pinchbench error: '+pinch.error}else pinchErr.style.display='none';
      const matched=(pinch.configured||[]).filter(x=>x.pinch);
      const scores=matched.map(x=>x.pinch.bestScore);
      const maxScore=Math.max(...scores,0.01);
      pinchRows.innerHTML='';
      for(const entry of (pinch.configured||[])){
        const tr=document.createElement('tr');
        const p=entry.pinch;
        const pr=entry.price;
        let scoreCell='<td style="text-align:right;color:#6b7280">—</td>';
        if(p){
          const bestPct=(p.bestScore*100).toFixed(1)+'%';
          const rel=p.bestScore/maxScore;
          const color=rel>0.97?'#34d399':rel>0.85?'#fbbf24':'#fca5a5';
          scoreCell='<td style="text-align:right;color:'+color+';font-weight:600" title="avg '+(p.avgScore*100).toFixed(1)+'%">'+bestPct+'</td>';
        }
        let inOutCell='<td style="text-align:right;color:#6b7280">—</td>';
        let blendCell='<td style="text-align:right;color:#6b7280">—</td>';
        let exCell='<td style="text-align:right;color:#6b7280">—</td>';
        if(pr){
          inOutCell='<td style="text-align:right">$'+pr.inputPerM.toFixed(2)+' / $'+pr.outputPerM.toFixed(2)+'</td>';
          blendCell='<td style="text-align:right">$'+pr.blendedPerK.toFixed(5)+'</td>';
          exCell='<td style="text-align:right">$'+pr.exampleRequest.toFixed(4)+'</td>';
        }
        const matchedTitle=p?'matched as '+p.matchedAs:'not on pinchbench leaderboard';
        tr.innerHTML='<td title="'+escHtml(matchedTitle)+'">'+escHtml(entry.model)+'</td>'+
          scoreCell+inOutCell+blendCell+exCell+
          '<td class="mprov" style="color:#6b7280;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+escHtml(entry.slots.join(', '))+'">'+escHtml(entry.slots.join(', '))+'</td>';
        pinchRows.appendChild(tr);
      }
    }

    // Tier distribution bars (last window)
    const bars=document.getElementById('s_tierBars');bars.innerHTML='';
    const byTier=j.window?.byTier||{};
    const total=Object.values(byTier).reduce((a,b)=>a+b,0)||1;
    const order=['SIMPLE','MEDIUM','COMPLEX','REASONING','VISION','EXPLICIT'];
    for(const t of order){
      const n=byTier[t]||0;if(!n&&!order.includes(t))continue;
      const pct=(n/total*100).toFixed(0);
      const row=document.createElement('div');
      row.style.cssText='display:flex;align-items:center;gap:.5rem;margin:.15rem 0;font:12px/1 ui-monospace,monospace';
      row.innerHTML='<div style="width:90px;color:#9db2c7">'+t+'</div>'+
        '<div style="flex:1;background:#0f1115;border-radius:2px;overflow:hidden;height:14px"><div style="width:'+pct+'%;height:100%;background:'+(TIER_COLORS[t]||'#6b7280')+'"></div></div>'+
        '<div style="width:60px;text-align:right">'+n+' ('+pct+'%)</div>';
      bars.appendChild(row);
    }

    // Top models
    const tm=document.getElementById('s_topModels');
    const byModel=Object.entries(j.window?.byModel||{}).sort((a,b)=>b[1]-a[1]).slice(0,6);
    tm.innerHTML=byModel.length
      ? byModel.map(([m,n])=>'<div style="display:flex;gap:.5rem"><span style="color:#fbbf24">'+n+'</span><span>'+escHtml(m)+'</span></div>').join('')
      : '<span class="meta">no recent decisions</span>';

    // Recent decisions table
    const rows=document.getElementById('s_rows');rows.innerHTML='';
    const recent=(j.recent||[]).slice().reverse();
    for(const d of recent){
      const t=new Date(d.ts);
      const tStr=isNaN(t)?d.ts:t.toTimeString().slice(0,8);
      const conf=d.classifierConfidence==null?'—':(d.classifierConfidence*100).toFixed(0)+'%';
      const color=TIER_COLORS[d.tier]||'#9db2c7';
      const tr=document.createElement('tr');
      const hasPpq=d.ppqCostUsd!=null;
      const costVal=hasPpq?d.ppqCostUsd:d.estInputCostUsd;
      const cost=costVal!=null?'$'+costVal.toFixed(4):'—';
      const costColor=hasPpq?'#34d399':'#6b7280';
      const costTitle=hasPpq
        ?'PPQ actual: '+d.ppqInTok+' in / '+d.ppqOutTok+' out tokens'
        :'estimate (input only, chars/4)';
      tr.innerHTML='<td>'+escHtml(tStr)+'</td>'+
        '<td style="color:'+color+';font-weight:600">'+escHtml(d.tier)+'</td>'+
        '<td>'+escHtml(d.routedModel)+'</td>'+
        '<td class="mprov">'+escHtml(d.override)+'</td>'+
        '<td style="text-align:right">'+conf+'</td>'+
        '<td style="text-align:right;color:'+costColor+';font-variant-numeric:tabular-nums;cursor:help" title="'+costTitle+'">'+cost+'</td>'+
        '<td class="mprov" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+escHtml(d.reasoning)+'">'+escHtml(d.reasoning)+'</td>';
      rows.appendChild(tr);
    }
  }catch(e){
    document.getElementById('statsMeta').textContent='stats error: '+e;
  }
}
const CATS=['Popular','Text','Image','Video','Audio'];
let _catalog=[];
function renderModels(){
  const host=document.getElementById('models');host.innerHTML='';
  const prov=document.getElementById('mfProvider').value;
  const sort=document.getElementById('mfSort').value;
  const q=document.getElementById('mfSearch').value.trim().toLowerCase();
  const filtered=_catalog.filter(m=>(!prov||m.provider===prov)&&(!q||m.id.toLowerCase().includes(q)||(m.name||'').toLowerCase().includes(q)));
  document.getElementById('mfCount').textContent=filtered.length+' / '+_catalog.length+' models';
  const cmp={
    'cost-asc':(a,b)=>(a.costNum??Infinity)-(b.costNum??Infinity)||a.id.localeCompare(b.id),
    'cost-desc':(a,b)=>(b.costNum??-Infinity)-(a.costNum??-Infinity)||a.id.localeCompare(b.id),
    'name':(a,b)=>a.id.localeCompare(b.id),
  }[sort];
  for(const cat of CATS){
    const list=filtered.filter(m=>m.category===cat).sort(cmp);
    if(!list.length)continue;
    const d=document.createElement('details');d.className='mgroup';d.open=(cat==='Popular'||cat==='Text');
    const s=document.createElement('summary');s.textContent=cat+' ('+list.length+')';d.appendChild(s);
    const body=document.createElement('div');body.className='mbody';
    const tab=document.createElement('table');tab.className='mtab';
    const isMedia=(cat==='Image'||cat==='Video'||cat==='Audio');
    tab.innerHTML='<thead><tr><th>model id</th><th>name</th><th>provider</th><th style="text-align:right">'+(isMedia?'cost/req':'avg cost/req')+'</th></tr></thead>';
    const tb=document.createElement('tbody');
    for(const m of list){
      const tr=document.createElement('tr');
      const idCell=document.createElement('td');idCell.textContent='ppq/'+m.id;
      const nameCell=document.createElement('td');nameCell.textContent=m.name||'';
      const provCell=document.createElement('td');provCell.className='mprov';provCell.textContent=m.provider||'';
      const costCell=document.createElement('td');costCell.className='mcost';costCell.textContent=m.costRaw||'—';
      tr.append(idCell,nameCell,provCell,costCell);tb.appendChild(tr);
    }
    tab.appendChild(tb);body.appendChild(tab);d.appendChild(body);host.appendChild(d);
  }
}
async function loadModels(){
  const host=document.getElementById('models');host.textContent='loading…';
  try{
    const r=await fetch('/ppq-catalog');const j=await r.json();
    _catalog=j.data||[];
    const dl=document.getElementById('ppqdl');
    const seen=new Set();
    dl.innerHTML=_catalog.filter(m=>m.category==='Popular'||m.category==='Text').filter(m=>{if(seen.has(m.id))return false;seen.add(m.id);return true}).map(m=>'<option value="ppq/'+m.id+'">'+(m.name||'')+(m.costRaw?' — '+m.costRaw:'')+'</option>').join('');
    const provs=[...new Set(_catalog.map(m=>m.provider).filter(Boolean))].sort();
    const psel=document.getElementById('mfProvider');
    psel.innerHTML='<option value="">(all)</option>'+provs.map(p=>'<option>'+p+'</option>').join('');
    ['mfProvider','mfSort','mfSearch'].forEach(id=>{
      const el=document.getElementById(id);
      el.addEventListener(id==='mfSearch'?'input':'change',renderModels);
    });
    renderModels();
  }catch(e){host.textContent='failed: '+e}
}
async function putCfg(cfg){
  const r=await fetch('/config',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(cfg)});
  const j=await r.json();
  if(!r.ok)throw new Error(j.error?.message||JSON.stringify(j));
  return j;
}
function cleanCfg(c){
  for(const sec of ['tiers','agenticTiers']){
    if(!c[sec])continue;
    for(const t of TIERS){
      if(!c[sec][t])continue;
      c[sec][t].fallback=(c[sec][t].fallback||[]).filter(s=>s&&s.trim());
    }
  }
  if(c.visionTier){
    const p=(c.visionTier.primary||'').trim();
    if(!p){delete c.visionTier}
    else{c.visionTier.primary=p;c.visionTier.fallback=(c.visionTier.fallback||[]).filter(s=>s&&s.trim())}
  }
  return c;
}
save.onclick=async()=>{
  clr();save.disabled=true;
  try{
    const cfg=cleanCfg(clone(workingCfg));
    const j=await putCfg(cfg);
    show('ok','saved + reloaded → '+(j.path||''));
    lastCfg=cfg;buildForm();loadStats();
  }catch(e){show('err',String(e))}finally{save.disabled=false}
};
rev.onclick=()=>{buildForm();clr()};
saveRaw.onclick=async()=>{
  clr();let cfg;
  try{cfg=JSON.parse(ed.value)}catch(e){return show('err','JSON parse error: '+e.message)}
  saveRaw.disabled=true;
  try{
    const j=await putCfg(cfg);
    show('ok','saved + reloaded → '+(j.path||''));
    lastCfg=cfg;buildForm();loadStats();
  }catch(e){show('err',String(e))}finally{saveRaw.disabled=false}
};
rel.onclick=async()=>{clr();try{await fetch('/reload-config',{method:'POST'});await load();show('ok','reloaded from disk')}catch(e){show('err',String(e))}};
load();loadModels();
setInterval(loadStats,5000);
</script></body></html>`;

/**
 * Handle GET /ui — inline HTML config editor.
 */
function handleUi(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(UI_HTML);
}

async function handlePpqModels(_req: IncomingMessage, res: ServerResponse) {
  try {
    const r = await fetch("https://api.ppq.ai/v1/models");
    const body = await r.text();
    res.writeHead(r.status, { "Content-Type": "application/json" });
    res.end(body);
  } catch (err) {
    sendError(res, 502, err instanceof Error ? err.message : String(err));
  }
}

type CatalogEntry = {
  category: "Popular" | "Text" | "Image" | "Video" | "Audio";
  name: string;
  id: string;
  provider: string;
  context: string | null;
  dateAdded: string | null;
  input: string | null;
  output: string | null;
  costRaw: string | null;
  costNum: number | null;
};
let _catalogCache: { at: number; data: CatalogEntry[] } | null = null;
const CATALOG_TTL_MS = 10 * 60 * 1000;

function parsePpqCatalog(html: string): CatalogEntry[] {
  const sections: Array<[string, CatalogEntry["category"]]> = [
    ["Popular models", "Popular"],
    ["Text models", "Text"],
    ["Image Models", "Image"],
    ["Video Models", "Video"],
    ["Audio Models", "Audio"],
  ];
  const markers: Array<{ name: string; cat: CatalogEntry["category"]; pos: number }> = [];
  for (const [h, cat] of sections) {
    const re = new RegExp(`<h2[^>]*>${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</h2>`);
    const m = re.exec(html);
    if (m) markers.push({ name: h, cat, pos: m.index });
  }
  const endMarker = html.indexOf("Data Enrichment");
  markers.push({ name: "END", cat: "Popular", pos: endMarker >= 0 ? endMarker : html.length });

  const stripTags = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const parseCost = (s: string | null): number | null => {
    if (!s) return null;
    const m = /\$?([0-9]+(?:\.[0-9]+)?)/.exec(s);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return Number.isFinite(n) ? n : null;
  };

  const out: CatalogEntry[] = [];
  for (let i = 0; i < markers.length - 1; i++) {
    const { cat, pos } = markers[i];
    const end = markers[i + 1].pos;
    const chunk = html.slice(pos, end);
    const tbodyMatch = /<tbody[^>]*>([\s\S]*?)<\/tbody>/.exec(chunk);
    if (!tbodyMatch) continue;
    const body = tbodyMatch[1];
    const rows = body.split("</tr>");
    for (const row of rows) {
      const tds: string[] = [];
      const tdRe = /<td[^>]*>([\s\S]*?)(?=<td|$)/g;
      let tm: RegExpExecArray | null;
      while ((tm = tdRe.exec(row)) !== null) tds.push(stripTags(tm[1]));
      if (tds.length < 5) continue;
      const name = tds[0];
      const id = tds[1];
      const provider = tds[2];
      if (!id || id.length > 120) continue;
      let ctx: string | null = null, date: string | null = null, inp: string | null = null, outp: string | null = null, costRaw: string | null = null;
      if (cat === "Popular" || cat === "Text") {
        ctx = tds[3] ?? null;
        date = tds[4] ?? null;
        inp = tds[5] ?? null;
        outp = tds[6] ?? null;
        costRaw = tds[7] ?? null;
      } else if (cat === "Image" || cat === "Video") {
        date = tds[3] ?? null;
        costRaw = tds[6] ?? null;
      } else if (cat === "Audio") {
        date = tds[3] ?? null;
        costRaw = tds[4] ?? null;
      }
      out.push({
        category: cat,
        name,
        id,
        provider,
        context: ctx,
        dateAdded: date,
        input: inp,
        output: outp,
        costRaw,
        costNum: parseCost(costRaw),
      });
    }
  }
  return out;
}

async function handlePpqCatalog(_req: IncomingMessage, res: ServerResponse) {
  try {
    if (!_catalogCache || Date.now() - _catalogCache.at > CATALOG_TTL_MS) {
      const r = await fetch("https://ppq.ai/pricing");
      if (!r.ok) throw new Error(`pricing page ${r.status}`);
      const html = await r.text();
      _catalogCache = { at: Date.now(), data: parsePpqCatalog(html) };
      logger.info(`PPQ catalog refreshed: ${_catalogCache.data.length} entries`);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ fetchedAt: _catalogCache.at, data: _catalogCache.data }));
  } catch (err) {
    sendError(res, 502, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Handle PUT /config — replace config file and reload.
 */
async function handlePutConfig(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  let body: FreeRouterConfig;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    sendError(res, 400, `Invalid JSON: ${(err as Error).message}`, "bad_request");
    return;
  }
  if (!body || typeof body !== "object" || !body.providers || !body.tiers) {
    sendError(res, 400, "Config must contain at least `providers` and `tiers`", "bad_request");
    return;
  }
  // Restore redacted secrets: /config returns "***" for auth.key and authPath,
  // and the web editor PUTs the full object back. Merge real values from the
  // currently-loaded config so saves don't clobber credentials.
  const current = getConfig();
  for (const [name, prov] of Object.entries(body.providers ?? {})) {
    const p = prov as { auth?: { key?: string } };
    const cp = (current.providers as Record<string, { auth?: { key?: string } }>)[name];
    if (p?.auth?.key === "***" && cp?.auth?.key) p.auth.key = cp.auth.key;
  }
  if (body.auth && current.auth) {
    for (const [k, v] of Object.entries(body.auth)) {
      if (k === "default") continue;
      const cv = (current.auth as Record<string, unknown>)[k];
      if (v && typeof v === "object" && cv && typeof cv === "object") {
        const vv = v as { authPath?: string };
        const cvv = cv as { authPath?: string };
        if (vv.authPath === "***" && cvv.authPath) vv.authPath = cvv.authPath;
      }
    }
  }
  try {
    const { path } = writeConfig(body);
    reloadAuth();
    const cfg = getConfig();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "saved",
      path,
      providers: Object.keys(cfg.providers),
      tiers: Object.keys(cfg.tiers),
    }));
  } catch (err) {
    sendError(res, 500, `Write failed: ${(err as Error).message}`);
  }
}

/**
 * Handle POST /reload
 */
function handleReload(_req: IncomingMessage, res: ServerResponse) {
  reloadConfig();
  reloadAuth();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "reloaded" }));
}

/**
 * Request router.
 */
async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
      await handleChatCompletions(req, res);
    } else if (method === "GET" && (url === "/v1/models" || url === "/models")) {
      handleListModels(req, res);
    } else if (method === "GET" && url === "/health") {
      handleHealth(req, res);
    } else if (method === "GET" && (url === "/stats" || url.startsWith("/stats?"))) {
      await handleStats(req, res);
    } else if (method === "POST" && url === "/reload") {
      handleReload(req, res);
    } else if (method === "GET" && url === "/config") {
      handleConfig(req, res);
    } else if (method === "PUT" && url === "/config") {
      await handlePutConfig(req, res);
    } else if (method === "POST" && url === "/reload-config") {
      handleReloadConfig(req, res);
    } else if (method === "GET" && (url === "/ui" || url === "/ui/")) {
      handleUi(req, res);
    } else if (method === "GET" && url === "/ppq-models") {
      await handlePpqModels(req, res);
    } else if (method === "GET" && url === "/ppq-catalog") {
      await handlePpqCatalog(req, res);
    } else {
      sendError(res, 404, `Not found: ${method} ${url}`, "not_found");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Unhandled error: ${msg}`);
    if (!res.headersSent) {
      sendError(res, 500, msg);
    }
  }
}

// ─── Start server ───

if (process.argv.includes("--debug")) {
  setLogLevel("debug");
}

const server = createServer(handleRequest);

server.listen(PORT, HOST, () => {
  logger.info(`🚀 HermRouter proxy listening on http://${HOST}:${PORT} (config: ${getConfigPath() ?? "built-in defaults"})`);
  logger.info(`   POST /v1/chat/completions  — route & forward`);
  logger.info(`   GET  /v1/models            — list models`);
  logger.info(`   GET  /health               — health check`);
  logger.info(`   GET  /stats                — request statistics`);
  logger.info(`   POST /reload               — reload auth keys`);
  logger.info(`   GET  /config               — show config (sanitized)`);
  logger.info(`   POST /reload-config         — reload config + auth`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  logger.info("Shutting down...");
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  logger.info("Shutting down...");
  server.close(() => process.exit(0));
});
