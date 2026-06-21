import { VeladClientError } from "../../../packages/vela-chat-client/src";

export function cursorEventId(
  cursor?: { event_id?: string; latest_event_id?: string; next_event_id?: string } | null,
) {
  return cursor?.event_id ?? cursor?.latest_event_id ?? cursor?.next_event_id ?? null;
}

export function isStaleCursorError(err: unknown) {
  return (
    err instanceof VeladClientError &&
    (err.detail as { reason?: unknown } | undefined)?.reason === "stale_cursor"
  );
}
