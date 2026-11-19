import { prepareAnthropicCompaction, anthropicCompactionResponse } from "./anthropic-compaction.js";
import { randomUUID } from "node:crypto";
import { gunzip, brotliDecompress, zstdDecompress } from "node:zlib";
import { promisify } from "node:util";
import { ACCOUNT_POOL_MAX_REQUEST_BYTES } from "./request-limits.js";
import type { ConfiguredCodexResponses } from "./configured-responses.js";
import { AnthropicInputError, anthropicRequest, withPromptCacheBreakpoints, withoutThinkingHistory } from "./anthropic-request.js";
import { responsesPayloadForOpenAI } from "./foreign-history.js";
import { anthropicResponse, anthropicHttpError } from "./anthropic-response.js";

/** Anthropic's verdict for a thinking signature it cannot verify; its own remedy is to resend without them. */
const THINKING_SIGNATURE_REJECTION = /Invalid `signature` in `thinking` block/u;

/** Read a bounded provider error body once so it can be inspected and still reported unchanged. */
async function bufferedError(upstream: Response): Promise<{ response: Response; text: string }> {
  let text = "";
  try {
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    text = bytes.byteLength <= 64 * 1024 ? new TextDecoder().decode(bytes) : "";
  } catch { text = ""; }
  return { text, response: new Response(text, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers }) };
}

const decompressGzip = promisify(gunzip), decompressBrotli = promisify(brotliDecompress), decompressZstd = promisify(zstdDecompress);

export type ConfiguredRoute = NonNullable<Awaited<ReturnType<ConfiguredCodexResponses["resolve"]>>>;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Response headers a Responses client may observe; never upstream cookies or provider internals. */
export function forwardedResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  // Fetch decodes upstream compression before exposing the response body.
  for (const [name, value] of upstream) {
    const lower = name.toLowerCase();
    if (["content-type", "cache-control", "retry-after", "mcp-session-id", "mcp-protocol-version"].includes(lower) || lower.startsWith("x-codex-")) {
      headers.set(lower, value);
    }
  }
  return headers;
}

/** Native Codex may compress Responses bodies. Decoding is bounded by the same request limit. */
export async function decodeResponsesRequestBody(encodingHeader: string | null, body: Uint8Array): Promise<Uint8Array | Response> {
  const encoding = encodingHeader?.toLowerCase() ?? "identity";
  const decompress = encoding === "zstd" ? decompressZstd : encoding === "gzip" ? decompressGzip : encoding === "br" ? decompressBrotli : null;
  if (encoding !== "identity" && !decompress) return Response.json({ error: { message: "Unsupported request encoding" } }, { status: 415 });
  if (!decompress) return body;
  try { return await decompress(body, { maxOutputLength: ACCOUNT_POOL_MAX_REQUEST_BYTES }); }
  catch { return Response.json({ error: { message: "Invalid or oversized encoded request" } }, { status: 400 }); }
}

/**
 * Send one Responses request to an explicitly configured connection. Anthropic Messages connections are
 * translated statelessly; Responses connections pass through. Only this connection's own credential is sent;
 * there is no redirect or fallback to another provider. The only resend is the one Anthropic itself prescribes for
 * an unverifiable thinking signature: the same connection once more, without earlier thinking blocks. `publicModel` is the identifier the caller used.
 */
export async function forwardConfiguredResponses(options: {
  readonly configured: ConfiguredRoute;
  readonly payload: Record<string, unknown>;
  readonly publicModel: string;
  readonly accept: string | null;
  readonly signal: AbortSignal;
  readonly fetch: typeof fetch;
  readonly onDispatch?: () => void;
}): Promise<Response> {
  const { configured, payload } = options;
  const endpoint = new URL(configured.baseUrl);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    return Response.json({ error: { message: "Invalid configured model endpoint" } }, { status: 503 });
  }
  const anthropic = configured.protocol === "anthropic-messages";
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, "") + (anthropic ? "/messages" : "/responses");
  const headers = new Headers({ "content-type": "application/json" });
  if (options.accept) headers.set("accept", options.accept);
  if (configured.apiKey) headers.set(anthropic ? "x-api-key" : "authorization", anthropic ? configured.apiKey : `Bearer ${configured.apiKey}`);
  if (anthropic) headers.set("anthropic-version", "2023-06-01");
  const forwarded: Record<string, unknown> = { ...payload, model: configured.model };
  const reasoning = object(payload.reasoning);
  if (!configured.reasoningEfforts) delete forwarded.reasoning;
  else if (reasoning && typeof reasoning.effort === "string") {
    const effort = reasoning.effort === "none" ? "off" : reasoning.effort;
    if (!Object.hasOwn(configured.reasoningEfforts, effort)) {
      return Response.json({ error: { message: "Unsupported reasoning effort for configured model" } }, { status: 400 });
    }
    const wire = configured.reasoningEfforts[effort];
    if (wire === null) {
      if (anthropic) forwarded.reasoning = { effort: "none" };
      else delete forwarded.reasoning;
    }
    else forwarded.reasoning = { ...reasoning, effort: wire };
  }
  if (!anthropic) {
    const sanitized = responsesPayloadForOpenAI(forwarded);
    if (sanitized) Object.assign(forwarded, sanitized);
  }
  let converted;
  let compacting = false;
  if (anthropic) {
    try {
      const compact = prepareAnthropicCompaction(forwarded);
      compacting = compact !== null;
      converted = anthropicRequest(compact ?? forwarded, configured.maxTokens);
      if (compacting) {
        // Convert historical tool arguments using the original definitions, then prohibit executing tools during summary.
        delete converted.body.tools; delete converted.body.tool_choice;
        delete converted.body.output_config?.format;
      }
      withPromptCacheBreakpoints(converted.body);
    }
    catch (error) {
      if (!(error instanceof AnthropicInputError)) throw error;
      return Response.json({ error: { type: "invalid_request_error", message: error.message } }, { status: 400 });
    }
  }
  options.signal.throwIfAborted();
  options.onDispatch?.();
  const requestId = randomUUID(), startedAt = Date.now();
  const dispatch = (body: unknown) => options.fetch(endpoint, { method: "POST", headers,
    body: JSON.stringify(body), signal: options.signal, redirect: "error" });
  let upstream = await dispatch(converted?.body ?? forwarded);
  if (converted && upstream.status === 400) {
    const rejected = await bufferedError(upstream);
    const stripped = THINKING_SIGNATURE_REJECTION.test(rejected.text) ? withoutThinkingHistory(converted.body) : null;
    if (stripped) {
      console.info(JSON.stringify({ event: "configured-anthropic-thinking-resend", requestId }));
      options.signal.throwIfAborted();
      upstream = await dispatch(stripped);
    } else upstream = rejected.response;
  }
  if (converted) {
    const upstreamRequestId = upstream.headers.get("request-id") ?? upstream.headers.get("x-request-id");
    const observe = (reason: string, diagnostic?: { category: string; keyword?: string }) => console.info(JSON.stringify({ event: "configured-anthropic-terminal", requestId,
      upstreamRequestId: upstreamRequestId && /^[A-Za-z0-9_.:-]{1,200}$/u.test(upstreamRequestId) ? upstreamRequestId : null,
      status: upstream.status, reason, durationMs: Date.now() - startedAt, ...(diagnostic ? { diagnostic } : {}) }));
    if (!upstream.ok) return anthropicHttpError(upstream, configured.apiKey, requestId, diagnostic => observe("upstream_http_error", diagnostic),
      payload.stream === true);
    const response = anthropicResponse(upstream, options.publicModel, converted.tools, !compacting && payload.stream === true, observe);
    return compacting ? anthropicCompactionResponse(response, payload.stream === true) : response;
  }
  return new Response(upstream.body, { status: upstream.status, headers: forwardedResponseHeaders(upstream.headers) });
}
