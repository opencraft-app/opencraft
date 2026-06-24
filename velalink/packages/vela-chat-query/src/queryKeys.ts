import type { SessionListOptions } from "../../vela-chat-client/src";

export const velaQueryKeys = {
  all: ["vela"] as const,
  session(sessionId: string) {
    return ["vela", "sessions", "detail", sessionId] as const;
  },
  sessionListView(options: SessionListOptions = {}) {
    return ["vela", "sessions", "view", normalizeSessionListOptions(options)] as const;
  },
};

function normalizeSessionListOptions(options: SessionListOptions) {
  return {
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.afterId !== undefined ? { afterId: options.afterId } : {}),
  };
}

