# ngobe

Ngobe is a coding agent for the terminal that runs on local models through any OpenAI-compatible endpoint: Docker Model Runner, llama.cpp, Ollama, vLLM, or a hosted provider you configure. It is sized for small servers (the target is 6 vCPUs and 11 GiB of RAM): ~42 MB to start, ~80 MB for a one-shot run, no extra services.

What it does beyond a plain chat loop:

- **Checks current facts instead of guessing.** Latest versions come from official release metadata (Flutter, Dart, Node.js, Python, PHP, Go, PostgreSQL, npm, PyPI, pub.dev, Packagist, crates.io, GitHub), with the source URL and check time. Release notes, breaking changes, security advisories (OSV.dev) and installed versions are separate tools. Web search (Brave, Tavily or SearXNG) is optional.
- **Edits code safely.** Every tool call is schema-validated; writes stay inside the project; shell commands are risk-classified; destructive, privileged, secret-touching and publishing actions always ask. Files changed behind the agent's back are not overwritten.
- **Reads any file you point it at.** Code and text, and PDF, Word, Excel, PowerPoint, OpenDocument, EPUB, RTF, CSV, notebooks, email, SQLite, archives, images, audio, video and executables, converted to text or described, in milliseconds, locally. A file your message names is read before the model answers, even outside the project (`~/Downloads/report.pdf`); anything else outside the project asks first. With a vision model on the server (`NGOBE_VISION_MODEL`), images are understood too: their text transcribed and their content described. A model that sees images itself (`NGOBE_MODEL_SEES_IMAGES`) is shown them directly, browser screenshots from Playwright included, so it can check a page it built against the design.
- **Builds UI from a screenshot or mockup.** Paste one with ctrl+v (or drop the file into the terminal) and ask to reproduce it: the vision model turns the image into a blueprint (sections, components, exact texts, sizes), the colors are measured from its pixels, and the request comes with design guidance for the project's framework (Flutter widgets, React with Tailwind or CSS modules, Vue, Svelte, Blade, or a single HTML file).
- **Creates projects of any kind when asked.** `create_project` runs the official generator of the framework or language with every question answered by flags (Next.js, Vite React/Vue/Preact/Solid, Astro, SvelteKit, Nuxt, Angular, Express, NestJS, Node, Bun, Deno, Python/uv, FastAPI, Django, Flask, Go, Rust, Swift, Dart, Flutter, Expo, Spring Boot, .NET, Rails, Laravel, Symfony, Elixir), installs the dependencies (TypeScript and Tailwind CSS by default on the web), then works inside the new folder and checks the build. Any other kind gets a folder with git, and the model writes the files. Every new project is built SOLID and YAGNI: only what was asked, one job per file.
- **Knows a project in one call.** `project_overview` gives the stack, commands, folders, dependencies and README; asking it to analyse a project runs that before the model's first turn. File search respects `.gitignore`.
- **Remembers across sessions and projects.** `~/.config/ngobe/NGOBE.md` (yours to read and edit) holds what you asked it to remember, lessons from its mistakes, and per project what it is and what was done. After a crash or a dropped connection, "where did we stop?" or "continue" picks up the unfinished work.
- **Learns from measured outcomes.** A SQLite memory keeps working commands, conventions, run outcomes, tool reliability and recurring failures. Lessons go into NGOBE.md and every later session: a failed tool call that a later call fixed, and every time you correct it ("you didn't give the version"). Prompt changes are benchmarked before they can be promoted, and can be rolled back. No model weights are changed.

## Install

    curl -fsSL https://raw.githubusercontent.com/ngobe-ai/ngobe-cli/main/install.sh | sh   # Linux, macOS
    brew install ngobe-ai/tap/ngobe                                                     # Homebrew
    npm install -g @ngobe-ai/ngobe                                                      # Node 22.13+

The install script and Homebrew give you a standalone binary with the Bun runtime built in: no Node, npm or Bun needed. The script checks the SHA-256 and installs to `~/.local/bin`; set `NGOBE_VERSION=0.3.0` for a specific version or `NGOBE_INSTALL_DIR` for another directory. The npm-registry package is for people who already have Node 22.13+ (`bun add -g @ngobe-ai/ngobe` works too, but it still runs on Node). Update with `ngobe upgrade`, however you installed it (it runs Homebrew or npm for you, or swaps the standalone binary); the chat tells you once a day when a release is out. Windows: use WSL.

From source (Bun):

    git clone https://github.com/ngobe-ai/ngobe-cli && cd ngobe-cli && bun install
    bun run dev                                          # run without building
    bun scripts/build-binaries.ts darwin-arm64           # or linux-x64 …: your own standalone binary in dist-bin/

## Quick start

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
| `ngobe mcp [list\|get\|add\|remove]` | MCP servers (Claude Code's format): `ngobe mcp add playwright -- npx -y @playwright/mcp@latest --headless` gives the agent a browser; see [configuration](docs/configuration.md#mcp-servers) |
| `ngobe doctor`, `ngobe config` | Diagnostics (including whether an update is out); effective configuration (secrets redacted) |
| `ngobe upgrade` (`update`) | Update to the latest release: runs `brew upgrade` or `npm install -g` for you, or swaps the standalone binary (checksum-verified) |

Modes (`--mode`): `ask` and `plan` are read-only; `edit` (default) asks before writes and commands; `auto` runs low-risk writes and commands but still asks for dangerous ones. `--yolo` is now an alias for `auto`.

Existing `MUGAMBA_*` environment variables and the `mugamba` command keep working.

## In the chat

The first time ngobe opens in a folder it asks whether you trust the files there (their `AGENTS.md` and custom agents go into the model's context); trusting a folder covers its subfolders. Type `/` for the command menu:

| Command | What it does |
|---|---|
| `/help` | Commands and keys |
| `/clear` (`/new`) | New conversation: clears the context, the screen and session approvals |
| `/compact [focus]` | Summarize the conversation to free up context |
| `/model [n\|name]` | Pick the model, as in Claude Code: enter switches and saves your default, `s` switches for this session only; or switch by name or number |
| `/mode [ask\|plan\|edit\|auto]` | Show or switch the permission mode (or press shift+tab) |
| `/permissions` | What runs without asking, and what you allowed this session |
| `/agents [new <name>]` (`/subagents`) | Create, edit and delete sub-agents, as in Claude Code (`new <name>` writes a template) |
| `/init` | Write `AGENTS.md`, a guide to the project for the agent |
| `/review [ref]`, `/diff` | Review uncommitted changes; show them |
| `/status`, `/context`, `/cost`, `/todos`, `/tools`, `/memory`, `/config` | Session, context window, usage, task list, tools, memory, settings |
| `/mcp` | MCP servers: status, their tools and what they cost in prompt tokens |
| `/exit` | Quit |

Keys: enter sends, esc interrupts a run, shift+tab cycles the mode, ctrl+v pastes an image from the clipboard (a screenshot) as a file path, ↑/↓ recall history; the mouse wheel, PgUp/PgDn or shift+↑/↓ scroll the conversation while the banner and the prompt stay put. The chat uses the terminal's alternate screen and takes the mouse wheel, so to select text hold Option (macOS) or Shift; `NGOBE_MOUSE=0` leaves the mouse to the terminal.

Memory: say "remember that …" (or "always …", "I prefer …") and it goes into `NGOBE.md`; `/memory` shows what ngobe knows about the folder. In a new session, "where did we stop?" or "continue" brings back the last work in the folder or its project, even if ngobe was cut off mid-run.

Sub-agents take one task in a fresh context and return a single report, so the main conversation stays small. Built in: `general-purpose` and `explore` (read-only). `/agents` works like Claude Code's: **Create new agent** asks where it goes (the project's `.ngobe/agents/` or your `~/.config/ngobe/agents/`), then either generates the name, description and instructions with the current model from a sentence you write, or lets you write them; then its tools (all, groups such as read-only or MCP, or single tools), its model (inherit the conversation's, or another model on your server) and its color. Pick an existing agent to view it, change its tools, model or color, or delete it. Changes apply to the next task, without a restart. The files are Claude Code's format (`name`, `description`, `tools`, `model`, `color` frontmatter; see docs/configuration.md), and Claude Code's `.claude/agents/` files work too. With the default lean tool profile the `task` tool is only offered once you define a custom agent, because every sub-agent re-reads its prompt (slow on a CPU server).

## Documentation

- [docs/architecture.md](docs/architecture.md): components, request flow, design decisions, security model
- [docs/configuration.md](docs/configuration.md): every setting, environment variable and config-file key
- [docs/deployment.md](docs/deployment.md): VPS + Docker Model Runner setup, memory budget, upgrades, backups
- [docs/troubleshooting.md](docs/troubleshooting.md): common failures and fixes
- [docs/status.md](docs/status.md): what is implemented, verified, deferred and unsupported
- [docs/releasing.md](docs/releasing.md): CI, the release pipeline, and the one-time setup it needs
- [config.example.json](config.example.json): example config file (no secrets)

## Development

    bun test                          # unit and integration tests (offline)
    NGOBE_LIVE=1 bun test test/live.test.ts   # also query the real official sources
    bun run typecheck && bun run build
    bun run build:binaries            # standalone binaries for every platform into dist-bin/

Layout: `src/index.ts` (CLI), `src/agent.ts` (loop), `src/llm.ts` (model gateway), `src/permissions.ts`, `src/tools/` (one file per tool family), `src/web/` (HTTP, search, extraction), `src/releases/` (versions, notes, advisories), `src/memory/` (SQLite store), `src/learn.ts`, `src/bench.ts` + `src/benchData.ts` (evaluation set), `src/doctor.ts`, `src/tui/` (chat screen).
