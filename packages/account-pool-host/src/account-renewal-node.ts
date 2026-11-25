import { decodeUtf8, HttpBodyTooLarge } from "@opencraft/http-exchange";
import { fetchHttpExchange } from "@opencraft/http-exchange/fetch";
import { classifyAccountFailure } from "./account-diagnostics.js";
import {
  ACCOUNT_RENEWAL_PATH,
  isAccountRenewalFailure,
  parseAccountRenewalRequest,
  parseAccountRenewalResponse,
  type AccountRenewalExecutor,
  type AccountRenewalRequest,
} from "./account-renewal.js";
import { createManagedCodexRefresh, type CodexMaintenanceClientFactory } from "./codex-auth.js";
import { createCodexMaintenanceClient } from "./codex-maintenance-client.js";

// Four bounded strings of up to 64 Ki UTF-16 code units may be JSON-escaped.
const MAX_RENEWAL_BYTES = 1_600_000;

const reply = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

/**
 * The private maintenance service's Node adapter. Its deployment must expose
 * fetch only through a service binding or a private transport. AccountCore
 * retains credential storage and commits the result.
 */
export function createNodeAccountRenewalExecutor(options: {
  readonly executable: string;
  readonly refreshRoot: string;
  readonly createClient?: CodexMaintenanceClientFactory;
}): AccountRenewalExecutor & { close(): Promise<void> } {
  const refresh = createManagedCodexRefresh({
    refreshRoot: options.refreshRoot,
    createClient:
      options.createClient ??
      ((codexHome) =>
        createCodexMaintenanceClient({
          executable: options.executable,
          codexHome,
        })),
    deferRecovery: true,
  });
  const active = new Map<string, Promise<Response>>();
  let closing = false;
  let drained: Promise<void> | undefined;

  async function renew(input: AccountRenewalRequest): Promise<Response> {
    try {
      const secret = await refresh(input, input.secret, input.reason);
      return reply(
        parseAccountRenewalResponse({
          status: "renewed",
          upstreamAccountId: input.upstreamAccountId,
          secret: { ...secret, idToken: secret.idToken ?? null },
        }),
      );
    } catch (error) {
      const code = classifyAccountFailure(error, "renewal").diagnostic.code;
      return reply({ status: "failed", code: isAccountRenewalFailure(code) ? code : "renewal-failed" });
    }
  }

  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== ACCOUNT_RENEWAL_PATH || url.search) return reply({ error: "missing" }, 404);
      if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
      if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
        return reply({ error: "invalid_renewal_request" }, 400);

      let input: AccountRenewalRequest;
      try {
        const bytes = await fetchHttpExchange(request).readBody(MAX_RENEWAL_BYTES);
        input = parseAccountRenewalRequest(JSON.parse(decodeUtf8(bytes)));
      } catch (error) {
        return error instanceof HttpBodyTooLarge
          ? reply({ error: "too_large" }, 413)
          : reply({ error: "invalid_renewal_request" }, 400);
      }
      // Refresh tokens can be single-use. Do not start concurrent native reads
      // for one upstream account, including requests whose network peer left.
      if (closing || request.signal.aborted || active.has(input.upstreamAccountId))
        return reply({ error: "maintenance_unavailable" }, 503);
      const operation = renew(input);
      active.set(input.upstreamAccountId, operation);
      try {
        return await operation;
      } finally {
        active.delete(input.upstreamAccountId);
      }
    },
    close() {
      closing = true;
      return (drained ??= Promise.allSettled(active.values()).then(() => undefined));
    },
  };
}
