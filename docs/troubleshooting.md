# Troubleshooting

Start with `ngobe doctor`; most problems show up there. `--debug` prints every tool decision and timing; the audit log is in `~/.local/state/ngobe/logs/`.

**Model endpoint unreachable.** `doctor` probes the usual Docker Model Runner and Ollama addresses and suggests one that answers. For Model Runner, check `docker model ls`, that host TCP access is enabled, and `curl http://localhost:12434/engines/v1/models`.

**"model not found" / 404.** `NGOBE_MODEL` must match an id from `/v1/models` exactly (Model Runner ids usually look like `ai/<name>`). Set `NGOBE_FALLBACK_MODEL` to try a second model automatically.

**"The endpoint refused native tool calling".** The server rejected the `tools` parameter (llama.cpp needs `--jinja` for native tools). Ngobe switches to the text protocol for the session. To skip the failed first attempt, set `NGOBE_TOOL_MODE=text`.

**The model describes tool calls instead of making them, or loops.** Small models do this. Ngobe parses `<tool_call>` blocks in both JSON and Qwen3-Coder XML form, rejects invalid arguments with an explanation, refuses a third identical call, and stops at `NGOBE_MAX_TURNS` / `NGOBE_MAX_TOOL_CALLS`. If it persists, try `NGOBE_TOOL_MODE=text` or a larger model, and check `ngobe learn` for recurring failures.

**"sent nothing for 300s".** The model took longer than `NGOBE_REQUEST_TIMEOUT` to produce the next chunk, usually prompt processing of a long context on CPU. Raise the timeout or lower `NGOBE_MAX_CONTEXT_CHARS`.

**Answers lose track of earlier work.** The history exceeded `NGOBE_MAX_CONTEXT_CHARS`: old tool output was blanked and older requests were summarized. Make the budget match the model's real context window; if the server's window is smaller than the budget, the server silently truncates the prompt instead.

**"No web search provider is configured".** Set `BRAVE_API_KEY`, `TAVILY_API_KEY` or `NGOBE_SEARXNG_URL`. Version, release-note and advisory tools work without one.

**"GitHub API rate limit reached".** Set `GITHUB_TOKEN` (any token with public read access).

**A version lookup says "can't tell where X is published".** Pass the ecosystem: `ngobe version left-pad --ecosystem npm`, or in chat, name the registry.

**Every action is denied in scripts.** With no terminal there is no one to ask, so actions that need approval are denied. Use `--mode auto` for ordinary writes and commands; dangerous actions always need a person.

**"Memory unavailable".** Memory needs Node 22.13+ (`node:sqlite`) or Bun. Everything else works without it. `NGOBE_MEMORY=0` turns it off explicitly.

**grep is slow.** Install ripgrep; without it a JavaScript fallback is used. Patterns ripgrep can't parse (lookbehind, backreferences) also use the fallback.

**Interrupting.** Ctrl+C cancels the running request (including child processes of shell commands). In the chat, Ctrl+C with text typed clears it; at an empty prompt it quits.
