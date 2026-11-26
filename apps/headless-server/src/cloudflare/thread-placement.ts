// Rebuildable installation projection of workspace-owned, committed placements.
// Positive placement is required in addition to Thread access. This module does
// not pick an environment or accept an unverified workspace assertion.
import type { StateDocumentStore } from "@opencraft/document-storage/state";
import type { ActorContext } from "@opencraft/identity-core/actors";
import { isWorkspaceId } from "@opencraft/sandbox/uri";

export const THREAD_PLACEMENT_PUBLISH_PATH = "/__opencraft_internal/thread-placement/publish";
export const THREAD_PLACEMENT_LOOKUP_PATH = "/__opencraft_internal/thread-placement/lookup";

export interface ThreadPlacementKey {
  readonly serverId: string;
  readonly threadId: string;
}

export interface ThreadPlacementReceipt extends ThreadPlacementKey {
  readonly workspaceId: string;
  /** Monotonically increases for this Thread at its durable WorkspaceHost owner. */
  readonly revision: number;
  readonly state: "placed" | "removed";
}

export interface WorkspaceThreadPlacementSource {
  /** Reads the bound owner's most recent committed receipt, including removals. */
  readCommitted(key: ThreadPlacementKey): Promise<ThreadPlacementReceipt | null>;
}

export interface ThreadPlacementAuthority {
  /** Resolves a workspace by its binding identity. Callers do not supply a URL or a proof reader. */
  workspace(workspaceId: string): WorkspaceThreadPlacementSource | null;
  /** The installation's current Thread/Spaces read policy, after positive placement. */
  allows(context: ActorContext, key: ThreadPlacementKey): boolean;
}

type Document = {
  readonly schemaVersion: 1;
  readonly receipt: ThreadPlacementReceipt;
  readonly sideChatParent?: string;
  readonly archived?: boolean;
};
type Publication = "applied" | "unchanged" | "conflict" | "unconfirmed";

function validSubject(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/u.test(value);
}

export function parseThreadPlacementKey(value: unknown): ThreadPlacementKey | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { serverId, threadId } = value as Partial<ThreadPlacementKey>;
  return validSubject(serverId) && validSubject(threadId) ? { serverId, threadId } : null;
}

export function parseThreadPlacementReceipt(value: unknown): ThreadPlacementReceipt | null {
  const key = parseThreadPlacementKey(value);
  if (!key) return null;
  const { workspaceId, revision, state } = value as Partial<ThreadPlacementReceipt>;
  if (
    !isWorkspaceId(workspaceId) ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    (state !== "placed" && state !== "removed")
  )
    return null;
  return { ...key, workspaceId, revision, state };
}

async function placementKey({ serverId, threadId }: ThreadPlacementKey): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([serverId, threadId])));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameThread(a: ThreadPlacementKey, b: ThreadPlacementKey): boolean {
  return a.serverId === b.serverId && a.threadId === b.threadId;
}

export function sameThreadPlacement(a: ThreadPlacementReceipt, b: ThreadPlacementReceipt): boolean {
  return sameThread(a, b) && a.workspaceId === b.workspaceId && a.revision === b.revision && a.state === b.state;
}

function parsePlacementDocument(value: unknown, key: ThreadPlacementKey): Document | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid thread placement document");
  const document = value as Partial<Document>;
  const receipt = parseThreadPlacementReceipt(document.receipt);
  const { sideChatParent, archived } = document;
  if (
    document.schemaVersion !== 1 ||
    !receipt ||
    !sameThread(receipt, key) ||
    (archived !== undefined && typeof archived !== "boolean") ||
    (sideChatParent !== undefined && (!validSubject(sideChatParent) || sideChatParent === key.threadId))
  )
    throw new Error("Invalid thread placement document");
  return { schemaVersion: 1, receipt, sideChatParent, archived };
}

function documentReceipt(value: unknown, key: ThreadPlacementKey): ThreadPlacementReceipt | null {
  return parsePlacementDocument(value, key)?.receipt ?? null;
}

/** The WorkspaceHost's committed record for its own persistent Codex Threads. */
export class WorkspaceThreadPlacements implements WorkspaceThreadPlacementSource {
  constructor(
    private readonly documents: StateDocumentStore,
    private readonly workspaceId: string,
    private readonly serverId: string,
  ) {}

  async readCommitted(
    thread: ThreadPlacementKey,
    options?: { includeSideChats?: boolean; archiveState?: boolean },
  ): Promise<(ThreadPlacementReceipt & { readonly archived?: boolean }) | null> {
    if (thread.serverId !== this.serverId) return null;
    const document = parsePlacementDocument(await this.documents.read(await placementKey(thread)), thread);
    if (options?.includeSideChats === false && document?.sideChatParent !== undefined) return null;
    const receipt = document?.receipt ?? null;
    if (receipt && receipt.workspaceId !== this.workspaceId) throw new Error("Foreign Thread placement");
    return receipt && options?.archiveState && document?.archived !== undefined
      ? { ...receipt, archived: document.archived }
      : receipt;
  }

  /** Shared workspaces retain successful native lifecycle acknowledgements locally. */
  async recordArchive(receipt: ThreadPlacementReceipt, archived: boolean): Promise<void> {
    if (receipt.serverId !== this.serverId || receipt.workspaceId !== this.workspaceId || receipt.state !== "placed")
      throw new Error("Foreign Thread placement");
    await this.documents.update(await placementKey(receipt), value => {
      const previous = parsePlacementDocument(value, receipt);
      if (!previous || !sameThreadPlacement(previous.receipt, receipt)) throw new Error("Thread placement changed");
      return { result: undefined, ...(previous.archived !== archived ? { next: { ...previous, archived } } : {}) };
    });
  }

  async isSideChat(threadId: string): Promise<boolean> {
    const thread = { serverId: this.serverId, threadId };
    const doc = parsePlacementDocument(await this.documents.read(await placementKey(thread)), thread);
    return (
      doc?.receipt.state === "placed" &&
      doc.receipt.workspaceId === this.workspaceId &&
      doc.sideChatParent !== undefined
    );
  }

  async commitCreated(threadId: string, sideChatParent?: string): Promise<ThreadPlacementReceipt> {
    const thread = parseThreadPlacementKey({ serverId: this.serverId, threadId });
    if (!thread || sideChatParent === threadId || (sideChatParent !== undefined && !validSubject(sideChatParent)))
      throw new Error("Invalid native Thread identity");
    return this.documents.update<ThreadPlacementReceipt>(await placementKey(thread), (value) => {
      const existing = parsePlacementDocument(value, thread);
      const previous = existing?.receipt;
      if (previous) {
        if (
          previous.workspaceId !== this.workspaceId ||
          previous.state !== "placed" ||
          existing?.sideChatParent !== sideChatParent
        )
          throw new Error("Conflicting native Thread placement");
        return { result: previous };
      }
      const receipt: ThreadPlacementReceipt = {
        ...thread,
        workspaceId: this.workspaceId,
        revision: 1,
        state: "placed",
      };
      return {
        result: receipt,
        next: { schemaVersion: 1, receipt, ...(sideChatParent ? { sideChatParent } : {}) } satisfies Document,
      };
    });
  }
}

export class ThreadPlacementProjection {
  constructor(
    private readonly documents: StateDocumentStore,
    readonly authority: ThreadPlacementAuthority,
  ) {}

  async #confirmed(receipt: ThreadPlacementReceipt): Promise<boolean> {
    const source = this.authority.workspace(receipt.workspaceId);
    const current =
      source &&
      parseThreadPlacementReceipt(
        await source.readCommitted({
          serverId: receipt.serverId,
          threadId: receipt.threadId,
        }),
      );
    return !!current && sameThreadPlacement(current, receipt);
  }

  async publish(receipt: ThreadPlacementReceipt): Promise<Publication> {
    if (!(await this.#confirmed(receipt))) return "unconfirmed";
    const key = await placementKey(receipt);
    return this.documents.update<Publication>(key, (value) => {
      const previous = documentReceipt(value, receipt);
      if (previous && (previous.workspaceId !== receipt.workspaceId || previous.revision > receipt.revision))
        return { result: "conflict" };
      if (previous?.revision === receipt.revision)
        return { result: sameThreadPlacement(previous, receipt) ? "unchanged" : "conflict" };

      // Keep a removal as a revision fence. Ordinary publication never
      // transfers a Thread between workspaces.
      return { result: "applied", next: { schemaVersion: 1, receipt } satisfies Document };
    });
  }

  async lookup(thread: ThreadPlacementKey): Promise<ThreadPlacementReceipt | null> {
    const key = await placementKey(thread);
    const receipt = documentReceipt(await this.documents.read(key), thread);
    if (receipt?.state !== "placed" || !(await this.#confirmed(receipt))) return null;
    const latest = documentReceipt(await this.documents.read(key), thread);
    // A new projection may arrive while the WorkspaceHost answers.
    return latest && sameThreadPlacement(latest, receipt) ? receipt : null;
  }

  /** Check a fresh, committed receipt delivered directly by the bound workspace. */
  async matchesPublished(receipt: ThreadPlacementReceipt): Promise<boolean> {
    const latest = documentReceipt(await this.documents.read(await placementKey(receipt)), receipt);
    return receipt.state === "placed" && !!latest && sameThreadPlacement(latest, receipt);
  }
}
