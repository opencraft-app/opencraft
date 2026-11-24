import type { IncomingMessage, ServerResponse } from "node:http";
import { parseThreadReadReceipts, THREAD_READ_RECEIPT_MERGE_LIMIT } from "@opencraft/workbench-runtime";
import { sameOriginJsonRequest, type AccountModelDefaultsAccess } from "./account-model-defaults-http.js";

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

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    // 128 receipts of at most 2 KiB each, with room for the envelope.
    if (size > 300_000) throw new RequestError(413, "too_large");
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
export function threadReadReceiptsHttp(
  storage: ThreadReadReceiptStorage,
  access: (request: IncomingMessage) => AccountModelDefaultsAccess,
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "http://thread-reads.invalid");
    if (url.pathname !== THREAD_READ_RECEIPTS_PATH) return false;
    const send = (status: number, value: unknown) => {
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(JSON.stringify(value));
    };
    try {
      const initial = access(request);
      if ("denied" in initial) {
        send(initial.denied, {
          error: initial.denied === 401 ? "human_authentication_required" : "instance_access_denied",
        });
        return true;
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
      if (request.method === "GET") {
        if (!url.searchParams.has("expectedActorId")) {
          send(200, { actorId });
          return true;
        }
        if (url.searchParams.get("expectedActorId") !== actorId) throw new RequestError(409, "account_changed");
        const rawAfter = url.searchParams.get("after") ?? "0";
        if (!/^(0|[1-9]\d{0,15})$/u.test(rawAfter) || !Number.isSafeInteger(Number(rawAfter))) throw invalid();
        const page = await storage.readThreadReadReceipts(actorId, Number(rawAfter));
        current();
        send(200, {
          actorId,
          cursor: page.cursor,
          receipts: page.receipts.map((receipt) => JSON.stringify(receipt)),
        });
        return true;
      }
      if (request.method !== "POST") {
        send(405, { error: "method_not_allowed" });
        return true;
      }
      if (!sameOriginJsonRequest(request, initial.origin)) {
        send(403, { error: "same_origin_required" });
        return true;
      }
      const input = await body(request);
      if (Object.keys(input).some((field) => field !== "receipts" && field !== "expectedActorId")) throw invalid();
      const accepted = receipts(input.receipts, THREAD_READ_RECEIPT_MERGE_LIMIT);
      if (input.expectedActorId !== actorId) throw new RequestError(409, "account_changed");
      current();
      const result = await storage.mergeThreadReadReceipts(
        actorId,
        accepted.map((receipt) => JSON.parse(receipt) as Identity),
      );
      current();
      send(200, { actorId, cursor: result.cursor, receipts: accepted });
    } catch (error) {
      if (error instanceof RequestError) send(error.status, { error: error.code });
      // Storage or Worker failure fails closed; nothing is read or written elsewhere.
      else send(503, { error: "read_receipts_unavailable" });
    }
    return true;
  };
}
