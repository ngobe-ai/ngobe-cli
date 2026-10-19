import type { Args } from "../types.js";

interface Schema {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
}

/**
 * Validate model-supplied arguments against a tool's JSON Schema (the subset the tools
 * here use). Small models often send numbers, booleans and arrays as strings, so those
 * are coerced; anything else that doesn't fit is reported back to the model.
 */
export function validateArgs(schema: Schema, args: Args): { args: Args; errors: string[] } {
  const errors: string[] = [];
  const value = check(schema, args, "", errors);
  return { args: (value ?? {}) as Args, errors };
}

function check(schema: Schema, value: unknown, at: string, errors: string[]): unknown {
  const name = at || "arguments";
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`"${name}" must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
    return value;
  }
  switch (schema.type) {
    case "string":
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      if (typeof value !== "string") errors.push(`"${name}" must be a string`);
      return value;
    case "integer":
    case "number": {
      const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      if (typeof n !== "number" || !Number.isFinite(n) || (schema.type === "integer" && !Number.isInteger(n))) {
        errors.push(`"${name}" must be ${schema.type === "integer" ? "an integer" : "a number"}`);
        return value;
      }
      if (schema.minimum !== undefined && n < schema.minimum) errors.push(`"${name}" must be >= ${schema.minimum}`);
      if (schema.maximum !== undefined && n > schema.maximum) errors.push(`"${name}" must be <= ${schema.maximum}`);
      return n;
    }
    case "boolean":
      if (value === "true" || value === "false") return value === "true";
      if (typeof value !== "boolean") errors.push(`"${name}" must be true or false`);
      return value;
    case "array": {
      let list = value;
      if (typeof list === "string" && list.trim().startsWith("[")) {
        try {
          list = JSON.parse(list);
        } catch {
          // reported below
        }
      }
      if (!Array.isArray(list)) {
        errors.push(`"${name}" must be an array`);
        return value;
      }
      return schema.items ? list.map((item, i) => check(schema.items!, item, `${name}[${i}]`, errors)) : list;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(`"${name}" must be an object`);
        return value;
      }
      const out: Args = {};
      const props = schema.properties ?? {};
      for (const [key, v] of Object.entries(value as Args)) {
        if (v === null || v === undefined) continue; // optional arguments sent as null
        const prop = props[key];
        if (prop) out[key] = check(prop, v, at ? `${at}.${key}` : key, errors);
        else if (schema.additionalProperties === false) errors.push(`unknown argument "${key}"`);
        else out[key] = v;
      }
      for (const key of schema.required ?? []) {
        if (!(key in out)) errors.push(`"${at ? `${at}.${key}` : key}" is required`);
      }
      return out;
    }
    default:
      return value;
  }
}
