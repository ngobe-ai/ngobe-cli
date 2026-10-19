# ngobe

Ngobe is a coding agent for the terminal that runs on local models through any OpenAI-compatible endpoint: Docker Model Runner, llama.cpp, Ollama, vLLM, or a hosted provider you configure. It is sized for small servers (the target is 6 vCPUs and 11 GiB of RAM): ~42 MB to start, ~80 MB for a one-shot run, no extra services.

What it does beyond a plain chat loop:

- **Checks current facts instead of guessing.** Latest versions come from official release metadata (Flutter, Dart, Node.js, Python, PHP, Go, PostgreSQL, npm, PyPI, pub.dev, Packagist, crates.io, GitHub), with the source URL and check time. Release notes, breaking changes, security advisories (OSV.dev) and installed versions are separate tools. Web search (Brave, Tavily or SearXNG) is optional.
- **Edits code safely.** Every tool call is schema-validated; writes stay inside the project; shell commands are risk-classified; destructive, privileged, secret-touching and publishing actions always ask. Files changed behind the agent's back are not overwritten.
- **Learns from measured outcomes.** A SQLite memory keeps working commands, conventions, run outcomes, tool reliability and recurring failures. Prompt changes are benchmarked before they can be promoted, and can be rolled back. No model weights are changed.

## Quick start

    git clone https://github.com/ngobe-ai/ngobe-cli && cd ngobe-cli/cli
    npm ci && npm run build && npm link        # or: bun install && bun run dev

    # point it at your model (Docker Model Runner shown; see docs/deployment.md)
    export NGOBE_BASE_URL=http://localhost:12434/engines/v1
    export NGOBE_MODEL=ai/qwen2.5-coder        # the id from `docker model ls`

    ngobe doctor                               # endpoint, tool calling, memory, sources
    ngobe                                      # interactive chat
    ngobe fix "the date parser drops time zones"
    ngobe ask "what is the latest stable Flutter version?"

## Commands

| Command | What it does |
|---|---|
| `ngobe` | Interactive chat (edit mode) |
| `ngobe "<task>"`, `ngobe code <task>` | Run the agent once |
| `ngobe ask <question>` | Answer with read-only tools and live sources; never edits |
| `ngobe plan <task>` | Inspect and propose changes without editing |
| `ngobe fix <problem>` | Reproduce, fix minimally, run the relevant tests |
| `ngobe review [ref]` | Review uncommitted changes (or changes since a ref) |
| `ngobe test` | Run the project's real test command (no model) |
| `ngobe version <name> [--ecosystem …]` | Latest release from the official source vs. what is installed (no model) |
| `ngobe search <query>`, `ngobe docs <tech> <query>` | Web / official-docs search (no model) |
| `ngobe memory [list\|show\|export\|delete\|clear\|disable\|enable]` | Inspect and control learned memory |
| `ngobe learn [variants\|add\|propose\|promote\|rollback]` | Outcomes, recurring failures, prompt variants |
| `ngobe benchmark [--variant x] [--task id]` | Run the evaluation set against the configured model |
| `ngobe doctor`, `ngobe config` | Diagnostics; effective configuration (secrets redacted) |

Modes (`--mode`): `ask` and `plan` are read-only; `edit` (default) asks before writes and commands; `auto` runs low-risk writes and commands but still asks for dangerous ones. `--yolo` is now an alias for `auto`.

Existing `MUGAMBA_*` environment variables and the `mugamba` command keep working.

## Documentation

- [docs/architecture.md](docs/architecture.md): components, request flow, design decisions, security model
- [docs/configuration.md](docs/configuration.md): every setting, environment variable and config-file key
- [docs/deployment.md](docs/deployment.md): VPS + Docker Model Runner setup, memory budget, upgrades, backups
- [docs/troubleshooting.md](docs/troubleshooting.md): common failures and fixes
- [docs/status.md](docs/status.md): what is implemented, verified, deferred and unsupported
- [config.example.json](config.example.json): example config file (no secrets)

## Development

    bun test                          # unit and integration tests (offline)
    NGOBE_LIVE=1 bun test test/live.test.ts   # also query the real official sources
    npm run typecheck && npm run build

Layout: `src/index.ts` (CLI), `src/agent.ts` (loop), `src/llm.ts` (model gateway), `src/permissions.ts`, `src/tools/` (one file per tool family), `src/web/` (HTTP, search, extraction), `src/releases/` (versions, notes, advisories), `src/memory/` (SQLite store), `src/learn.ts`, `src/bench.ts` + `bench/` (evaluation set), `src/doctor.ts`, `src/tui/` (chat screen).
