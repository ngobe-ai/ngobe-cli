import type { Config } from "../config.js";
import type { Tool } from "../types.js";
import { bash } from "./bash.js";
import { editFile } from "./editFile.js";
import { gitTools } from "./git.js";
import { glob } from "./glob.js";
import { grep } from "./grep.js";
import { infoTools, webSearchTool } from "./info.js";
import { remember } from "./memory.js";
import { readFile } from "./readFile.js";
import { writeFile } from "./writeFile.js";

// Add a tool = write one file exporting a Tool, then list it here.
export const coreTools: Tool[] = [readFile, editFile, writeFile, glob, grep, bash, ...gitTools, ...infoTools];

/** Every tool available with this configuration: web_search needs a provider, remember needs memory. */
export function buildTools(config: Config, opts: { memory: boolean }): Tool[] {
  return [...coreTools, ...(config.searchProviders.length ? [webSearchTool] : []), ...(opts.memory ? [remember] : [])];
}
