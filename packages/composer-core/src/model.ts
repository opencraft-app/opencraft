import type { ConversationKey, HostId, TurnId } from "@opencraft/chat-core";

import type { ComposerDocument } from "./document";

export interface ComposerWorkspaceTarget {
  readonly cwd: string | null;
  readonly runtimeWorkspaceRoots: readonly string[];
  /** AppServer-owned project assignment; distinct from a filesystem root. */
  readonly projectId?: string | null;
}

/**
 * Mutable execution placement for a client-owned Draft. It deliberately does
 * not participate in the Draft identity: moving a Draft between Hosts or
 * workspace roots must not replace its document, attachments or selection.
 */
export interface ComposerExecutionTarget {
  readonly hostId: HostId;
  readonly workspace: ComposerWorkspaceTarget;
}

export type ComposerTarget =
  | {
      readonly type: "new-thread";
      /** Stable client identity for one unsaved conversation. */
      readonly draftId: string;
      readonly execution: ComposerExecutionTarget;
    }
  | { readonly type: "existing-thread"; readonly key: ConversationKey }
  | { readonly type: "fork-thread"; readonly key: ConversationKey; readonly fromTurnId: TurnId }
  | { readonly type: "steer-active-turn"; readonly key: ConversationKey; readonly turnId: TurnId }
  | { readonly type: "enqueue-follow-up"; readonly key: ConversationKey };

export type AttachmentLifecycle = "pending" | "uploading" | "processing" | "ready" | "failed";

export interface ComposerAttachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly uri: string | null;
  readonly lifecycle: AttachmentLifecycle;
  readonly error: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ComposerContextReference {
  readonly id: string;
  readonly kind: "file" | "selection" | "image" | "mcp" | "appshot" | "resource" | "annotation";
  readonly title: string;
  readonly uri: string | null;
  readonly visible: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ComposerSelections {
  /** Host-owned Agent identity; absent means the Host default Agent. */
  readonly agentId?: string;
  readonly model?: string;
  readonly mode?: string;
  readonly effort?: string;
  /** `null` explicitly returns to the AppServer-resolved permissions default. */
  readonly permissionProfile?: string | null;
  readonly cwd?: string;
  readonly serviceTier?: string;
  readonly personality?: string;
}

export interface ComposerOptions {
  readonly autoContext: boolean;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly developerInstructions?: string;
}

export interface ComposerDraft {
  readonly id: string;
  readonly target: ComposerTarget;
  readonly document: ComposerDocument;
  readonly attachments: readonly ComposerAttachment[];
  readonly context: readonly ComposerContextReference[];
  readonly selections: ComposerSelections;
  readonly options: ComposerOptions;
  readonly lifecycle: {
    readonly phase: "editing" | "processing-assets" | "submitting" | "failed";
    readonly error: string | null;
  };
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SubmitIntent {
  readonly commandId: string;
  readonly clientMessageId: string;
  readonly target: ComposerTarget;
  readonly document: ComposerDocument;
  readonly attachments: readonly ComposerAttachment[];
  readonly context: readonly ComposerContextReference[];
  readonly selections: ComposerSelections;
  readonly options: ComposerOptions;
  readonly createdAt: number;
}

export interface SubmissionReceipt {
  readonly commandId: string;
  readonly clientMessageId: string;
  readonly hostId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly acceptedAt: number;
  readonly replayed: boolean;
  /** Where the Host durably admitted this submission. */
  readonly disposition?: "turn" | "queue";
}

export interface ComposerCatalogQuery {
  readonly kind: "mention" | "command" | "skill" | "resource";
  readonly query: string;
  readonly target: ComposerTarget;
  readonly limit: number;
}

export interface ComposerCatalogEntry {
  readonly id: string;
  readonly kind: ComposerCatalogQuery["kind"];
  readonly label: string;
  readonly detail: string | null;
  readonly uri: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ComposerCatalog {
  search(query: ComposerCatalogQuery, signal?: AbortSignal): Promise<readonly ComposerCatalogEntry[]>;
}

export interface AssetResolver {
  resolve(attachment: ComposerAttachment, signal?: AbortSignal): Promise<ComposerAttachment>;
  release(attachmentId: string): void | Promise<void>;
}

export function encodeComposerTarget(target: ComposerTarget): string {
  switch (target.type) {
    case "new-thread": return JSON.stringify([
      target.type,
      target.draftId,
    ]);
    case "existing-thread":
    case "enqueue-follow-up": return JSON.stringify([target.type, target.key.hostId, target.key.threadId]);
    case "fork-thread": return JSON.stringify([target.type, target.key.hostId, target.key.threadId, target.fromTurnId]);
    case "steer-active-turn": return JSON.stringify([target.type, target.key.hostId, target.key.threadId, target.turnId]);
  }
}
