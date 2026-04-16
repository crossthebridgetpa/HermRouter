/**
 * HermRouter Auth — loads credentials from Hermes Agent's credential pool
 * (~/.hermes/auth.json). Zero-dep. Per-provider env-var overrides are still
 * honored via freerouter.config.json (`providers.<name>.auth.type = "env"`).
 */

import { readFileSync } from "node:fs";
import { getConfig } from "./config.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger } from "./logger.js";

export type ProviderAuth = {
  provider: string;
  profileName: string;
  token?: string;   // OAuth access token (e.g. Anthropic via claude_code)
  apiKey?: string;  // Long-lived API key (OpenAI-shaped providers)
};

type HermesCredential = {
  id: string;
  label?: string;
  auth_type: "oauth" | "api_key";
  priority?: number;
  source?: string;
  access_token?: string;
  refresh_token?: string;
  key?: string;
  last_status?: string;
  expires_at_ms?: number;
};

type HermesAuthFile = {
  version: number;
  credential_pool?: Record<string, HermesCredential[]>;
};

let authCache: Map<string, ProviderAuth> | null = null;

function resolvePath(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function pickBestCredential(entries: HermesCredential[]): HermesCredential | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const now = Date.now();

  const viable = entries.filter(e => {
    if (e.last_status === "error") return false;
    if (e.auth_type === "oauth") {
      if (!e.access_token) return false;
      // Hermes refreshes in its own process; accept unexpired or unknown expiry.
      if (e.expires_at_ms && e.expires_at_ms <= now) return false;
      return true;
    }
    return e.auth_type === "api_key" && !!e.key;
  });

  viable.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  return viable[0];
}

function loadFromHermes(): Map<string, ProviderAuth> {
  const cfg = getConfig();
  const authCfg = cfg.auth;
  const defaultAuth = authCfg[authCfg.default] as { type?: string; authPath?: string } | undefined;
  const filePath = resolvePath(defaultAuth?.authPath ?? "~/.hermes/auth.json");

  try {
    const raw = readFileSync(filePath, "utf-8");
    const data: HermesAuthFile = JSON.parse(raw);
    const map = new Map<string, ProviderAuth>();

    for (const [provider, entries] of Object.entries(data.credential_pool ?? {})) {
      const best = pickBestCredential(entries);
      if (!best) continue;

      map.set(provider, {
        provider,
        profileName: best.label ?? best.id,
        token: best.auth_type === "oauth" ? best.access_token : undefined,
        apiKey: best.auth_type === "api_key" ? best.key : undefined,
      });
    }

    logger.info(`Loaded Hermes auth for providers: ${[...map.keys()].join(", ") || "(none)"}`);
    return map;
  } catch (err) {
    logger.error(`Failed to load Hermes auth from ${filePath}:`, err);
    return new Map();
  }
}

export function getAuth(provider: string): ProviderAuth | undefined {
  // Per-provider env-var override takes precedence.
  const envAuth = getEnvAuth(provider);
  if (envAuth) return envAuth;

  if (!authCache) {
    authCache = loadFromHermes();
  }
  return authCache.get(provider);
}

/**
 * Get auth from environment variable (for providers with auth.type=env in config).
 */
function getEnvAuth(provider: string): ProviderAuth | undefined {
  const cfg = getConfig();
  const providerCfg = cfg.providers[provider];
  if (!providerCfg?.auth || providerCfg.auth.type !== "env") return undefined;
  const envKey = providerCfg.auth.key;
  if (!envKey) return undefined;
  const value = process.env[envKey];
  if (!value) return undefined;
  return {
    provider,
    profileName: envKey,
    apiKey: value,
  };
}

export function reloadAuth(): void {
  authCache = null;
  logger.info("Auth cache cleared, will reload on next access");
}

/**
 * Get the authorization header value for a provider.
 */
export function getAuthHeader(provider: string): string | undefined {
  const auth = getAuth(provider);
  if (!auth) return undefined;
  if (auth.token) return auth.token;
  if (auth.apiKey) return auth.apiKey;
  return undefined;
}
