# Configuration

Settings come from, highest priority first: command-line flags, environment variables (`NGOBE_*`, then the older `MUGAMBA_*` names), the user config file, built-in defaults.

The config file is `$XDG_CONFIG_HOME/ngobe/config.json` (default `~/.config/ngobe/config.json`); see [config.example.json](../config.example.json). There is deliberately no per-project config file: a cloned repository must not be able to redirect the model endpoint or loosen permissions. Secrets (API keys, tokens) are read from the environment only; if the config file contains them they are ignored with a warning.

`ngobe config` prints the effective configuration with secrets redacted.

## Model

| Variable | Config key | Default | Meaning |
|---|---|---|---|
| `NGOBE_BASE_URL` / `--base-url` | `baseURL` | `http://localhost:11434/v1` | OpenAI-compatible endpoint. Docker Model Runner: `http://localhost:12434/engines/v1`; llama.cpp server: `http://localhost:8080/v1` |
| `NGOBE_API_KEY` | (env only) | `not-needed` | Key for hosted providers |
| `NGOBE_MODEL` / `-m` | `model` | `qwen3-coder` | Model id as the endpoint names it (`docker model ls`, `/v1/models`) |
| `NGOBE_FALLBACK_MODEL` | `fallbackModel` | none | Tried once when the main model is missing, unreachable or silent |
| `NGOBE_TEMPERATURE` | `temperature` | `0.2` | Sampling temperature, 0 to 2. Low keeps a small model's tool calls steady (llama.cpp's own default is 0.8); `default` leaves it to the server. Dropped automatically if the server refuses it |
| `NGOBE_WARMUP` | `warmup` | `true` | In the chat, have the server process the fixed prompt prefix (system prompt + tools) while you type: at start, and when you start typing after 2 idle minutes (Docker Model Runner unloads idle models after ~5). Costs one short request; set `false` on a metered API |
| `NGOBE_TOOL_PROFILE` | `toolProfile` | `lean` | `lean`: 12 core tools with one-line descriptions, for small models on a CPU (every definition is re-read on a cold start); `full`: every tool (git, todos, multi-edit, background shells, sub-agents) with full descriptions |
| `NGOBE_TOOL_MODE` | `toolMode` | `auto` | `native` (OpenAI tool calls), `text` (`<tool_call>` protocol in the prompt), `auto` (native, switching to text if the endpoint refuses tools) |
| `NGOBE_REQUEST_TIMEOUT` | `requestTimeout` | `300` | Seconds without a streamed chunk before a request is abandoned. Raise it for big prompts on slow CPUs |
| `NGOBE_MAX_RETRIES` | `maxRetries` | `2` | Retries for connection errors, 429 and 5xx |

A hosted endpoint receives your prompts and code. `ngobe doctor` labels the endpoint local or remote.

### Models on your own server, used from your laptop

Docker Model Runner has no authentication, so it should only listen on the server's localhost. Ngobe can reach it through SSH instead of exposing it:

| Variable | Config key | Meaning |
|---|---|---|
| `NGOBE_SSH_TUNNEL` | `sshTunnel` | `user@host` or `user@host:port` (an `~/.ssh/config` alias works too) |
| `NGOBE_SSH_TUNNEL_TARGET` | `sshTunnelTarget` | The model server as seen from that host; default `127.0.0.1:<baseURL port>` |

With a tunnel, `baseURL` must point at this machine; its port is the local end of the tunnel. Pick one that nothing else uses (Docker Desktop's own Model Runner may already have 12434 on your laptop):

```json
{
  "baseURL": "http://127.0.0.1:12435/engines/v1",
  "sshTunnel": "root@203.0.113.7:30620",
  "sshTunnelTarget": "127.0.0.1:12434",
  "model": "huggingface.co/bartowski/qwen2.5-coder-7b-instruct-gguf:Q4_K_M",
  "requestTimeout": 900
}
```

Ngobe opens `ssh -N -L …` on the first model request, reuses a tunnel that's already up, reopens it if it drops, and closes it when it exits. It uses SSH batch mode: key login only (set it up once with `ssh-copy-id`), no password prompts, and an unknown host key is refused (connect once by hand to accept it). Like the endpoint itself, the tunnel can only be set in your user config or environment, never by a project.

## Agent limits

| Variable | Config key | Default | Meaning |
|---|---|---|---|
| `NGOBE_MODE` / `--mode` | `mode` | `edit` | `ask`, `plan`, `edit`, `auto` (see README) |
| `NGOBE_MAX_TURNS` | `maxTurns` | `40` | Model calls per request |
| `NGOBE_MAX_TOOL_CALLS` | `maxToolCalls` | `100` | Tool calls per request |
| `NGOBE_MAX_RUN_SECONDS` | `maxRunSeconds` | `1800` | Wall-clock limit per request |
| `NGOBE_MAX_CONTEXT_CHARS` | `maxContextChars` | `200000` | History budget before old tool output is blanked and older requests are summarized. Fit it to the model's context window (below) |

Context sizing: each request carries ~2,700 tokens of tool definitions and system prompt. At roughly 4 characters per token, leave that out of the model's context window:

| model context | suggested `NGOBE_MAX_CONTEXT_CHARS` |
|---|---|
| 8k tokens | 16000 |
| 16k | 48000 |
| 32k | 110000 |

## Live information

| Variable | Config key | Meaning |
|---|---|---|
| `NGOBE_SEARCH_PROVIDERS` | `searchProviders` | Ordered list, e.g. `brave,searxng`. Default: every provider whose key/URL is set. The next one is used only when one fails or finds nothing |
| `BRAVE_API_KEY` | (env only) | Brave Search API key |
| `TAVILY_API_KEY` | (env only) | Tavily API key |
| `NGOBE_SEARXNG_URL` | `searxngURL` | Your SearXNG instance (JSON output must be enabled in its settings) |
| `GITHUB_TOKEN` / `GH_TOKEN` | (env only) | Raises the GitHub API limit from 60 to 5,000 requests/hour (release lookups and notes) |
| | `docs` | Extra official documentation domains per technology: `{"filament": ["filamentphp.com"]}` |

Version, release-note and advisory lookups need no keys. Without a search provider, `web_search` is not offered and `search_docs` falls back to the local index of official pages fetched earlier.

## Memory, logs, cache

| Variable | Config key | Default | Meaning |
|---|---|---|---|
| `NGOBE_MEMORY` | `memory` | `1` | `0` turns memory off completely (nothing opened or written) |
| `NGOBE_STATE_DIR` | `stateDir` | `$XDG_STATE_HOME/ngobe` (`~/.local/state/ngobe`) | `ngobe.db` (memory) and `logs/` (JSONL audit log, 14 days) |
| `NGOBE_CACHE_DIR` | `cacheDir` | `$XDG_CACHE_HOME/ngobe` (`~/.cache/ngobe`) | HTTP cache; safe to delete |
| `NGOBE_DEBUG` / `--debug` | `debug` | off | Print each audit event (tool choice, timings) as it happens |

`ngobe memory disable` pauses recording and recall but keeps the data; `ngobe memory clear` deletes it.
