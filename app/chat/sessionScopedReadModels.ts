export interface SessionScopedReadModel {
  session_id: string;
}

export interface PendingRequestsSessionView {
  requests: readonly { session_id: string }[];
}

export function readModelForActiveSession<T extends SessionScopedReadModel>(
  activeSessionId: string,
  readModel: T | null | undefined,
): T | null {
  if (!activeSessionId || !readModel) return null;
  return readModel.session_id === activeSessionId ? readModel : null;
}

export function pendingRequestsForActiveSession<T extends PendingRequestsSessionView>(
  activeSessionId: string,
  requests: T | null | undefined,
): T | null {
  if (!activeSessionId || !requests) return null;
  if (requests.requests.length === 0) return null;
  return requests.requests.every((request) => request.session_id === activeSessionId)
    ? requests
    : null;
}

export function isCurrentSessionRequest(
  currentActiveSessionId: string,
  requestedSessionId: string,
) {
  return Boolean(
    currentActiveSessionId &&
      requestedSessionId &&
      currentActiveSessionId === requestedSessionId,
  );
}
