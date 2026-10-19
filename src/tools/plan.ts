import type { PreviewLine, Todo, TodoStatus, Tool } from "../types.js";
import { reqStr } from "./util.js";

const MARK: Record<TodoStatus, string> = { pending: "☐", in_progress: "◐", completed: "☒" };

export function todoLines(list: Todo[]): PreviewLine[] {
  return list.map((t) => ({ text: `${MARK[t.status]} ${t.content}`, tone: t.status === "completed" ? "dim" : undefined }));
}

export const todoWrite: Tool = {
  name: "todo_write",
  label: "Update Todos",
  description:
    "Plan and track a multi-step task as a todo list the user can see. Send the whole list each time. Keep exactly one item in_progress while working; mark items completed as soon as they are done. Skip it for simple one-step requests.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: 'What to do, e.g. "Fix the date parser"' },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            activeForm: { type: "string", description: 'Shown while in progress, e.g. "Fixing the date parser"' },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  risk: "safe",
  target: () => "",
  activity: () => "Planning",
  summarize(a) {
    const list = (Array.isArray(a.todos) ? a.todos : []) as Todo[];
    const done = list.filter((t) => t.status === "completed").length;
    return { summary: `${done}/${list.length} done`, preview: todoLines(list) };
  },
  async run(args, ctx) {
    const list = (Array.isArray(args.todos) ? args.todos : []) as Todo[];
    if (list.filter((t) => t.status === "in_progress").length > 1) {
      throw new Error("only one todo can be in_progress at a time");
    }
    ctx.todos?.set(list);
    const left = list.filter((t) => t.status !== "completed").length;
    return left ? `Todo list updated: ${left} of ${list.length} left. Keep it current as you work.` : "Todo list updated: everything is done.";
  },
};

export const exitPlanMode: Tool = {
  name: "exit_plan_mode",
  lean: {
    description: "When your plan is ready, present it (files, changes, how to verify) for the user to approve.",
    parameters: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] },
  },
  label: "Plan",
  description:
    "In plan mode, when your plan is ready: present it (markdown: files to change, the changes, how you'll verify them) and ask the user to approve it. If they approve, you can start making the changes.",
  parameters: {
    type: "object",
    properties: { plan: { type: "string" } },
    required: ["plan"],
  },
  risk: "safe",
  modes: ["plan"],
  timeoutMs: 0, // waits for the user
  target: () => "",
  activity: () => "Waiting for plan approval",
  summarize: (_a, output) => ({ summary: output.startsWith("Approved") ? "Approved" : "Keep planning" }),
  async run(args, ctx) {
    const plan = reqStr(args, "plan");
    if (!ctx.confirm || !ctx.setMode) throw new Error("plan approval needs an interactive session");
    const answer = (await ctx.confirm(`Proceed with this plan?\n\n${plan.trim()}\n\ny = edit (ask before changes) · a = auto · n = keep planning`)).trim().toLowerCase();
    if (answer === "y" || answer === "yes" || answer === "a") {
      ctx.setMode(answer === "a" ? "auto" : "edit");
      return `Approved; mode is now ${answer === "a" ? "auto" : "edit"}. Make the changes, then verify them.`;
    }
    return "The user did not approve the plan yet. Ask what they want changed, and revise it.";
  },
};
