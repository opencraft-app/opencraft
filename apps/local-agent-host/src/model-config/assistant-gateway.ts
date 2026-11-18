import { configuredModelGatewayPath, requiresModelGateway, bindModelGatewaySponsor, meteredModelRequest, ModelGatewayError } from "@opencraft/account-pool-host";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import {
  ACCOUNT_POOL_MAX_REQUEST_BYTES,
  decodeResponsesRequestBody,
  forwardConfiguredResponses,
  type ConfiguredRoute,
} from "@opencraft/account-pool-host";
import type { EngineModelReference } from "./engine-models.js";
import {
  AssistantModelAdmission,
  ModelAdmissionDeferred,
  backgroundPurpose,
  type AssistantModelPurpose,
  type ModelWait,
} from "./assistant-admission.js";

export type GatewayRouteResolver = (
  reference: EngineModelReference,
) => Promise<ConfiguredRoute & { quotaKey?: string }>;
export interface AssistantModelContext {
  /** Verified human from the Host assignment, never runtime RPC parameters. */
  humanActorId?: string;
  scope?: string;
  purpose?: AssistantModelPurpose;
  authorize?: () => Promise<void>;
}
interface Binding {
  humanActorId?: string;
  reference: EngineModelReference;
  scope: string;
  purpose: AssistantModelPurpose;
  token: string;
  authorize?: () => Promise<void>;
  usedAt: number;
  failure?: {
    httpStatus: 429;
    kind: "rate_limit" | "quota_exhausted";
    retryAt: number;
    at: number;
  };
}
/** One installation source owns admission and all assistant protocol routes. HTTP 429 retries occur
 * before content delivery, never by restarting a turn or executing business commands again. */
export function createAssistantModelGateway(
  resolveRoute: GatewayRouteResolver,
  options: {
    fetch?: typeof fetch;
    requestTimeoutMs?: number;
    maxAttempts?: number;
    admission?: AssistantModelAdmission;
  } = {},
) {
  const token = randomBytes(32).toString("hex"),
    upstreamFetch = options.fetch ?? fetch,
    admission = options.admission ?? new AssistantModelAdmission();
  const bindings = new Map<string, Binding>(),
    routes = new Map<string, Binding>();
  const requests = new Map<
    object,
    { binding: Binding; wait: ModelWait | null; abort: AbortController }
  >();
  let listening: Promise<string> | undefined,
    server: ReturnType<typeof createServer> | undefined,
    closed = false;
  const sameToken = (a: string | undefined, b: string) => {
    const x = Buffer.from(a ?? ""),
      y = Buffer.from("Bearer " + b);
    return x.length === y.length && timingSafeEqual(x, y);
  };
  async function send(response: ServerResponse, result: Response) {
    response.writeHead(result.status, Object.fromEntries(result.headers));
    if (!result.body) {
      response.end();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const body = Readable.fromWeb(
        result.body as import("node:stream/web").ReadableStream,
      );
      const cleanup = () => {
        response.removeListener("close", close);
        body.removeListener("error", error);
      };
      const close = () => {
        cleanup();
        body.destroy();
        resolve();
      };
      const error = () => {
        cleanup();
        response.destroy();
        reject(Error("Assistant model stream failed"));
      };
      body.once("error", error);
      response.once("close", close);
      body.pipe(response);
    });
  }
  function bindingFor(path: string) {
    const scoped = routes.get(path);
    if (scoped) return scoped;
    const match = /^\/routes\/([^/]+)\/([^/]+)\/v1\/responses$/u.exec(path);
    if (!match) return;
    try {
      return getBinding(
        {
          providerId: decodeURIComponent(match[1]!),
          modelId: decodeURIComponent(match[2]!),
        },
        {},
      ).binding;
    } catch {
      return;
    }
  }
  function getBinding(
    reference: EngineModelReference,
    context: AssistantModelContext,
  ) {
    const scope = context.scope ?? "operator",
      purpose = context.purpose ?? "reception",
      privateContext = context.scope !== undefined || purpose !== "reception",
      key = JSON.stringify([
        scope,
        context.humanActorId ?? null,
        purpose,
        reference.providerId,
        reference.modelId,
      ]);
    let binding = bindings.get(key);
    if (!binding) {
      if (bindings.size >= 512) {
        const active = new Set([...requests.values()].map((r) => r.binding));
        const old = [...bindings]
          .filter(([, b]) => !active.has(b))
          .sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
        if (!old) throw Error("Assistant model binding capacity");
        bindings.delete(old[0]);
        for (const [p, b] of routes) if (b === old[1]) routes.delete(p);
      }
      binding = {
        reference: { ...reference },
        humanActorId: context.humanActorId,
        scope,
        purpose,
        token: privateContext ? randomBytes(32).toString("hex") : token,
        authorize: context.authorize,
        usedAt: Date.now(),
      };
      bindings.set(key, binding);
      const root = `/routes/${encodeURIComponent(reference.providerId)}/${encodeURIComponent(reference.modelId)}`;
      const path = privateContext
        ? root +
          "/contexts/" +
          randomBytes(18).toString("hex") +
          "/v1/responses"
        : root + "/v1/responses";
      routes.set(path, binding);
    }
    binding.usedAt = Date.now();
    if (context.authorize) binding.authorize = context.authorize;
    const path = [...routes].find(([, b]) => b === binding)![0];
    return { binding, path };
  }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const json = (status: number, message: string, retryAt?: number) =>
      send(
        response,
        Response.json(
          { error: { message } },
          {
            status,
            headers: retryAt
              ? {
                  "retry-after": String(
                    Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)),
                  ),
                }
              : undefined,
          },
        ),
      );
    const pathname = new URL(request.url ?? "/", "http://gateway").pathname;
    // Do not resolve arbitrary model references for an unauthenticated visitor.
    let binding = routes.get(pathname);
    if (!binding && sameToken(request.headers.authorization, token))
      binding = bindingFor(pathname);
    if (!binding || !sameToken(request.headers.authorization, binding.token)) {
      response.writeHead(401).end();
      request.resume();
      return;
    }
    if (request.method !== "POST") {
      request.resume();
      return json(404, "Assistant model route not found");
    }
    if (requests.size >= 64) {
      request.resume();
      return json(
        429,
        "Assistant model request capacity reached",
        Date.now() + 2000,
      );
    }
    const deadlineAt = Date.now() + (options.requestTimeoutMs ?? 30000);
    const abort = new AbortController(),
      deadline = setTimeout(
        () =>
          abort.abort(
            Object.assign(Error("Assistant model request deadline"), {
              code: "MODEL_REQUEST_DEADLINE",
            }),
          ),
        options.requestTimeoutMs ?? 30000,
      );
    const entry = { binding, wait: null as ModelWait | null, abort };
    requests.set(entry, entry);
    response.once("close", () => {
      if (!response.writableFinished) abort.abort();
    });
    try {
      await binding.authorize?.();
      abort.signal.throwIfAborted();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > ACCOUNT_POOL_MAX_REQUEST_BYTES)
          return await json(413, "Request too large");
        chunks.push(chunk as Buffer);
      }
      const decoded = await decodeResponsesRequestBody(
        request.headers["content-encoding"] ?? null,
        new Uint8Array(Buffer.concat(chunks)),
      );
      if (decoded instanceof Response) return await send(response, decoded);
      let payload: Record<string, unknown>;
      try {
        const value = JSON.parse(new TextDecoder().decode(decoded));
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw Error();
        payload = value;
      } catch {
        return await json(400, "Invalid Responses request");
      }
      for (let attempt = 1; ; attempt++) {
        await binding.authorize?.();
        abort.signal.throwIfAborted();
        const configured = await resolveRoute(binding.reference),
          key = configured.quotaKey ?? binding.reference.providerId;
        let release: (() => void) | undefined;
        try {
          release = await admission.acquire(key, {
            owner: binding.scope,
            purpose: binding.purpose,
            signal: abort.signal,
            deadlineAt,
            observe: (wait) => {
              entry.wait = wait;
            },
          });
          // A queued request must not dispatch with a connection or grant captured before its wait.
          await binding.authorize?.();
          abort.signal.throwIfAborted();
          const current = await resolveRoute(binding.reference);
          if ((current.quotaKey ?? binding.reference.providerId) !== key)
            throw Error("Assistant model connection changed");
          const sendModel = (onDispatch?: () => void) => forwardConfiguredResponses({
            configured: current,
            payload,
            publicModel:
              typeof payload.model === "string" ? payload.model : current.model,
            accept:
              typeof request.headers.accept === "string"
                ? request.headers.accept
                : null,
            signal: abort.signal,
            fetch: upstreamFetch,
            onDispatch,
          });
          const path = configuredModelGatewayPath();
          const gatewayPath = requiresModelGateway("configured/"+encodeURIComponent(binding.reference.providerId)+"/"+encodeURIComponent(binding.reference.modelId),path) ? path : undefined;
          const budgetThread = "assistant:" + binding.scope;
          if (gatewayPath) bindModelGatewaySponsor(budgetThread, binding.humanActorId ?? null, undefined, gatewayPath);
          const result = gatewayPath ? await meteredModelRequest({path:gatewayPath,thread:budgetThread,model:"configured/"+encodeURIComponent(binding.reference.providerId)+"/"+encodeURIComponent(binding.reference.modelId),signal:abort.signal,
            send: dispatch => sendModel(() => dispatch(binding.reference.providerId))}) : await sendModel();
          await binding.authorize?.();
          abort.signal.throwIfAborted();
          if (result.status !== 429) {
            clearTimeout(deadline);
            if (result.ok) {
              admission.success(key);
              binding.failure = undefined;
            }
            return await send(response, result);
          }
          let quotaExhausted = false;
          if (result.body) {
            const reader = result.body.getReader();
            try {
              let size = 0,
                text = "";
              const decoder = new TextDecoder();
              for (;;) {
                const part = await reader.read();
                if (part.done) break;
                size += part.value.byteLength;
                if (size > 8192) break;
                text += decoder.decode(part.value, { stream: true });
              }
              const e = JSON.parse(text)?.error;
              quotaExhausted = [e?.code, e?.type].some(
                (v) => v === "insufficient_quota" || v === "quota_exhausted",
              );
            } catch {
            } finally {
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          }
          if (quotaExhausted) {
            binding.failure = {
              httpStatus: 429,
              kind: "quota_exhausted",
              retryAt: 0,
              at: Date.now(),
            };
            return await json(429, "Assistant model quota is exhausted");
          }
          const retryAt = admission.cooldown(
            key,
            result.headers.get("retry-after"),
          );
          binding.failure = {
            httpStatus: 429,
            kind: "rate_limit",
            retryAt,
            at: Date.now(),
          };
          console.info(
            JSON.stringify({
              event: "assistant-model-rate-limit",
              purpose: binding.purpose,
              attempt,
              retryAt,
            }),
          );
          // Provider bodies remain private. Do not retry after emitting any headers/content to Codex.
          await result.body?.cancel();
          release();
          release = undefined;
          if (
            backgroundPurpose(binding.purpose) ||
            attempt >= (options.maxAttempts ?? 3) ||
            retryAt >= deadlineAt
          )
            return await json(429, "Assistant model service is busy", retryAt);
          entry.wait = { reason: "rate_limit", retryAt };
        } catch (error) {
          if (error instanceof ModelAdmissionDeferred) {
            binding.failure = {
              httpStatus: 429,
              kind: "rate_limit",
              retryAt: error.retryAt,
              at: Date.now(),
            };
            return await json(
              429,
              "Assistant model request deferred",
              error.retryAt,
            );
          }
          abort.abort(error);
          throw error;
        } finally {
          release?.();
        }
      }
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        if (error instanceof ModelGatewayError) { await json(error.status,error.kind); return; }
        const busy =
          (abort.signal.reason as { code?: string } | undefined)?.code ===
            "MODEL_REQUEST_DEADLINE" &&
          binding.failure &&
          binding.failure.at > Date.now() - 60000;
        await json(
          busy ? 429 : 503,
          busy
            ? "Assistant model service is busy"
            : "Assistant model connection is unavailable",
          busy ? binding.failure?.retryAt : undefined,
        );
      } else response.destroy();
    } finally {
      clearTimeout(deadline);
      requests.delete(entry);
    }
  }
  async function origin() {
    if (closed) throw Error("Assistant model source closed");
    listening ??= new Promise<string>((resolve, reject) => {
      server = createServer((req, res) => {
        void handle(req, res).catch(() => res.destroy());
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server!.unref();
        const a = server!.address();
        resolve(typeof a === "object" && a ? `http://127.0.0.1:${a.port}` : "");
      });
    });
    return listening;
  }
  return {
    token,
    async connection(
      reference: EngineModelReference,
      context: AssistantModelContext = {},
    ) {
      const { binding, path } = getBinding(reference, context);
      return {
        baseUrl: (await origin()) + path.slice(0, -"/responses".length),
        apiKey: binding.token,
      };
    },
    async baseUrl(reference: EngineModelReference) {
      return (await this.connection(reference)).baseUrl;
    },
    activity(scope: string): ModelWait | undefined {
      return (
        [...requests.values()].find(
          (r) =>
            r.binding.scope === scope &&
            !backgroundPurpose(r.binding.purpose) &&
            r.binding.purpose !== "execution" &&
            r.wait,
        )?.wait ?? undefined
      );
    },
    failure(scope: string, purpose: AssistantModelPurpose) {
      const b = [...bindings.values()].find(
        (b) =>
          b.scope === scope &&
          b.purpose === purpose &&
          b.failure &&
          b.failure.at > Date.now() - 60000,
      );
      return b?.failure
        ? {
            httpStatus: 429 as const,
            kind: b.failure.kind,
            retryAt: b.failure.retryAt,
          }
        : undefined;
    },
    async close() {
      closed = true;
      admission.close();
      for (const r of requests.values()) r.abort.abort();
      const current = server;
      server = undefined;
      listening = undefined;
      if (!current) return;
      current.closeAllConnections();
      await new Promise<void>((resolve) => current.close(() => resolve()));
      bindings.clear();
      routes.clear();
    },
  };
}
