import type { ConversationReferencePort } from "@opencraft/composer-editor";
import { encodeConversationRef, type ConversationRef } from "@opencraft/appserver-protocol/collaboration";
import type { useIntl } from "@opencraft/i18n/react";
import type { AppServerHostCatalog } from "../runtime/workbench-application-services";

/** Loaded on first @ search; share in-flight work without retaining stale results. */
export function createConversationSearch(
  command: (id: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>,
  catalog: AppServerHostCatalog,
  intl: ReturnType<typeof useIntl>,
): ConversationReferencePort["search"] {
  const pending = new Map<string, Promise<Record<string, unknown>>>();
  return async (query, signal) => {
    const source = query.target.type === "new-thread" ? query.target.execution.hostId : query.target.key.hostId;
    if (!catalog.threadManagement.capabilities(source).reference) return [];
    if (signal?.aborted) return [];
    const body = {
      action: "discover",
      search: query.query,
      suggestions: true,
      limit: Math.min(20, query.limit),
      ...(query.target.type === "existing-thread" ? { sourceThreadId: query.target.key.threadId } : {}),
    };
    const key = JSON.stringify([source, body]);
    let request = pending.get(key);
    if (!request) {
      request = command(source, body);
      pending.set(key, request);
      void request.finally(() => pending.delete(key)).catch(() => {});
    }
    const r = await request;
    if (signal?.aborted) return [];
    return (
      (r.conversations ?? []) as { ref: ConversationRef; title: string; cwd?: string | null; updatedAt?: number }[]
    )
      .slice(0, query.limit)
      .map((c) => ({
        id: encodeConversationRef(c.ref),
        kind: "mention",
        label: c.title,
        detail:
          [
            c.cwd?.split(/[\\/]/).filter(Boolean).pop(),
            typeof c.updatedAt === "number"
              ? intl.formatDate(c.updatedAt * 1000, { month: "short", day: "numeric" })
              : null,
          ]
            .filter(Boolean)
            .join(" · ") || intl.formatMessage({ id: "conversation.reference.label", defaultMessage: "Conversation" }),
        uri: encodeConversationRef(c.ref),
        metadata: { mentionKind: "thread" },
      }));
  };
}
