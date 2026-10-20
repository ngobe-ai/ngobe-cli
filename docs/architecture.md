# Architecture

Ngobe is one Node.js/Bun process with no background services. Everything below runs in the CLI process; the only other process is the model server you already run.

```
 CLI (index.ts, commands.ts) ──► session.ts ──► Agent (agent.ts)
                                                 │  loop: model → validate → permission → tools → model
              ┌──────────────────────────────────┼───────────────────────────────┐
              ▼                                  ▼                               ▼
   Model gateway (llm.ts)              Tools (tools/*)                   Memory (memory/*)
   OpenAI-compatible streaming         schema-validated, timed,          SQLite: facts, runs,
   native or text tool calls           risk-classified                   failures, docs index,
   retries, idle timeout, fallback     ├─ files, grep, glob, git         prompt variants
                                       ├─ bash (process groups)
                                       └─ live knowledge (releases/*, web/*)
```

## Request flow

1. `index.ts` parses the command and options (`config.ts`), picks the UI (full-screen chat when interactive, plain lines otherwise; the chat UI is only loaded when used), and builds a session.
2. `session.ts` detects the project's stack and real commands (`project.ts`), loads `AGENTS.md`, recalls memory notes and recurring failures for this project, applies the promoted prompt variant, and builds the system prompt (`context.ts`).
3. `Agent.run` sends the conversation and the tools allowed in the current mode to the model gateway. Requests that mention versions, releases, advisories or deprecations get a freshness hint.
4. Each returned tool call is parsed, validated against the tool's JSON Schema (with the coercions small models need), checked for repeats, and passed through `Permissions`. Read-only calls in one turn run in parallel (4 at a time); anything that needs approval runs in order.
5. Tools run under a time limit with an abort signal; output is truncated head+tail; errors go back to the model as text so it can correct itself.
6. The loop ends when the model answers without tool calls, or at a limit (turns, tool calls, wall time). Cancellation (Ctrl+C) stops the current tool, answers every pending tool call, and returns.
7. The run is recorded: outcome, timings (model vs tool), tokens (reported or estimated), test results, tool events, failures.

## Model gateway (`llm.ts`, `toolProtocol.ts`)

- Speaks `/v1/chat/completions` with streaming. Retries connection errors, 429 and 5xx through the SDK (`NGOBE_MAX_RETRIES`).
- Abandons a request after `NGOBE_REQUEST_TIMEOUT` seconds without a streamed chunk (an idle timeout, so long CPU generations are not cut off).
- Tool calling: native by default. If the endpoint rejects the `tools` parameter (llama.cpp without `--jinja`, models without tool templates), it switches to a text protocol: tools are described in the system prompt and the model writes `<tool_call>` blocks. Both the JSON form and Qwen3-Coder's XML form are parsed; tool-call markup is hidden from the streamed text. Parsed calls go through exactly the same validation as native ones, and a malformed block is reported back, never executed.
- Models without a tool template (Qwen2.5-Coder) write calls as JSON in prose: in a code fence of any language, in `<function>` tags, or on a line of their own. Those are accepted when the name is a tool on offer; the text from the call on (often made-up results) is dropped, and fences are held back while streaming so the JSON never reaches the screen.
- The system prompt and tool list are byte-identical between requests, sessions and folders, so llama.cpp reuses its cache of them instead of re-reading thousands of tokens. Everything particular to a session (folder, project, commands, date, starting mode, notes, AGENTS.md) comes after them, once, as a user message answered "Understood." (`buildSessionContext`). A later mode change is appended to the next message not yet sent (`modeNote`), and the freshness hint rides on the user message, so what was already sent never changes. The chat warms the cache up (`warm()`: the same request, one token) when it opens and when you start typing after a break.
- Small-model habits handled in the loop: a command handed to the user in a shell block ("run this and paste the output") becomes a `bash` call, with the usual permission check; a short reply that only announces an action ("Checking the tests.", "… Let's locate the code and fix it.") gets up to two nudges per stall to make the call instead of ending the run; "let's run the tests again" runs the test command used before (or the project's); and a request for a change that ends with nothing changed gets one nudge to make the change rather than show it.
- Falls back to `NGOBE_FALLBACK_MODEL` once when the main model is missing, unreachable or silent.
- Token usage comes from the server when it reports it, otherwise ~4 characters/token estimates (marked as estimated).
- `models()` and `probe()` back `ngobe doctor` (served models, latency, whether tool calls are native, text, or unsupported).

## Tools (`tools/`)

Every tool declares a JSON Schema, a risk category (`safe`, `network`, `write`, `exec`) that decides which modes it is offered in, an optional per-call approval level (`needs`), a time limit, and how it shows in the chat (a label like `Read`, a target, a live activity such as "Running tests", and a one-line result summary with an optional preview, e.g. a red/green diff).

Profiles (`toolProfile`): **lean** (default) offers `read_file`, `edit_file`, `write_file`, `glob`, `grep`, `bash`, `git_status`, `git_diff` (ask and plan modes have no shell), `check_latest_version`, `get_release_notes`, `search_security_advisories`, `fetch_url`, plus `web_search` when a provider is configured and `exit_plan_mode` in plan mode, each with a one-line description; **full** adds `multi_edit`, `bash_output`/`kill_shell` (background commands), `todo_write`, the other git tools, `check_installed_version`, `compare_versions`, `search_docs`, `remember` and `task` (sub-agents), with full descriptions. Tool results and the default page sizes of `read_file` and `grep` scale with `maxContextChars`.

Claude Code conventions: files are read before they are edited or overwritten (and edits refuse a file changed on disk since), `edit_file` replaces one exact match (or all with `replace_all`) and returns the edited lines numbered, `read_file` numbers lines like `cat -n`, and a declined action ends the run and hands the turn back to the user.

Deliberate omissions: no `apply_patch` (exact-match `edit_file` is more reliable for small models), no separate `run_tests`/`run_linter` tools (the project's detected commands are in the system prompt and run through `bash`, which records test outcomes), no `git_push`.

## Live knowledge (`releases/`, `web/`)

- `releases/versions.ts`: one resolver per official source; distinguishes stable from beta/dev/pre-release channels; returns version, date, channel, source URL and fetch time. Unknown names must be given an ecosystem rather than guessed.
- `releases/installed.ts`: versions on PATH (fixed commands, no shell) and in the project (node_modules, pubspec.lock, FVM pins, composer.lock, pip).
- `releases/notes.ts`: GitHub releases → repository CHANGELOG → changelog page linked from the registry, or the official docs page for language runtimes; `since` lists every release after a version with lines that mention breaking changes, removals or deprecations.
- `releases/advisories.ts`: OSV.dev (aggregates GitHub advisories, PyPA, Go, RustSec and others).
- `web/http.ts`: timeouts, size limits, retries with backoff (Retry-After honored), disk cache revalidated with ETag/Last-Modified. A cached answer keeps its original fetch time, so "checked" is never newer than the data.
- `web/search.ts`: Brave, Tavily, SearXNG; tried in order only when one fails or finds nothing; official domains rank first; results cached an hour.
- `web/net.ts`: `fetch_url` only fetches public http(s) hosts, re-checking every redirect hop; loopback, private, link-local (cloud metadata) and similar ranges are refused.
- Official pages fetched with `fetch_url` are indexed in SQLite FTS5 so `search_docs` still works offline, labeled with their fetch time.

## Chat UI (`tui/`, `lineUi.ts`)

The ink screen has an animated banner (`tui/logo.ts`: the letters build up, then a light sweeps across every few seconds, continuously while working; a one-line banner on small terminals), a scrollable transcript (tool calls as `⏺ Label(target)` / `⎿ summary` rows updated in place, replies rendered as markdown), a status line (`✻ Running tests… (34s · 2.8k tokens · esc to interrupt)`), the todo list, and the input with a `/` command menu (`slash.ts`). One clock (`tui/clock.ts`) drives every animation and only ticks while something moves. One-shot runs print the same tool rows and a spinner line in the terminal, and plain text when piped.

Folder trust (`trust.ts`) is asked once per folder, before the project's files are loaded.

## Permissions (`permissions.ts`)

| | ask / plan | edit | auto |
|---|---|---|---|
| read, search, version tools | run | run | run |
| plain read-only shell (`ls`, `cat file`, `git diff` …) | not offered | run | run |
| file writes, ordinary commands | not offered | ask ("always" covers the tool, or for commands the program + subcommand, e.g. `npm test`) | run |
| dangerous: delete, sudo, git push/commit/reset, installs, migrations, deploys, secrets, writes outside the project | not offered | ask every time | ask every time |
| fetch of a non-official site | ask | ask | ask |
| `remember` (memory writes) | not offered | ask (can be "always") | run |

Without a terminal, every "ask" is a deny. The shell classifier is a heuristic, not a sandbox: run `auto` mode in a container or a disposable checkout.

## Memory and learning (`memory/`, `learn.ts`, `bench.ts`)

- Facts carry project scope, provenance (`agent`, `observed`, `user`), confidence, timestamps and expiry (version facts: 7 days). Repetition raises confidence; failure lowers it. Values that look like credentials are refused. No source files or conversations are stored.
- Outcomes: every run records duration split into model and tool time, tokens, tool calls/errors and whether tests passed. Successful test/build commands are learned automatically.
- Recurring failures are clustered without labels: error text is normalized (paths, numbers, quoted values, hashes) and grouped by token similarity. Clusters seen 3+ times in a project are shown to the model as warnings, and in `ngobe learn` and `doctor`. A cluster is a pattern, not a proven cause.
- Retrieval signals: search results the agent goes on to fetch raise that source's standing.
- Prompt variants replace only the "How to work" section. Mode rules, freshness rules, trust rules and all permission checks are fixed in code. `ngobe learn propose` asks the model for a candidate; `ngobe benchmark --variant x` scores it; `ngobe learn promote x` requires results with the current model, every must-pass (safety) task passed, and a score at least that of the prompt in use; `ngobe learn rollback` restores the previous one.
- The benchmark (`src/benchData.ts`: tasks and fixture projects, carried inside the binaries too) checks answers deterministically: expected versions are fetched from official metadata at evaluation time, repo tasks must make the real test command pass without editing protected tests, injection tasks fail on any attempted unsafe action (even a blocked one).

## Security model

- Untrusted inputs: model output, tool arguments, file contents, web pages, search results, memory notes. Tool output is never parsed for tool calls; the system prompt tells the model that tool output is data; web content is labeled untrusted.
- Workspace: file tools resolve paths inside the project after following symbolic links (a cloned repo's `notes.txt -> ~/.ssh/id_rsa` is refused, as is an innocent name linking to a secret file); glob and grep don't descend into linked directories; git refs and paths are validated (no option injection). Writes under `.git/` need explicit approval, and read-only git commands run with `core.fsmonitor` off.
- Secrets: `.env*` (except templates, any letter case), keys, `.netrc`, `.npmrc`, SSH and cloud credential paths need explicit approval to read or write, are skipped by grep, left out of `git_diff`, and make any shell command that names them "dangerous", as does expanding a variable named like `*TOKEN*`/`*KEY*`. Shell commands don't inherit Ngobe's own credentials (`NGOBE_API_KEY`, `BRAVE_API_KEY`, `TAVILY_API_KEY`, `GITHUB_TOKEN`). API keys come from the environment only; the config file can't hold them. Logs and memory are redacted field by field.
- Network: `fetch_url` and changelog URLs taken from registry metadata go through the same guard (public addresses only, in any IPv4/IPv6 spelling, every redirect re-checked); an auto-approved official URL can't redirect to another site.
- Memory the model writes (`remember`) is a write-level action, shown to later sessions as notes from the agent; `ngobe test` only runs remembered commands learned from passing runs, and asks first.
- Approval prompts strip terminal escape sequences and show control characters, so a command can't hide part of itself.
- The model endpoint and permissions come only from flags, the environment, or the user's config file; nothing in a project directory can change them.

## Performance (measured on an 8-core Mac, Node 22)

| | before (mugamba 0.1) | now |
|---|---|---|
| `--help` | 0.37 s, 97 MB | 0.08 s, 42 MB |
| one-shot run, 2 model calls | 0.93 s, 99 MB | ~0.45 s, ~77 MB (plus a tool call and memory) |
| interactive chat process | not measured | ~110 MB |

Fixed prompt overhead per request (system prompt + tool definitions), counted by the server's tokenizer for Qwen2.5-Coder 7B on a 6-vCPU VPS (Docker Model Runner, CPU only), 2026-10-20:

| tool profile | tools | prompt tokens | first answer from a cold cache |
|---|---|---|---|
| lean (default) | 10 | 1,370 | 68 s |
| full | 25 | 4,097 | 240 s |

The prefix is byte-identical across requests, so llama.cpp's prompt cache reuses it and later turns only process what's new. Opening the chat, measured on the same VPS with the model kept loaded (startup warm-up, 2026-10-20):

| | ready after |
|---|---|
| first session after the model loads | 68.5 s |
| another folder | 3.2 s |
| back to the first folder | 5.1 s |

Before the session context moved out of the system prompt, every new folder, day or mode cost the full ~68 s. Model latency dominates on CPU; measure it on the target with `ngobe doctor` and `ngobe benchmark`.
