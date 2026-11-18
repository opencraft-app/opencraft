import type { ComposerSavedContent } from "./store";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string";
const optionalString = (value: unknown) => value === undefined || string(value);
const metadata = (value: unknown) => value === undefined || object(value);
const all = (value: unknown, check: (item: unknown) => boolean) => Array.isArray(value) && value.length <= 10000 && value.every(check);

function inline(value: unknown): boolean {
  if (!object(value)) return false;
  switch (value.type) {
    case "text": return string(value.text) && (value.marks === undefined || all(value.marks, mark => mark === "strong" || mark === "emphasis" || mark === "code"));
    case "hard-break": return true;
    case "link": return string(value.href) && all(value.children, child => object(child) && child.type === "text" && inline(child));
    case "mention": return string(value.id) && string(value.label) && ["file", "agent", "thread", "person", "generic"].includes(String(value.mentionKind)) && optionalString(value.uri) && metadata(value.metadata);
    case "command": return string(value.name) && optionalString(value.argument) && optionalString(value.uri) && metadata(value.metadata);
    case "resource": return string(value.id) && string(value.title) && string(value.uri) && optionalString(value.resourceKind) && metadata(value.metadata);
    default: return false;
  }
}
function block(value: unknown, depth = 0): boolean {
  if (!object(value) || depth > 32) return false;
  switch (value.type) {
    case "paragraph": return all(value.children, inline);
    case "code-block": return string(value.text) && optionalString(value.language);
    case "divider": return true;
    case "quote": return all(value.children, child => block(child, depth + 1));
    case "list": return typeof value.ordered === "boolean" && (value.start === undefined || Number.isSafeInteger(value.start)) && all(value.items, item => object(item) && string(item.id) && all(item.children, child => block(child, depth + 1)));
    default: return false;
  }
}
export function isComposerSavedContent(value: unknown): value is ComposerSavedContent {
  return object(value) && object(value.document) && value.document.version === 1 && all(value.document.blocks, item => block(item))
    && all(value.attachments, item => object(item) && string(item.id) && string(item.name) && string(item.mimeType) && typeof item.size === "number" && Number.isFinite(item.size) && item.size >= 0
      && (item.uri === null || string(item.uri)) && ["pending", "uploading", "processing", "ready", "failed"].includes(String(item.lifecycle)) && (item.error === null || string(item.error)) && metadata(item.metadata))
    && all(value.context, item => object(item) && string(item.id) && string(item.title) && ["file", "selection", "image", "mcp", "appshot", "resource", "annotation"].includes(String(item.kind)) && (item.uri === null || string(item.uri)) && typeof item.visible === "boolean" && metadata(item.metadata));
}

