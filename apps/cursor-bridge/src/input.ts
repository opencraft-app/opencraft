import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface CursorInput { text: string; attachments: readonly { data: string }[] }
export function parseInput(value: unknown): CursorInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid input");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => !["text", "attachments"].includes(k))
    || typeof v.text !== "string" || !v.text.trim() || v.text.trimStart().startsWith("/")
    || (v.attachments !== undefined && !Array.isArray(v.attachments))) throw Error("invalid Cursor input");
  if (Array.isArray(v.attachments) && v.attachments.length > 16) throw Error("too many attachments");
  const attachments: { data: string }[] = [];
  for (const item of (v.attachments ?? []) as unknown[]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw Error("invalid attachment");
    const a = item as Record<string, unknown>;
    if (Object.keys(a).some((k) => k !== "data") || typeof a.data !== "string"
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(a.data)) throw Error("invalid attachment");
    attachments.push({ data: a.data });
  }
  if (Buffer.byteLength(v.text) + attachments.reduce((n, a) => n + Buffer.byteLength(a.data), 0) > 64 * 1024) throw Error("input exceeds 64 KiB");
  return { text: v.text, attachments };
}

/** One owner per input. Stop waits for conversion before removing its directory. */
export class InputFiles {
  private directory?: string;
  private conversion?: Promise<string>;
  constructor(private readonly input: CursorInput, private readonly parent = tmpdir()) {}
  prepare(): Promise<string> {
    return this.conversion ??= this.convert();
  }
  private async convert(): Promise<string> {
    if (!this.input.attachments.length) return this.input.text;
    this.directory = await mkdtemp(join(this.parent, "cursor-input-"));
    const paths: string[] = [];
    try {
      for (const [index, attachment] of this.input.attachments.entries()) {
        const path = join(this.directory, `attachment-${index}`);
        await writeFile(path, Buffer.from(attachment.data, "base64"), { mode: 0o600 });
        paths.push(path);
      }
      return `${this.input.text}\n\nAttachments (local files):\n${paths.join("\n")}`;
    } catch (error) {
      await this.clean();
      throw error;
    }
  }
  private async clean(): Promise<void> {
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
  async dispose(): Promise<void> {
    await this.conversion?.catch(() => {});
    await this.clean();
  }
}
