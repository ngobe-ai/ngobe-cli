import type { Tool } from "../types.js";
import { bash } from "./bash.js";
import { editFile } from "./editFile.js";
import { glob } from "./glob.js";
import { grep } from "./grep.js";
import { readFile } from "./readFile.js";
import { writeFile } from "./writeFile.js";

// Add a tool = write one file exporting a Tool, then list it here.
export const tools: Tool[] = [readFile, editFile, writeFile, glob, grep, bash];
