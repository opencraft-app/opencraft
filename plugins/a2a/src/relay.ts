import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { validHubId } from "@opencraft/hub-network";
import { HttpBodyTooLarge, type HttpExchangeRequest, type HttpExchangeResponse } from "@opencraft/http-exchange";
import { serveNodeHttpExchange } from "@opencraft/http-exchange/node";
import type { RelayIngress } from "@opencraft/relay-server";
import type { OpenRelayHubStream } from "@opencraft/relay-server/application";
import {
  AGENT_CARD_PATH,
  A2A_RPC_PATH,
  A2A_BODY_LIMIT,
  A2A_MAX_ACTIVE,
  a2aOrigin,
  actorBearer,
  duplicateAuthorization,
} from "./server.js";

export interface A2aRelayTarget {
  origin: string;
  gatewayOrigin: string;
  hubId: string;
}
export function parseA2aRelayTarget(value: unknown): A2aRelayTarget {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["origin", "gatewayOrigin", "hubId"].includes(key)) ||
    !("origin" in value) ||
    !("hubId" in value) ||
    !validHubId(value.hubId)
  )
    throw new Error("Invalid A2A relay target");
  const origin = a2aOrigin(value.origin);
  return {
    origin,
    gatewayOrigin: "gatewayOrigin" in value ? a2aOrigin(value.gatewayOrigin) : origin,
    hubId: value.hubId,
  };
}
const empty = (status: number, extra: [string, string][] = []): HttpExchangeResponse => ({
  status,
  headers: [["cache-control", "no-store"], ...extra],
  body: null,
});

/** Two explicit paths to one operator-selected Hub service; no browser identity or cookies are forwarded. */
export function createA2aRelayIngress(configuration: A2aRelayTarget, openStream: OpenRelayHubStream): RelayIngress {
  const target = parseA2aRelayTarget(configuration);
  const publicHost = new URL(target.origin).host,
    gatewayHost = new URL(target.gatewayOrigin).host;
  const lifetime = new AbortController();
  const jobs = new Set<Promise<boolean>>();
  let closing: Promise<void> | undefined;
  async function forward(exchange: HttpExchangeRequest<IncomingMessage>): Promise<HttpExchangeResponse> {
    const card = exchange.path === AGENT_CARD_PATH;
    if (card ? !["GET", "HEAD"].includes(exchange.method) : exchange.method !== "POST")
      return empty(405, [["allow", card ? "GET, HEAD" : "POST"]]);
    const authorization = exchange.headers.authorization;
    if (!card && (!actorBearer(authorization) || duplicateAuthorization(exchange.rawHeaders)))
      return empty(401, [["www-authenticate", "Bearer"]]);
    const signal = AbortSignal.any([exchange.signal, lifetime.signal, AbortSignal.timeout(55_000)]);
    let stream: Awaited<ReturnType<OpenRelayHubStream>> | undefined;
    try {
      let body: Uint8Array | undefined;
      if (!card) {
        const bodySignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
        const stop = () => exchange.identity.destroy();
        bodySignal.addEventListener("abort", stop, { once: true });
        try {
          bodySignal.throwIfAborted();
          body = await exchange.readBody(A2A_BODY_LIMIT);
        } finally {
          bodySignal.removeEventListener("abort", stop);
        }
      }
      signal.throwIfAborted();
      const connection = (stream = await openStream({ hubId: target.hubId, origin: target.gatewayOrigin }, signal));
      signal.throwIfAborted();
      return await new Promise<HttpExchangeResponse>((resolve, reject) => {
        const request = httpRequest(
          {
            method: exchange.method,
            path: exchange.path,
            signal,
            createConnection: () => connection,
            headers: {
              host: gatewayHost,
              connection: "close",
              ...(body
                ? {
                    authorization: authorization!,
                    "content-length": body.length,
                    "content-type": exchange.headers["content-type"] ?? "application/octet-stream",
                  }
                : {}),
            },
          },
          (incoming) => {
            const collect = async () => {
              const chunks: Buffer[] = [];
              let size = 0;
              for await (const chunk of incoming) {
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
                size += bytes.length;
                if (size > 192 * 1024) throw new Error("A2A relay response exceeds limit");
                chunks.push(bytes);
              }
              const headers: [string, string][] = [
                ["cache-control", "no-store"],
                ["x-content-type-options", "nosniff"],
              ];
              for (const name of ["content-type", "www-authenticate", "allow", "retry-after"]) {
                const value = incoming.headers[name];
                if (typeof value === "string") headers.push([name, value]);
              }
              return { status: incoming.statusCode ?? 502, headers, body: Buffer.concat(chunks) };
            };
            void collect().then(resolve, reject);
          },
        );
        request.once("error", reject);
        request.end(body);
      });
    } catch (error) {
      return empty(error instanceof HttpBodyTooLarge ? 413 : 503);
    } finally {
      stream?.destroy();
    }
  }
  return Object.assign(
    (request: IncomingMessage, response: ServerResponse) => {
      if (request.headers.host !== publicHost || (request.url !== AGENT_CARD_PATH && request.url !== A2A_RPC_PATH))
        return false;
      if (lifetime.signal.aborted || jobs.size >= A2A_MAX_ACTIVE) {
        response
          .writeHead(lifetime.signal.aborted ? 503 : 429, {
            "cache-control": "no-store",
            "retry-after": "2",
            connection: "close",
          })
          .end();
        return true;
      }
      const job = serveNodeHttpExchange(request, response, forward);
      jobs.add(job);
      void job.then(
        () => jobs.delete(job),
        () => {
          jobs.delete(job);
          response.destroy();
        },
      );
      return true;
    },
    {
      close(): Promise<void> {
        if (closing) return closing;
        lifetime.abort();
        closing = Promise.allSettled([...jobs]).then(() => {});
        return closing;
      },
    },
  );
}
