import type { AgentDef } from "../agents.js";
import type { Tool } from "../types.js";
import { formatDuration } from "../ui.js";
import { reqStr } from "./util.js";

/** Delegate a task to a sub-agent with a fresh context (see agents.ts). */
export function taskTool(agents: AgentDef[]): Tool {
  const names = agents.map((a) => a.name);
  return {
    name: "task",
    label: "Task",
    description: `Hand a self-contained task to a sub-agent with its own fresh context; you get back only its final report. Use it for broad searches or independent sub-tasks, and give it everything it needs in the prompt. Agents: ${agents.map((a) => `${a.name} (${a.description})`).join("; ")}.`,
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "3-5 words, shown to the user" },
        prompt: { type: "string", description: "The full task, with the context the agent needs" },
        subagent_type: { type: "string", enum: names },
      },
      required: ["description", "prompt"],
    },
    risk: "safe", // the sub-agent's own tool calls are checked one by one
    timeoutMs: 0, // bounded by the sub-agent's own turn and time limits
    target: (a) => `${a.subagent_type ?? "general-purpose"}: ${a.description ?? ""}`,
    activity: (a) => `Delegating: ${a.description ?? "task"}`,
    summarize: (_a, output, ms) => ({
      summary: `Done (${formatDuration(ms)})`,
      preview: output
        .split("\n")
        .filter((l) => l.trim())
        .slice(0, 3)
        .map((text) => ({ text, tone: "dim" as const })),
    }),
    async run(args, ctx) {
      const prompt = reqStr(args, "prompt");
      const type = typeof args.subagent_type === "string" ? args.subagent_type : "general-purpose";
      const def = agents.find((a) => a.name === type);
      if (!def) throw new Error(`unknown subagent_type "${type}"; use one of ${names.join(", ")}`);
      if (!ctx.spawn) throw new Error("sub-agents are not available here");
      return ctx.spawn(def, prompt);
    },
  };
}
