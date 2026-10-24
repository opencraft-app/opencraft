import {
  encodeComposerTarget, isComposerDocumentEmpty,
  type ComposerDraftStorage, type ComposerSavedContent, type ComposerTarget,
} from "@opencraft/composer-core";

type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem"> & Partial<Pick<Storage, "key" | "length">>;
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
function content(value: unknown): value is ComposerSavedContent {
  return object(value) && object(value.document) && value.document.version === 1 && all(value.document.blocks, item => block(item))
    && all(value.attachments, item => object(item) && string(item.id) && string(item.name) && string(item.mimeType) && typeof item.size === "number" && Number.isFinite(item.size) && item.size >= 0
      && (item.uri === null || string(item.uri)) && ["pending", "uploading", "processing", "ready", "failed"].includes(String(item.lifecycle)) && (item.error === null || string(item.error)) && metadata(item.metadata))
    && all(value.context, item => object(item) && string(item.id) && string(item.title) && ["file", "selection", "image", "mcp", "appshot", "resource", "annotation"].includes(String(item.kind)) && (item.uri === null || string(item.uri)) && typeof item.visible === "boolean" && metadata(item.metadata));
}

/** Browser-origin local, no RPC, no cross-tab subscriptions, no submission replay.
 * Task and message rooms use separate namespaces even on the same native Thread.
 * A stored draft never restores a lock, provisional dictation or in-flight work.
 */
export class BrowserComposerDrafts implements ComposerDraftStorage {
  private revoked = false;
  private readonly knownKeys = new Set<string>();
  constructor(private readonly storage: StoragePort, private readonly namespace: string) {}
  private key(target: ComposerTarget): string {
    const key = `${this.namespace}:${encodeComposerTarget(target)}`;
    this.knownKeys.add(key);
    return key;
  }
  private record(target: ComposerTarget): RecordValue | null {
    const raw = this.storage.getItem(this.key(target));
    if (raw === null || raw.length > 4 * 1024 * 1024) return null;
    try {
      const value: unknown = JSON.parse(raw);
      return object(value) && value.version === 1 && content(value.content) ? value : null;
    } catch { return null; }
  }
  read(target: ComposerTarget): ComposerSavedContent | null {
    if (this.revoked) return null;
    const record = this.record(target);
    if (!record || !content(record.content)) return null;
    return {
      ...record.content,
      // Object URLs and unfinished staging have process-local owners. Keep
      // the file chip recoverable, but never claim its missing bytes are ready.
      attachments: record.content.attachments.map(item => item.uri?.startsWith("blob:") || item.uri === null || item.lifecycle !== "ready"
        ? { ...item, uri: null, lifecycle: "failed", error: "请重新添加此文件。", metadata: undefined }
        : item),
    };
  }
  write(target: ComposerTarget, value: ComposerSavedContent): void {
    if (this.revoked) return;
    if (isComposerDocumentEmpty(value.document) && value.attachments.length === 0 && value.context.length === 0) {
      this.storage.removeItem(this.key(target)); return;
    }
    const serialized = JSON.stringify({ version: 1, target, content: value });
    if (serialized.length > 4 * 1024 * 1024) throw new RangeError("Local draft exceeds the supported record size");
    this.storage.setItem(this.key(target), serialized);
  }
  /** Revocation is final: late old-account writes cannot seed another account. */
  revokeAndClear(): void {
    this.revoked = true;
    try {
      if (this.storage.key && this.storage.length !== undefined) {
        for (let index = this.storage.length - 1; index >= 0; index--) {
          const key = this.storage.key(index);
          if (key?.startsWith(`${this.namespace}:`)) this.storage.removeItem(key);
        }
      }
      for (const key of this.knownKeys) this.storage.removeItem(key);
    } catch { /* A revoked adapter remains unreadable even if removal fails. */ }
    this.knownKeys.clear();
  }
}
