import type { CapabilityResult } from "./index.js";

export type CapabilityMcpContent =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const maxCharacters = 24 * 1024 * 1024;
const maxItems = 256;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid capability content");
  return value as Record<string, unknown>;
}

function image(mimeType: unknown, data: unknown): { type: "image"; mimeType: string; data: string } {
  if (typeof mimeType !== "string" || !imageTypes.has(mimeType) || typeof data !== "string"
    || !data.length || data.length > maxCharacters || data.length % 4 !== 0
    || /[^A-Za-z0-9+/]/u.test(data.replace(/={1,2}$/u, "")))
    throw new Error("Capability images require inline supported image bytes");
  return { type: "image", mimeType, data };
}

function mapContent<T>(value: unknown, convert: (item: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error("Invalid capability content list");
  let characters = 0;
  return value.map(item => {
    const entry = record(item);
    characters += [entry.text, entry.data, entry.imageUrl].reduce<number>((sum, field) => sum + (typeof field === "string" ? field.length : 0), 0);
    if (characters > maxCharacters) throw new Error("Capability content is too large");
    return convert(entry);
  });
}

/** Wire conversion only. No URL fetching, resource expansion or authority. */
export function capabilityResultToMcp(value: unknown): { content: CapabilityMcpContent[]; isError: boolean } {
  const result = record(value);
  if (typeof result.success !== "boolean") throw new Error("Invalid capability result");
  return { isError: !result.success, content: mapContent(result.contentItems, item => {
    if (item.type === "inputText" && typeof item.text === "string") return { type: "text", text: item.text };
    if (item.type === "inputImage" && typeof item.imageUrl === "string") {
      const match = /^data:([^;,]+);base64,(.*)$/u.exec(item.imageUrl);
      return image(match?.[1], match?.[2]);
    }
    throw new Error("Unsupported capability content");
  }) };
}

export function capabilityResultFromMcp(value: unknown): CapabilityResult {
  const result = record(value);
  if (result.isError !== undefined && typeof result.isError !== "boolean") throw new Error("Invalid capability result");
  return { success: result.isError !== true, contentItems: mapContent(result.content, item => {
    if (item.type === "text" && typeof item.text === "string") return { type: "inputText", text: item.text };
    if (item.type === "image") {
      const valid = image(item.mimeType, item.data);
      return { type: "inputImage", imageUrl: `data:${valid.mimeType};base64,${valid.data}` };
    }
    throw new Error("Unsupported capability content");
  }) };
}
