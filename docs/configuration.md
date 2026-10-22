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
| `NGOBE_KEEP_WARM_MINUTES` | `keepWarmMinutes` | `30` | While a chat is open and you were active within this many minutes, keep the model loaded and the conversation cached on the server (a one-token request every ~3.5 minutes, before Docker Model Runner's 5-minute unload). After that the server may unload it. `0` turns it off |
| `NGOBE_TEMPERATURE` | `temperature` | `0.2` | Sampling temperature, 0 to 2. Low keeps a small model's tool calls steady (llama.cpp's own default is 0.8); `default` leaves it to the server. Dropped automatically if the server refuses it |
| `NGOBE_WARMUP` | `warmup` | `true` | In the chat, have the server process the fixed prompt prefix (system prompt + tools) while you type: at start, and when you start typing after 2 idle minutes (Docker Model Runner unloads idle models after ~5). Costs one short request; set `false` on a metered API |
| `NGOBE_TOOL_PROFILE` | `toolProfile` | `lean` | `lean`: 12 core tools with one-line descriptions, for small models on a CPU (every definition is re-read on a cold start); `full`: every tool (git, todos, multi-edit, background shells, sub-agents) with full descriptions |
| `NGOBE_TOOL_MODE` | `toolMode` | `auto` | `native` (OpenAI tool calls), `text` (`<tool_call>` protocol in the prompt), `auto` (native, switching to text if the endpoint refuses tools) |
| `NGOBE_REQUEST_TIMEOUT` | `requestTimeout` | `300` | Seconds without a streamed chunk before a request is abandoned. Raise it for big prompts on slow CPUs |
| `NGOBE_MAX_RETRIES` | `maxRetries` | `2` | Retries for connection errors, 429 and 5xx |
| `NGOBE_MODEL_SEES_IMAGES` | `modelSeesImages` | `false` | The model takes images itself (a multimodal model). Images from `read_file` (a design, a screenshot you pasted) and from MCP tools (Playwright's `browser_take_screenshot`) are shown to it, in a message right after the tool results, instead of being described by `visionModel`. The newest 4 stay in the conversation; older ones are replaced by a note (the tool can show them again) |
| `NGOBE_SMALL_MODEL_HELPERS` | `smallModelHelpers` | `true` | Fixes for small local models' habits: running the commands of a plan it only wrote out, saving files it only showed, tool calls written as text or in code blocks, nudges when it stalls or describes a change instead of making it. Set `false` for a strong model: they mean what they write, and a command shown as an example must not run. The text tool protocol (`toolMode: text`) keeps working |
| `NGOBE_MAX_REPLY_TOKENS` | `maxReplyTokens` | `4096` | Longest reply, in tokens. Bounds a runaway reply on a CPU; thinking models spend part of it reasoning, so give them more (16000–32000) |

A hosted endpoint receives your prompts and code. `ngobe doctor` labels the endpoint local or remote.

### A strong hosted model

The defaults suit a small model on a CPU. For a strong hosted model (for example GLM-5.3-Flash, `z-ai/glm-5.3-flash` on NVIDIA's API at `https://integrate.api.nvidia.com/v1`, with the key in `NGOBE_API_KEY`), turn the small-model limits off:

```json
{
  "baseURL": "https://integrate.api.nvidia.com/v1",
  "model": "z-ai/glm-5.3-flash",
  "modelSeesImages": true,
  "smallModelHelpers": false,
  "maxReplyTokens": 16000,
  "maxContextChars": 400000,
  "toolProfile": "full",
  "temperature": "default",
  "keepWarmMinutes": 0,
  "warmup": false
}
```

`modelSeesImages` only if the model reads images. `keepWarmMinutes: 0` and `warmup: false` stop requests that only keep a local server's cache warm; on a hosted API they spend your rate limit. With the Playwright MCP server (below) and `modelSeesImages`, a UI built from an image is checked against a screenshot of the result.

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
| `NGOBE_MAX_RUN_SECONDS` | `maxRunSeconds` | `1800` | Wall-clock limit per request. A 7B on a CPU writes ~3–5 tokens/s, so building a whole page or project can take hours: raise it (e.g. `14400`) for big builds. When a limit stops a run, "continue" picks up where it stopped |
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
| `NGOBE_SEARXNG_KEY` | (environment only) | Sent as `Authorization: Bearer …` when SearXNG sits behind an authenticating gateway (see deployment.md) |
| `GITHUB_TOKEN` / `GH_TOKEN` | (env only) | Raises the GitHub API limit from 60 to 5,000 requests/hour (release lookups and notes) |
| | `docs` | Extra official documentation domains per technology: `{"filament": ["filamentphp.com"]}` |

Version, release-note and advisory lookups need no keys. Without a search provider, `web_search` is not offered and `search_docs` falls back to the local index of official pages fetched earlier.

## MCP servers

MCP servers give the agent more tools: a browser to test a web page with, a database, an issue tracker, docs. Ngobe reads them in Claude Code's format, so a project's `.mcp.json` works in both:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx", "args": ["-y", "@playwright/mcp@latest", "--headless"],
      "tools": ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_take_screenshot", "browser_console_messages"]
    },
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "github": { "command": "github-mcp-server", "args": ["stdio"], "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" } },
    "docs": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } }
  }
}
```

- **Where**: `mcpServers` in `~/.config/ngobe/config.json` (yours, every folder), and `.mcp.json` at the project root (the project's; it wins over yours for the same name). A `.mcp.json` can start any program, so it is used only in a folder you trust (the first-run question in the chat); one-shot runs in an untrusted folder skip it with a warning.
- **Add one**: `ngobe mcp add playwright -- npx -y @playwright/mcp@latest --headless`, `ngobe mcp add -t http -H "Authorization: Bearer \${DOCS_TOKEN}" docs https://example.com/mcp`, `-s project` to write `.mcp.json`, `-e KEY=value` for a stdio server's environment. Put `--` before the command so its flags aren't read as ngobe's. `ngobe mcp list` checks each server, `ngobe mcp get <name>` lists its tools, `ngobe mcp remove <name>` deletes it. New sessions pick changes up; `/mcp` shows the session's servers.
- **Transports**: `stdio` (default when there is a `command`), `http` (Streamable HTTP; default when there is a `url`), `sse` (the deprecated 2024-11-05 HTTP+SSE). An `http` server that turns out to be an old HTTP+SSE one is found by falling back.
- **Variables**: `${VAR}` and `${VAR:-default}` in `command`, `args`, `env`, `cwd`, `url` and `headers` come from ngobe's environment. A server whose variable isn't set is reported and not started. Programs ngobe starts don't inherit its own credentials (`NGOBE_API_KEY`, `GITHUB_TOKEN`…), so pass what a server needs through its `env`, as with `GITHUB_TOKEN` above. Prefer variables to literal tokens in these files; `ngobe config` and `ngobe mcp get` hide `env` values and credential headers.
- **Ngobe's extra keys**: `tools: ["browser_navigate", "browser_snapshot"]` offers only those tools; `autoApprove: ["browser_snapshot"]` (or `["*"]`) runs those without asking; `timeout` (startup) and `toolTimeout` (one call) in seconds (numbers over 1000 are milliseconds, like Claude Code's `MCP_TIMEOUT`); `disabled: true`.
- **Approval**: a tool the server marks read-only (`readOnlyHint`) runs without asking and is offered in ask and plan modes too; one marked destructive asks every time, in every mode; everything else asks in edit mode and runs in auto mode, and "a" (always) covers it for the session. These marks are the server's own claims: add only servers you trust.
- **Cost on a CPU model**: each tool definition is part of every request and re-read on a cold start (~15–25 tokens/s on the VPS). `ngobe mcp list` shows about how many prompt tokens each server adds. Measured with the lean profile (2026-10-21): Playwright MCP's 25 tools ~3,300 tokens (2–4 minutes of a cold start on the VPS), the six in the example above ~940; server-everything's 22 tools ~1,800. Keep it small with `tools`.

| Variable | Config key | Default | Meaning |
|---|---|---|---|
| `NGOBE_MCP` | `mcp` | `1` | `0` starts no MCP servers |
| `NGOBE_MCP_TIMEOUT` | `mcpTimeout` | `30` | Seconds a server has to start and answer (the first `npx` run downloads the package) |
| `NGOBE_MCP_TOOL_TIMEOUT` | `mcpToolTimeout` | `120` | Seconds one tool call may take |

Not supported yet: MCP's OAuth sign-in (servers that need it fail with HTTP 401; put a token in `headers` instead), resources and prompts (tools only), sampling, elicitation and roots (ngobe declares none of these, so servers don't ask for them), and tool-list changes during a session (seen at the next start).

## Sub-agents

`/agents` creates and edits these files for you; you can also write them by hand. One markdown file per agent, in `.ngobe/agents/` (this project), `~/.config/ngobe/agents/` (every project) or `.claude/agents/` (Claude Code's, read as they are). A project file wins over a personal one of the same name.

```markdown
---
name: test-runner
description: Runs the tests after code changes and explains failures
tools: bash, read_file, grep
model: inherit
color: green
---

You run the project's tests, read the failing code, and report each failure with file:line and its likely cause.
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Lowercase letters, digits and dashes; the `subagent_type` the main agent passes to `task` |
| `description` | yes | When the main agent should hand it work |
| `tools` | no | Comma-separated (or a YAML list); Claude Code's names (`Read`, `Bash`, …) are mapped to ngobe's. Left out: every tool the main agent has, except `task` |
| `model` | no | `inherit` (the default) or a model id on your server (`/model` lists them). Claude Code's `sonnet`, `opus`, `haiku`, `fable` and `claude-*` ids mean inherit, since your server doesn't serve them |
| `color` | no | `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink` or `cyan`: its tool calls are shown in it |

Other Claude Code fields (`permissionMode`, `skills`, `hooks`, …) are ignored, and kept when `/agents` edits the file. The body is the agent's instructions.

## Memory, logs, cache

| Variable | Config key | Default | Meaning |
|---|---|---|---|
| `NGOBE_MEMORY` | `memory` | `1` | `0` turns memory off completely (nothing opened or written, NGOBE.md included) |
| `NGOBE_MEMORY_FILE` | (environment only) | `<config dir>/NGOBE.md` | Ngobe's global memory: about you, lessons, and what was done in each project. Plain markdown; edit it freely |
| `NGOBE_VISION_MODEL` | `visionModel` | (none) | A vision model on the same server (e.g. `docker.io/ngobe/qwen3-vl-2b:6k`). `read_file` on an image sends it there and gives the coding model the transcribed text and a description. Without one, images get OCR when tesseract is installed. Not used when `modelSeesImages` is on (the model sees the image itself) |
| `NGOBE_MOUSE` | `mouse` | `1` | The chat takes the mouse wheel to scroll the conversation. `0` leaves the mouse to the terminal (native selection; scroll with PgUp/PgDn) |
| `NGOBE_STATE_DIR` | `stateDir` | `$XDG_STATE_HOME/ngobe` (`~/.local/state/ngobe`) | `ngobe.db` (memory) and `logs/` (JSONL audit log, 14 days) |
| `NGOBE_CACHE_DIR` | `cacheDir` | `$XDG_CACHE_HOME/ngobe` (`~/.cache/ngobe`) | HTTP cache; safe to delete |
| `NGOBE_DEBUG` / `--debug` | `debug` | off | Print each audit event (tool choice, timings) as it happens |

`ngobe memory disable` pauses recording and recall but keeps the data; `ngobe memory clear` deletes it.
