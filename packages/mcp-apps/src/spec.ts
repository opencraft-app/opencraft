import Ajv from "ajv";
import { javascript } from "./javascript";
export type Json = Record<string, unknown>;
export const object = (v: unknown): Json => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Expected an object");
  return v as Json;
};
export const text = (v: unknown, max: number): string => {
  if (typeof v !== "string" || !v.trim() || v.length > max || v.includes("\0"))
    throw new Error("Invalid or oversized text");
  return v.trim();
};
export const appId = (v: unknown): string => {
  const id = text(v, 40);
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(id)) throw new Error("Invalid appId");
  return id;
};
export interface AppTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  outputSchema?: Json;
  readOnlyHint: boolean;
  handler:
    | { kind: "javascript"; source: string }
    | { kind: "static"; structuredContent: unknown }
    | { kind: "echo" };
}
export interface AppSpec {
  appId: string;
  title: string;
  description: string;
  uiHtml: string;
  entryTool: string;
  tools: AppTool[];
}
const ajv = new Ajv({
  strict: true,
  allErrors: false,
  validateFormats: false,
  code: { optimize: false },
  ownProperties: true,
});
const schemaKeys = new Set([
  "type",
  "properties",
  "items",
  "required",
  "additionalProperties",
  "enum",
  "const",
  "description",
  "title",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
]);
export function compileSchema(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value)) > 16384)
    throw new Error("Schema exceeds 16 KiB");
  let nodes = 0;
  const visit = (v: unknown, depth: number): void => {
    const s = object(v);
    if (++nodes > 256 || depth > 10) throw new Error("Schema too complex");
    if (Object.keys(s).some((k) => !schemaKeys.has(k)))
      throw new Error(
        "Unsupported schema keyword (no refs, regex or remote schemas)",
      );
    if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length > 64))
      throw new Error("Schema enum exceeds 64 values");
    if (
      s.properties !== undefined &&
      Object.keys(object(s.properties)).length > 64
    )
      throw new Error("Schema exceeds 64 properties");
    if (s.properties !== undefined)
      for (const sub of Object.values(object(s.properties)))
        visit(sub, depth + 1);
    if (s.items !== undefined) visit(s.items, depth + 1);
    if (typeof s.additionalProperties === "object")
      visit(s.additionalProperties, depth + 1);
  };
  visit(value, 0);
  const validate = ajv.compile(object(value));
  ajv.removeSchema();
  return validate;
}
export function validateSpec(raw: unknown): AppSpec {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 650000)
    throw new Error("spec_json must be serialized JSON, at most 650000 bytes");
  const p = object(JSON.parse(raw));
  const html = text(p.uiHtml, 512000);
  if (
    !/^<!doctype html>/i.test(html) ||
    !/window\.openai/.test(html) ||
    /<script\b[^>]*\bsrc\s*=/i.test(html)
  )
    throw new Error(
      "Use a complete self-contained HTML document with window.openai and no external scripts",
    );
  if (!Array.isArray(p.tools) || p.tools.length < 1 || p.tools.length > 16)
    throw new Error("Declare 1-16 tools");
  const names = new Set<string>();
  const tools: AppTool[] = p.tools.map((raw) => {
    const t = object(raw),
      name = text(t.name, 64),
      h = object(t.handler),
      inputSchema = object(t.inputSchema);
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name) || names.has(name))
      throw new Error("Invalid or duplicate tool name");
    names.add(name);
    if (inputSchema.type !== "object")
      throw new Error("Tool inputSchema must have type object");
    compileSchema(inputSchema);
    if (t.outputSchema !== undefined) {
      if (object(t.outputSchema).type !== "object")
        throw new Error("outputSchema must have type object");
      compileSchema(t.outputSchema);
    }
    const handler: AppTool["handler"] =
      h.kind === "javascript"
        ? { kind: "javascript", source: text(h.source, 64000) }
        : h.kind === "static"
          ? { kind: "static", structuredContent: h.structuredContent ?? null }
          : h.kind === "echo"
            ? { kind: "echo" }
            : (() => {
                throw new Error("Invalid handler kind");
              })();
    if (t.readOnlyHint !== undefined && typeof t.readOnlyHint !== "boolean")
      throw new Error("Invalid readOnlyHint");
    return {
      name,
      title: text(t.title ?? name, 120),
      description: text(t.description, 2000),
      inputSchema,
      ...(t.outputSchema === undefined
        ? {}
        : { outputSchema: object(t.outputSchema) }),
      readOnlyHint: t.readOnlyHint === true,
      handler,
    };
  });
  const entryTool = text(p.entryTool, 64);
  if (!names.has(entryTool))
    throw new Error("entryTool must name a declared tool");
  return {
    appId: appId(p.appId),
    title: text(p.title, 120),
    description: text(p.description, 2000),
    uiHtml: html,
    entryTool,
    tools,
  };
}
export async function validateJavascript(spec: AppSpec) {
  const sources = spec.tools.flatMap((t) =>
    t.handler.kind === "javascript" ? [t.handler.source] : [],
  );
  if (sources.length) await javascript({ compile: true, sources });
}
