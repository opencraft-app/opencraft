import {
  HttpBodyTooLarge,
  decodeUtf8,
  jsonResponse,
  requestUrl,
  type HttpExchangeRequest,
  type HttpExchangeResponse,
  type HttpRequestView,
} from "@opencraft/http-exchange";
import { parseThreadReadReceipts, THREAD_READ_RECEIPT_MERGE_LIMIT } from "@opencraft/workbench-runtime";
import type { AccountModelDefaultsAccess } from "./account-model-defaults-http.js";

/** Cross-device read state of the signed-in human Actor; see docs/architecture/platform/identity-and-access.md. */
export const THREAD_READ_RECEIPTS_PATH = "/__opencraft_thread_reads";

type Identity = readonly [string, string, string];

/** Async ports of the Server owner Worker; this module never opens SQLite. */
export interface ThreadReadReceiptStorage {
  readThreadReadReceipts(actorId: string, after: number): Promise<{ cursor: number; receipts: readonly Identity[] }>;
  mergeThreadReadReceipts(actorId: string, receipts: readonly Identity[]): Promise<{ cursor: number }>;
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const invalid = () => new RequestError(400, "invalid_read_receipts");

function receipts(value: unknown, limit: number): string[] {
  if (!Array.isArray(value) || value.length > limit) throw invalid();
  try {
    return parseThreadReadReceipts(value);
  } catch {
    throw invalid();
  }
}

async function body(request: HttpExchangeRequest<unknown>): Promise<Record<string, unknown>> {
  let bytes: Uint8Array;
  try {
    // 128 receipts of at most 2 KiB each, with room for the envelope.
    bytes = await request.readBody(300_000);
  } catch (error) {
    if (error instanceof HttpBodyTooLarge) throw new RequestError(413, "too_large");
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(bytes));
  } catch {
    throw invalid();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

/**
 * `GET` without `expectedActorId` reports the signed-in Actor. `GET ?expectedActorId&after`
 * returns that Actor's receipts recorded after the cursor, oldest first. A same-origin JSON
 * `POST {receipts, expectedActorId}` adds receipts; nothing removes or replaces one. The
 * expected Actor only fences an account change; it never selects whose receipts are used.
 */
export function threadReadReceiptsHttp<R = HttpRequestView>(
  storage: ThreadReadReceiptStorage,
  access: (request: R) => AccountModelDefaultsAccess,
) {
  return async (exchange: HttpExchangeRequest<R>): Promise<HttpExchangeResponse | null> => {
    const url = requestUrl(exchange);
    if (url.pathname !== THREAD_READ_RECEIPTS_PATH) return null;
    const request = exchange.identity;
    const send = (status: number, value: unknown) =>
      jsonResponse(status, value, [
        ["content-type", "application/json; charset=utf-8"],
        ["cache-control", "private, no-store"],
        ["x-content-type-options", "nosniff"],
      ]);
    try {
      const initial = access(request);
      if ("denied" in initial) {
        return send(initial.denied, {
          error: initial.denied === 401 ? "human_authentication_required" : "instance_access_denied",
        });
      }
      const actorId = initial.actorId;
      // Admission and the signed-in Actor are rechecked after every await.
      const current = () => {
        const latest = access(request);
        if ("denied" in latest)
          throw new RequestError(
            latest.denied,
            latest.denied === 401 ? "human_authentication_required" : "instance_access_denied",
          );
        if (latest.actorId !== actorId) throw new RequestError(409, "account_changed");
      };
      if (exchange.method === "GET") {
        if (!url.searchParams.has("expectedActorId")) return send(200, { actorId });
        if (url.searchParams.get("expectedActorId") !== actorId) throw new RequestError(409, "account_changed");
        const rawAfter = url.searchParams.get("after") ?? "0";
        if (!/^(0|[1-9]\d{0,15})$/u.test(rawAfter) || !Number.isSafeInteger(Number(rawAfter))) throw invalid();
        const page = await storage.readThreadReadReceipts(actorId, Number(rawAfter));
        current();
        return send(200, {
          actorId,
          cursor: page.cursor,
          receipts: page.receipts.map((receipt) => JSON.stringify(receipt)),
        });
      }
      if (exchange.method !== "POST") return send(405, { error: "method_not_allowed" });
      // Same rule as the model defaults route: the trusted origin or this request's own host.
      const origin = exchange.headers.origin;
      if (
        typeof origin !== "string" ||
        !(
          origin === initial.origin ||
          ["http:", "https:"].some((protocol) => origin === protocol + "//" + exchange.headers.host)
        ) ||
        exchange.headers["sec-fetch-site"] === "cross-site" ||
        exchange.headers["content-type"]?.split(";")[0] !== "application/json"
      ) {
        return send(403, { error: "same_origin_required" });
      }
      const input = await body(exchange);
      if (Object.keys(input).some((field) => field !== "receipts" && field !== "expectedActorId")) throw invalid();
      const accepted = receipts(input.receipts, THREAD_READ_RECEIPT_MERGE_LIMIT);
      if (input.expectedActorId !== actorId) throw new RequestError(409, "account_changed");
      current();
      const result = await storage.mergeThreadReadReceipts(
        actorId,
        accepted.map((receipt) => JSON.parse(receipt) as Identity),
      );
      current();
      return send(200, { actorId, cursor: result.cursor, receipts: accepted });
    } catch (error) {
      if (error instanceof RequestError) return send(error.status, { error: error.code });
      // Storage or Worker failure fails closed; nothing is read or written elsewhere.
      return send(503, { error: "read_receipts_unavailable" });
    }
  };
}
