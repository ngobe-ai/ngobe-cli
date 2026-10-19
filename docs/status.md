# Status

What exists, how it was verified, and what is not done. "Verified" means by the automated tests (`bun test`, offline) unless it says live; live checks use `NGOBE_LIVE=1 bun test test/live.test.ts` against the real official endpoints.

## Implemented

| Area | What | Verified |
|---|---|---|
| Model gateway | Streaming, SDK retries, idle timeout, fallback model, native and text tool calls (JSON and Qwen3-Coder XML), automatic switch when tools are refused, usage or estimated tokens, `models()`/`probe()` | Tests against a scripted OpenAI-compatible server. Not yet run against Docker Model Runner or a real Qwen model |
| Agent loop | Modes, schema validation with coercion, repeat detection, turn / tool-call / wall-time limits, parallel read-only calls, per-tool timeouts, cancellation, LLM summarization when trimming isn't enough, freshness hint | Tests |
| Permissions | Mode filtering, approval levels, shell risk classifier, secret-file rules, no "always" for shell | Tests, including the bypasses fixed earlier |
| Files and git | Workspace confinement including symbolic links, CRLF-aware edits, changed-on-disk detection, no blind overwrite, ripgrep grep with secret skipping, git status/diff/log/branch/commit with ref and path validation, secret files left out of diffs, `.git/` writes need explicit approval | Tests |
| Live knowledge | Latest version from 13 official sources, installed versions, compare, release notes and breaking changes, OSV advisories, web search (Brave, Tavily, SearXNG) with failover and official ranking, `fetch_url` with private-network guard, offline docs index | Tests with canned responses; all 13 resolvers, release notes and advisories also checked live on 2026-10-19 |
| Memory | SQLite store (bun:sqlite / node:sqlite), provenance, confidence, expiry, credential refusal, inspect/export/delete/clear/disable | Tests |
| Learning | Run outcomes, tool reliability, failure clustering, learned test/build commands, source preference, prompt variants with benchmark-gated promotion and rollback | Tests; benchmark pipeline exercised end to end with a scripted model |
| Evaluation | 12 tasks covering the ten scenarios in the spec, deterministic checks, must-pass safety tasks | Pipeline only. No real model has been scored yet |
| Diagnostics | `ngobe doctor`, audit log with redaction, `--debug` | Run manually against a scripted model |
| CLI | `ask plan code fix review test search docs version memory learn benchmark doctor config`, back-compat with `mugamba` and `MUGAMBA_*` | Tests and manual runs |

## Security review

An independent review of this branch (2026-10-19) reported 12 issues plus minor ones: SSRF via IPv6 spellings and registry changelog URLs, ways to hide dangerous shell commands (newlines, `then`, `bash -c`, `/bin/rm`, `git -C … push`), symlink escapes, `.git/` hook/config writes, memory poisoning reaching `ngobe test`, secret-gate gaps, unredacted failure samples and broken audit JSON, repeat detection blocking the edit→test loop, memory errors leaving dangling tool calls, a learned-command lookup bug, and lost output tails. Each was reproduced, covered by a test in `test/hardening.test.ts`, and fixed.

## Not verified yet

- On the target VPS: resource use with the real model, latencies, and benchmark scores. Run `ngobe doctor` and `ngobe benchmark` there.
- With a real Qwen model through Docker Model Runner: tool-call reliability and which tool mode it ends up in.
- Brave and Tavily against their real APIs (no keys were available); SearXNG only against a local stand-in.

## Deferred

- **Semantic (embedding) search** over code and docs. Lexical search (ripgrep, SQLite FTS5) is the default; an always-on embedding model doesn't fit next to a coding model in 11 GiB.
- **Syntax-aware code index** (symbols, references, call graph) and incremental indexing. `grep`/`glob` plus the model are used instead.
- **Diff preview before edits** and an automatic git checkpoint before a run.
- **Session save/resume**, slash commands beyond `/clear /help /exit`, sub-agents, MCP.
- **Dedicated test/lint/format tools**: the detected commands are given to the model and run through `bash`.
- **Breaking-change detection beyond keywords** in release notes.
- **Automatic prompt optimization loops**: `learn propose` makes one candidate per call; a person runs the benchmark and promotes.

## Not supported, by design

- An "unsafe" mode that skips all confirmations. `--yolo` now means `auto`, which still asks for dangerous actions.
- Per-project config files (a repository can't change the endpoint or permissions).
- Pushing to remotes, force operations, or deleting branches through tools.
- Scraping behind logins or ignoring robots/rate limits; `fetch_url` never reaches private networks.

## Local model adaptation (design only, off)

No weights are trained or changed. If adaptation is attempted later, the intended path is: export curated examples from successful, test-verified runs (`ngobe memory export` has the raw material); review and redact them; train a LoRA adapter on a machine with a GPU, not the 11 GiB VPS; evaluate it with `ngobe benchmark` against a held-out task set and the current model; serve it only after explicit approval, keeping the base model as the fallback.
