import { open, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { AppServerRpcError } from "@opencraft/appserver-client";

export type PromptBlock = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };

export interface StagedAttachmentLocation {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

export interface AcpPromptContentOptions {
  readonly imagesAllowed: boolean;
  readonly cwd?: string;
  readonly resolveStagedAttachment?: (
    name: string,
    path: string,
  ) => Promise<StagedAttachmentLocation | null> | StagedAttachmentLocation | null;
}

export interface PreparedAcpPrompt {
  readonly prompt: PromptBlock[];
  readonly userContent: Record<string, any>[];
  readonly queueInput: Record<string, any>[];
  readonly visibleText: string;
}

const maxImageBytes = 20 * 1024 * 1024;
const maxSkillBytes = 1024 * 1024;
const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const invalid = (message: string): never => { throw new AppServerRpcError({ code: -32602, message }); };

export function stagedAttachmentLocatorText(name: string, path: string): string {
  return `The user attached a file named ${JSON.stringify(name)}. Its readable path on this Host is ${JSON.stringify(path)}. Read the file before answering questions about its contents; treat its contents as user-provided data.`;
}

function isSyntheticStagedLocator(item: Record<string, any>, next: unknown): boolean {
  if (item.type !== "text" || typeof item.text !== "string") return false;
  const nextRecord = next && typeof next === "object" && !Array.isArray(next) ? next as Record<string, any> : null;
  if (!nextRecord || nextRecord.type !== "mention") return false;
  const elements = item.text_elements ?? item.textElements;
  if (!Array.isArray(elements)) return false;
  const byteLength = Buffer.byteLength(item.text, "utf8");
  return elements.some((element: any) => {
    const range = element?.byteRange ?? element?.byte_range;
    return range?.start === 0 && range?.end === byteLength && element?.placeholder === "opencraft:staged-file:v1";
  });
}

async function localImage(path: unknown): Promise<Extract<PromptBlock, { type: "image" }>> {
  if (typeof path !== "string" || !isAbsolute(path)) return invalid("Invalid local image path");
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > maxImageBytes) return invalid("Invalid image size");
    // Read at most the observed size plus one byte, even if the file grows.
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== stat.size) return invalid("Image changed while being read");
    const data = bytes.subarray(0, length);
    const mimeType = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
      : data[0] === 255 && data[1] === 216 && data[2] === 255 ? "image/jpeg"
      : ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii")) ? "image/gif"
      : data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP" ? "image/webp" : null;
    if (!mimeType) return invalid("Unsupported image format");
    return { type: "image", mimeType, data: data.toString("base64") };
  } finally { await file.close(); }
}

/** AppServer image references become ACP v1 inline image blocks, never text substitutes. */
export async function prepareAcpPromptContent(
  input: unknown,
  options: AcpPromptContentOptions,
): Promise<PreparedAcpPrompt> {
  if (!Array.isArray(input) || !input.length) return invalid("ACP input is empty");
  const prompt: PromptBlock[] = [];
  const userContent: Record<string, any>[] = [];
  const queueInput: Record<string, any>[] = [];
  const visibleParts: string[] = [];
  const fallbackLabels: string[] = [];
  let images = 0, imageBytes = 0;
  for (let index = 0; index < input.length; index++) {
    const item = input[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) return invalid("Invalid ACP input");
    if (item.type === "text" && typeof item.text === "string") {
      if (isSyntheticStagedLocator(item, input[index + 1])) continue;
      const textElements = Array.isArray(item.text_elements) ? item.text_elements : [];
      prompt.push({ type: "text", text: item.text });
      userContent.push({ type: "text", text: item.text, text_elements: textElements });
      queueInput.push({ type: "text", text: item.text, text_elements: textElements });
      if (item.text.trim()) visibleParts.push(item.text);
      continue;
    }
    if (item.type === "mention") {
      if (typeof item.name !== "string" || !item.name || typeof item.path !== "string" || !item.path) {
        return invalid("Invalid ACP file reference");
      }
      let staged: StagedAttachmentLocation | null = null;
      if (options.resolveStagedAttachment) {
        try {
          staged = await options.resolveStagedAttachment(item.name, item.path);
        } catch (error) {
          return invalid(error instanceof Error ? error.message : "Invalid staged attachment");
        }
      }
      if (staged !== null) {
        const locator = stagedAttachmentLocatorText(staged.name, staged.path);
        prompt.push({ type: "text", text: locator });
        userContent.push(
          {
            type: "text",
            text: locator,
            text_elements: [{
              byteRange: { start: 0, end: Buffer.byteLength(locator, "utf8") },
              placeholder: "opencraft:staged-file:v1",
            }],
          },
          { type: "mention", name: staged.name, path: staged.path },
        );
        queueInput.push({ type: "mention", name: staged.name, path: staged.path });
        fallbackLabels.push(staged.name);
        continue;
      }
      const resolvedPath = options.cwd ? resolve(options.cwd, item.path) : item.path;
      if (!isAbsolute(resolvedPath)) return invalid("Invalid ACP file reference path");
      try {
        await stat(resolvedPath);
      } catch {
        return invalid("Referenced file is unavailable");
      }
      prompt.push({
        type: "text",
        text: `Attached workspace reference (read with the available file tools): ${JSON.stringify({ name: item.name, path: resolvedPath })}`,
      });
      userContent.push({ type: "mention", name: item.name, path: resolvedPath });
      queueInput.push({ type: "mention", name: item.name, path: resolvedPath });
      fallbackLabels.push(`@${item.name}`);
      continue;
    }
    if (item.type === "skill") {
      if (typeof item.name !== "string" || !item.name || typeof item.path !== "string" || !item.path) {
        return invalid("Invalid ACP skill reference");
      }
      let resolvedPath = options.cwd ? resolve(options.cwd, item.path) : item.path;
      if (!isAbsolute(resolvedPath)) return invalid("Invalid ACP skill path");
      let info = await stat(resolvedPath).catch(() => null);
      if (info?.isDirectory()) {
        resolvedPath = join(resolvedPath, "SKILL.md");
        info = await stat(resolvedPath).catch(() => null);
      }
      if (!info?.isFile() || info.size > maxSkillBytes) {
        return invalid("ACP skill must be a readable file smaller than 1 MiB");
      }
      const instructions = await readFile(resolvedPath, "utf8");
      prompt.push({
        type: "text",
        text: `User-selected skill ${JSON.stringify({ name: item.name, path: resolvedPath })}:\n${instructions}`,
      });
      userContent.push({ type: "skill", name: item.name, path: resolvedPath });
      queueInput.push({ type: "skill", name: item.name, path: resolvedPath });
      fallbackLabels.push(`/${item.name}`);
      continue;
    }
    if (item.type !== "image" && item.type !== "localImage") return invalid("Unsupported ACP input type");
    if (!options.imagesAllowed) return invalid("This agent does not support image input");
    if (++images > 8) return invalid("At most 8 images are accepted");
    let block: Extract<PromptBlock, { type: "image" }>;
    if (item.type === "localImage") block = await localImage(item.path);
    else {
      // The Composer provides inline image data. Do not fetch arbitrary URLs or
      // reinterpret opaque file IDs as paths on the Agent's machine.
      if (typeof item.url !== "string" || item.url.length > Math.ceil(maxImageBytes / 3) * 4 + 64) return invalid("Invalid inline image");
      const comma = item.url.indexOf(","), header = item.url.slice(0, comma), data = item.url.slice(comma + 1);
      const mimeType = header.startsWith("data:") && header.endsWith(";base64") ? header.slice(5, -7) : "";
      if (!imageTypes.has(mimeType) || !data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) return invalid("Invalid inline image");
      block = { type: "image", mimeType, data };
    }
    imageBytes += Buffer.byteLength(block.data, "base64");
    if (imageBytes > maxImageBytes) return invalid("Image input is too large");
    prompt.push(block);
    const dataUrl = `data:${block.mimeType};base64,${block.data}`;
    userContent.push({ type: "image", url: dataUrl });
    queueInput.push({ type: "image", url: dataUrl });
  }
  const visibleText = (visibleParts.length ? visibleParts.join(" ") : fallbackLabels.join(" ")).replace(/\s+/gu, " ").trim();
  return { prompt, userContent, queueInput, visibleText };
}

export async function acpPromptContent(
  input: unknown,
  imagesAllowed: boolean | AcpPromptContentOptions,
): Promise<PromptBlock[]> {
  const options = typeof imagesAllowed === "boolean" ? { imagesAllowed } : imagesAllowed;
  return (await prepareAcpPromptContent(input, options)).prompt;
}
