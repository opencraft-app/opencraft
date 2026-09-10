import type { AppServerThreadItem } from "./types";

/** Source-call identity is distinct from the stable display Item identity.
 * Desktop likewise correlates anonymous completions with open same-name calls.
 * Explicit, different source IDs must never be merged by a matching label. */
export function resolveToolIdentity(
  tools: Map<string, AppServerThreadItem>,
  payload: Record<string, unknown>,
  phase: "start" | "update",
  allocate: () => string,
): string {
  const source = typeof payload.tool_id === "string" && payload.tool_id ? payload.tool_id : null;
  if (source !== null && tools.has(source)) return source;
  const candidates = [...tools.entries()].filter(([, item]) =>
    item.status === "inProgress" && item.tool === payload.name
    && (source === null || item.sourceIdentitySynthetic === true));
  const values = (args: unknown): string[] => {
    if (!args || typeof args !== "object") return [];
    const record = args as Record<string, unknown>;
    return ["command", "code", "path", "query", "search_term", "question", "server"]
      .flatMap(key => typeof record[key] === "string" && record[key] ? [`${key}:${record[key]}`] : []);
  };
  const incoming = values(payload.args);
  const contextual = candidates.find(([, item]) => values(item.arguments).some(value => incoming.includes(value)));
  // As in Desktop, contextual matches precede oldest-open fallback when the
  // source omitted identity. Known identities were handled above.
  const match = phase === "update" ? contextual ?? candidates[0] : undefined;
  if (match) {
    if (source === null) return match[0];
    tools.delete(match[0]);
    tools.set(source, { ...match[1], callId: source, sourceIdentitySynthetic: false });
    return source;
  }
  return source ?? allocate();
}
