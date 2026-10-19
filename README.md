# mugamba

Mugamba is a minimal coding agent for any OpenAI-compatible endpoint.

## Run

    bun install
    # local Ollama (default): ollama pull qwen3-coder
    bun run dev
    # hosted provider
    MUGAMBA_BASE_URL=https://<provider>/v1 MUGAMBA_API_KEY=... MUGAMBA_MODEL=<model> bun run dev
    # one-shot
    bun run dev -- "add a unit test for parseConfig"

## Layout

    src/index.ts        entry: args, REPL, Ctrl+C handling
    src/config.ts       env + flags
    src/llm.ts          streaming client, reassembles tool-call fragments
    src/agent.ts        the loop: model -> tools -> model
    src/permissions.ts  confirm writes/shell, auto-allow safe commands
    src/context.ts      system prompt, AGENTS.md, output truncation, history trimming
    src/ui.ts           all terminal I/O (swap for ink/TUI later)
    src/tools/          one file per tool; register in tools/index.ts

## Known gaps (build next)

1. Diff preview before edits; git checkpoint before a run
2. Real context compaction (LLM summary) instead of blanking old tool output
3. Retry when a small model returns malformed tool-call JSON
4. Symlink-aware path checks; ripgrep-backed grep
5. Session save/resume, slash commands, sub-agents, MCP
