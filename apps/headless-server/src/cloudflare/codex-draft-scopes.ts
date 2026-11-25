import { isTerminalResourceScopeId } from "@opencraft/appserver-protocol";
import type { DurableObjectStorage } from "@opencraft/storage-cloudflare/bindings";

async function key(workspace: string, domain: "draft" | "thread", id: string) {
  const bytes = new TextEncoder().encode(JSON.stringify([workspace, id]));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `codex-draft-scopes/${domain}/${Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** The installation owns the immutable Draft alias for an Actor workspace's Thread. */
export class CodexDraftScopes {
  constructor(private readonly storage: DurableObjectStorage) {}

  async bind(workspace: string, scope: string, threadId: string) {
    const [draft, thread] = await Promise.all([key(workspace, "draft", scope), key(workspace, "thread", threadId)]);
    const { kv } = this.storage;
    this.storage.transactionSync(() => {
      const boundThread = kv.get(draft),
        boundScope = kv.get(thread);
      if (boundThread === threadId && boundScope === scope) return;
      if (boundThread !== undefined || boundScope !== undefined) throw Error("Conflicting Codex Draft scope");
      kv.put(draft, threadId);
      kv.put(thread, scope);
    });
    await this.storage.sync();
  }

  async threadForDraft(workspace: string, scope: string): Promise<string | null> {
    const value = this.storage.kv.get(await key(workspace, "draft", scope));
    if (value === undefined) return null;
    if (typeof value !== "string") throw Error("Invalid Codex Draft Thread");
    return value;
  }

  async draftForThread(workspace: string, threadId: string): Promise<string | null> {
    const value = this.storage.kv.get(await key(workspace, "thread", threadId));
    if (value === undefined) return null;
    if (!isTerminalResourceScopeId(value)) throw Error("Invalid Codex Draft scope");
    return value;
  }
}
