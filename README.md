# HermRouter

A self-hosted LLM proxy that automatically routes requests to the best model based on complexity. OpenAI-compatible API — drop it in front of any client that speaks OpenAI format and it picks the right model for each request.

Built for use with [Hermes](https://github.com/crossthebridgetpa) as the routing backend. Forked from [FreeRouter](https://github.com/openfreerouter/freerouter) (MIT).

## How It Works

Every incoming request gets scored across 14 dimensions (code complexity, reasoning markers, token count, creative indicators, etc.) and assigned to one of four tiers:

| Tier | When | Default Primary |
|------|------|-----------------|
| **SIMPLE** | Short questions, greetings, lookups | gemini-3-flash-preview |
| **MEDIUM** | Moderate code, multi-step tasks | qwen3.5-flash-02-23 |
| **COMPLEX** | Long code, architecture, analysis | claude-sonnet-4.6 |
| **REASONING** | Deep reasoning, math, logic chains | claude-sonnet-4.6 |

Each tier has a primary model and a fallback chain. If the primary fails or times out, the next model in the chain picks up automatically.

There are also separate **agentic tiers** (used when tool calls are detected) and a **vision tier** for image inputs.

### Mode Overrides

You can force a specific tier by prefixing your prompt:

- **Slash**: `/simple`, `/medium`, `/complex`, `/max`, `/reasoning`, `/deep`
- **Word prefix**: `complex mode: ...`, `deep mode, ...`
- **Bracket**: `[reasoning] ...`, `[simple] ...`

The prefix is stripped before forwarding to the model.

## Features

- **Zero external dependencies** — pure Node.js + TypeScript
- **OpenAI-compatible API** — works with any client that speaks `/v1/chat/completions`
- **Anthropic translation** — automatic format conversion for Claude models (tool calls, streaming, thinking blocks)
- **Adaptive thinking** — configures thinking per model (adaptive for Opus, budget-capped for Sonnet)
- **Hot-reload config** — `POST /reload-config` applies changes without restart
- **Fallback chains** — automatic retry on failure or timeout
- **Request timeouts** — per-tier limits (30s simple → 120s reasoning) with streaming stall detection
- **Routing decision log** — every request logged to `~/.freerouter/routing.jsonl` with tier, model, confidence, override type
- **PPQ account monitoring** — live balance and 24h spend tracking via PPQ API
- **Pinchbench integration** — benchmark scores for every configured model
- **PPQ pricing display** — real per-token costs (input/output $/1M, blended $/1K)
- **Hermes auth** — reads credentials from `~/.hermes/auth.json` credential pool
- **CORS support** — works with browser-based clients
- **Multilingual classification** — keyword scoring in English, Chinese, Japanese, Russian, German

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completions |
| `GET` | `/v1/models` | List available models |
| `GET` | `/health` | Health check |
| `GET` | `/stats` | Runtime stats + PPQ usage + pinchbench scores |
| `GET` | `/ui` | Web dashboard (config editor + live stats) |
| `GET` | `/config` | Current config (secrets redacted) |
| `POST` | `/reload-config` | Hot-reload config from disk |

## Setup

### Prerequisites

- Node.js 20+
- TypeScript 5.7+
- A PPQ API key (or any OpenAI-compatible provider)

### Install

```bash
git clone https://github.com/crossthebridgetpa/HermRouter.git
cd HermRouter
npm install
npm run build
```

### Configure

Copy and edit the config file:

```bash
cp freerouter.config.json ~/.config/freerouter/config.json
```

Config search order:
1. `$FREEROUTER_CONFIG` env var
2. `./freerouter.config.json` (repo root)
3. `~/.config/freerouter/config.json`

Key sections in `freerouter.config.json`:

```jsonc
{
  "port": 18800,
  "host": "127.0.0.1",
  "providers": {
    "ppq": {
      "baseUrl": "https://api.ppq.ai/v1",
      "api": "openai"
    }
  },
  "tiers": {
    "SIMPLE":    { "primary": "ppq/gemini-3-flash-preview", "fallback": [...] },
    "MEDIUM":    { "primary": "ppq/qwen/qwen3.5-flash-02-23", "fallback": [...] },
    "COMPLEX":   { "primary": "ppq/claude-sonnet-4.6", "fallback": [...] },
    "REASONING": { "primary": "ppq/claude-sonnet-4.6", "fallback": [...] }
  },
  "tierBoundaries": {
    "simpleMedium": 0,
    "mediumComplex": 0.03,
    "complexReasoning": 0.15
  },
  "thinking": {
    "adaptive": ["claude-opus-4.6"],
    "enabled": { "models": ["claude-sonnet-4.6"], "budget": 4096 }
  }
}
```

### PPQ Account Monitoring (optional)

To enable balance and usage tracking in the stats dashboard:

```bash
echo "your-ppq-credit-id" > ~/.freerouter/ppq-credit-id
chmod 600 ~/.freerouter/ppq-credit-id
```

Get your credit ID from your PPQ account. If this file doesn't exist, the PPQ panel just shows "disabled."

### Run

```bash
npm start
```

Or as a systemd user service:

```bash
# ~/.config/systemd/user/freerouter.service
[Unit]
Description=HermRouter LLM Proxy

[Service]
Type=simple
WorkingDirectory=/path/to/HermRouter
ExecStart=/usr/bin/node dist/src/server.js
Restart=on-failure
Environment=CLAWROUTER_HOST=127.0.0.1

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now freerouter
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAWROUTER_HOST` | `127.0.0.1` | Bind address (overrides config) |
| `CLAWROUTER_PORT` | `18800` | Listen port (overrides config) |
| `FREEROUTER_CONFIG` | — | Path to config file |

## Using with Hermes

In your Hermes `config.yaml`, add HermRouter as a custom provider:

```yaml
custom_providers:
  - name: hermrouter
    base_url: http://<hermrouter-host>:18800/v1
    model:
      name: auto
      context_length: 1000000
```

Set the model to `auto` — HermRouter handles model selection. The `context_length: 1000000` tells Hermes not to compact conversations early (all configured models support 1M+ context).

## Web Dashboard

Visit `http://<host>:18800/ui` for the web interface with two tabs:

**Config** — view and edit `freerouter.config.json` with live reload.

**Live Stats** — auto-refreshing dashboard showing:
- Request counters (total, errors, timeouts)
- Tier distribution bar chart
- Top routed models
- Recent routing decisions table
- PPQ balance and 24h spend breakdown by model
- Pinchbench scores for all configured models with PPQ pricing

## Architecture

```
Client (OpenAI format)
  │
  ▼
HermRouter (:18800)
  │
  ├─ 14-dimension classifier
  │    scores: code, reasoning, tokens, creativity, structure, ...
  │
  ├─ Tier assignment (SIMPLE / MEDIUM / COMPLEX / REASONING)
  │    with mode override detection
  │
  ├─ Agentic detection (tool_calls → agentic tier config)
  │
  ├─ Vision detection (image content → vision tier)
  │
  ▼
Provider (PPQ / Anthropic / any OpenAI-compatible)
  │
  ├─ Primary model → response
  │    or on failure/timeout:
  └─ Fallback chain → retry with next model
```

## License

MIT — forked from [FreeRouter](https://github.com/openfreerouter/freerouter).
