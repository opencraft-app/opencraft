import {
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { publicOrigin, validHubId } from "@opencraft/hub-network";
import { identityHeaders, reservedRelayPath, type RelayIngress } from "./server.js";

/** Receiver registered by a gateway's channel transport (see plugins/im channel-sync). */
export const CHANNEL_CALLBACK_RECEIVER_PREFIX = "/__opencraft_im/channel-callback/";
const MAX_BODY = 1024 * 1024,
  MAX_ACTIVE = 128,
  DEFAULT_TIMEOUT_MS = 10_000;

export interface ChannelCallbackTarget {
  /** Public pathname on every relay Host; the query string is forwarded unchanged. */
  path: string;
  /** Gateway transport id, forwarded to `/__opencraft_im/channel-callback/<provider>`. */
  provider: string;
  hubId: string;
  origin: string;
  /** Whole-exchange budget; set it below the provider's own callback deadline. */
  timeoutMs: number;
}
export type OpenChannelHubStream = (target: { hubId: string; origin: string }, signal: AbortSignal) => Promise<Duplex>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseChannelCallbacks(value: unknown): ChannelCallbackTarget[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) throw new Error("Invalid channel callbacks");
  const paths = new Set<string>();
  return value.map((entry) => {
    if (
      !record(entry) ||
      Object.keys(entry).some((key) => !["path", "provider", "hubId", "origin", "timeoutMs"].includes(key)) ||
      typeof entry.path !== "string" ||
      !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,255}$/u.test(entry.path) ||
      entry.path.includes("//") ||
      reservedRelayPath(entry.path) ||
      entry.path.startsWith("/__opencraft_") ||
      paths.has(entry.path) ||
      typeof entry.provider !== "string" ||
      !/^[a-z0-9_-]{1,64}$/u.test(entry.provider) ||
      !validHubId(entry.hubId) ||
      (entry.timeoutMs !== undefined &&
        (!Number.isSafeInteger(entry.timeoutMs) || Number(entry.timeoutMs) < 1000 || Number(entry.timeoutMs) > 60_000))
    )
      throw new Error("Invalid channel callback");
    paths.add(entry.path);
    return {
      path: entry.path,
      provider: entry.provider,
      hubId: entry.hubId,
      origin: publicOrigin(entry.origin),
      timeoutMs: Number(entry.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    };
  });
}

/**
 * Provider signatures may live in the query, body or headers, so end-to-end
 * headers pass. Relay credentials, browser cookies, forwarding claims and
 * enterprise identity headers never cross to the gateway.
 */
export function channelCallbackHeaders(input: IncomingHttpHeaders): OutgoingHttpHeaders {
  const connection = new Set(
    String(input.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((token) => token.trim()),
  );
  const output: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      value === undefined ||
      connection.has(key) ||
      identityHeaders.has(key) ||
      key.startsWith("x-opencraft-") ||
      key.startsWith("x-forwarded-") ||
      [
        "host",
        "forwarded",
        "x-real-ip",
        "cookie",
        "authorization",
        "proxy-authorization",
        "proxy-authenticate",
        "connection",
        "keep-alive",
        "upgrade",
        "te",
        "trailer",
        "transfer-encoding",
        "content-length",
        "expect",
        "origin",
      ].includes(key)
    )
      continue;
    output[key] = value;
  }
  return output;
}

function readBody(req: IncomingMessage, signal: AbortSignal) {
  return new Promise<Buffer | null>((resolve, reject) => {
    if (Number(req.headers["content-length"]) > MAX_BODY) {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const settle = (finish: () => void) => {
      req.off("data", data);
      req.off("end", end);
      req.off("close", closed);
      signal.removeEventListener("abort", aborted);
      req.pause();
      finish();
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) settle(() => resolve(null));
      else chunks.push(chunk);
    };
    const end = () => settle(() => resolve(Buffer.concat(chunks)));
    const closed = () => settle(() => reject(new Error("Callback request closed")));
    const aborted = () => settle(() => reject(signal.reason));
    // Persistent: a late error after settling must not become unhandled.
    req.on("error", () => {});
    if (signal.aborted) {
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    req.on("data", data);
    req.once("end", end);
    req.once("close", closed);
  });
}

/**
 * Forwards provider webhooks for configured paths over the Hub stream to the
 * gateway that owns the channel. The body is bounded and buffered so a
 * failure before the gateway answers is a clean 503; the gateway verifies the
 * provider signature and answers, and only status, type and body return.
 */
export function createChannelCallbackIngress(
  targets: readonly ChannelCallbackTarget[],
  openHubStream: OpenChannelHubStream,
): RelayIngress {
  const byPath = new Map(targets.map((target) => [target.path, target]));
  const active = new Set<AbortController>(),
    pending = new Set<Promise<void>>();
  let closed = false;

  async function forward(target: ChannelCallbackTarget, req: IncomingMessage, res: ServerResponse, query: string) {
    const lifecycle = new AbortController();
    active.add(lifecycle);
    const signal = AbortSignal.any([lifecycle.signal, AbortSignal.timeout(target.timeoutMs)]);
    let stream: Duplex | undefined;
    const fail = (status: number) => {
      stream?.destroy();
      if (res.destroyed) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(status, { "cache-control": "no-store", connection: "close" });
      res.end();
    };
    res.once("close", () => lifecycle.abort());
    try {
      const body = await readBody(req, signal);
      if (body === null) {
        fail(413);
        return;
      }
      stream = await openHubStream(target, signal);
      signal.throwIfAborted();
      const opened = stream;
      await new Promise<void>((resolve, reject) => {
        const upstream = request(
          {
            method: "POST",
            path: CHANNEL_CALLBACK_RECEIVER_PREFIX + target.provider + query,
            signal,
            createConnection: () => opened,
            headers: {
              ...channelCallbackHeaders(req.headers),
              host: new URL(target.origin).host,
              "content-length": String(body.length),
              connection: "close",
            },
          },
          (incoming) => {
            if (res.destroyed) {
              incoming.destroy();
              resolve();
              return;
            }
            const headers: OutgoingHttpHeaders = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
            if (incoming.headers["content-type"]) headers["content-type"] = incoming.headers["content-type"];
            res.writeHead(incoming.statusCode ?? 502, headers);
            incoming.once("error", reject);
            incoming.once("aborted", () => reject(new Error("Gateway response aborted")));
            res.once("close", () => resolve());
            incoming.pipe(res);
          },
        );
        upstream.once("error", reject);
        upstream.end(body);
      });
    } catch {
      fail(503);
    } finally {
      active.delete(lifecycle);
      stream?.destroy();
    }
  }

  const ingress: RelayIngress = (req, res) => {
    const url = req.url ?? "",
      mark = url.indexOf("?"),
      path = mark < 0 ? url : url.slice(0, mark);
    const target = byPath.get(path);
    if (!target) return false;
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST", "cache-control": "no-store" });
      res.end();
      return true;
    }
    if (closed || active.size >= MAX_ACTIVE) {
      res.writeHead(503, { "cache-control": "no-store", connection: "close" });
      res.end();
      return true;
    }
    const job = forward(target, req, res, mark < 0 ? "" : url.slice(mark));
    pending.add(job);
    void job.finally(() => pending.delete(job));
    return true;
  };
  ingress.close = async () => {
    closed = true;
    for (const controller of active) controller.abort();
    await Promise.allSettled([...pending]);
  };
  return ingress;
}
