import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export type NotificationRejection =
  | "method_not_allowed"
  | "trusted_origin_missing"
  | "trusted_origin_invalid_protocol"
  | "origin_missing"
  | "origin_mismatch"
  | "cross_site"
  | "content_type_invalid";
const states = new WeakMap<ServerResponse, { reason?: NotificationRejection }>();
const codes = new Set([
  "human_authentication_required",
  "authentication_required",
  "instance_access_denied",
  "actor_access_denied",
  "actor_resource_interface_required",
  "same_origin_json_required",
  "account_changed",
  "too_large",
  "invalid_destination",
  "invalid_target",
  "device_limit",
  "not_found",
  "destination_not_found",
  "rate_limited",
  "notification_storage_unavailable",
  "notification_delivery_failed",
  "notification_operation_failed",
  "push_operation_failed",
  "missing",
]);
export interface NotificationDiagnostic {
  requestId: string;
  endpoint: "notifications" | "push";
  status: number;
  code: string;
  reason: string;
  durationMs: number;
}
/** Install before gateway admission. Only fixed codes and generated IDs enter logs. */
export function observeNotificationRequest(
  request: IncomingMessage,
  response: ServerResponse,
  emit: (event: NotificationDiagnostic) => void = (event) =>
    console.warn("[opencraft notification request failed]", event),
) {
  const path = (request.url ?? "").split("?")[0];
  if (!["/__opencraft_notifications", "/__opencraft_push"].includes(path!) || states.has(response)) return;
  const state: { reason?: NotificationRejection } = {};
  states.set(response, state);
  const requestId = randomUUID(),
    started = performance.now();
  response.setHeader("x-opencraft-notification-request-id", requestId);
  let code = "unknown",
    done = false;
  const end = response.end;
  response.end = function (this: ServerResponse, ...args: any[]) {
    try {
      if (
        response.statusCode >= 400 &&
        (typeof args[0] === "string" || Buffer.isBuffer(args[0])) &&
        Buffer.byteLength(args[0]) <= 4096
      ) {
        const value = JSON.parse(String(args[0])).error;
        if (typeof value === "string" && codes.has(value)) code = value;
        else if (value === "Matching origin required") code = "matching_origin_required";
      }
    } catch {
      /* Diagnostics must not affect responses. */
    }
    return end.apply(this, args as any);
  } as typeof response.end;
  const record = (aborted: boolean) => {
    if (done) return;
    done = true;
    if (!aborted && response.statusCode < 400) return;
    try {
      emit({
        requestId,
        endpoint: path === "/__opencraft_notifications" ? "notifications" : "push",
        status: aborted ? 0 : response.statusCode,
        code: aborted ? "request_aborted" : code,
        reason: state.reason ?? (aborted ? "request_aborted" : code),
        durationMs: Math.round(performance.now() - started),
      });
    } catch {
      /* No response changes on logger failure. */
    }
  };
  response.once("finish", () => record(false));
  response.once("close", () => record(!response.writableFinished));
}
export function notificationRejection(response: ServerResponse, reason: NotificationRejection) {
  const state = states.get(response);
  if (state) state.reason = reason;
}
