import { Service } from "@deepseek-ai/cordis";
import { utf8Decode as decode, utf8Encode as encode } from "../runtime/bytes.ts";
import {
  ChatStreamTranslator,
  OpaqueCodexHistoryError,
  chatResponseRetryCandidate,
  retryChatRequest,
  responsesToChat,
  translateChatResponse,
} from "./model-gateway-translate.js";
import {
  OPENAI_COMPLETIONS,
  OPENAI_RESPONSES,
  sanitizeNativeResponseIds,
  sanitizeNativeResponsesBody,
} from "./model-provider-protocol.ts";
import {
  decideNativeFinish,
  nativeFinalResponse,
  nativeFinalSSE,
  parseNativeTerminalSSE,
  prepareNativeFinishRequest,
  retryNativeFinishRequest,
} from "./model-native-finish.js";
import { addSpanEvent, endSpan, startSpan } from "../runtime/telemetry.ts";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_INTERNAL_CONTINUATIONS = 32;
const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
  "expect",
]);

function transparentRequestHeaders(headers = {}) {
  const output = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value == null || HOP_BY_HOP_HEADERS.has(String(name).toLowerCase())) continue;
    output[name] = String(value);
  }
  return output;
}

function endpointForLog(value) {
  return String(value ?? "")
    .split(/[?#]/, 1)[0]
    .replace(/^(https?:\/\/)[^/@\s]+@/i, "$1<redacted>@")
    .slice(0, 512);
}

function concat(left, right) {
  const output = new Uint8Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}

function indexOf(bytes, sequence) {
  outer: for (let index = 0; index <= bytes.length - sequence.length; index += 1) {
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (bytes[index + offset] !== sequence[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function reason(status) {
  return ({
    200: "OK", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found",
    405: "Method Not Allowed", 502: "Bad Gateway",
  })[status] ?? "Error";
}

function response(status, body, contentType = "application/json; charset=utf-8") {
  const payload = encode(body);
  return concat(encode([
    `HTTP/1.1 ${status} ${reason(status)}`,
    `Content-Type: ${contentType}`,
    `Content-Length: ${payload.length}`,
    "Cache-Control: no-store",
    "Connection: close",
    "",
    "",
  ].join("\r\n")), payload);
}

function errorResponse(status, message) {
  return response(status, JSON.stringify({ error: { message, type: "invalid_request_error" } }));
}

function streamHead() {
  return encode([
    "HTTP/1.1 200 OK",
    "Content-Type: text/event-stream",
    "Cache-Control: no-cache",
    "X-Accel-Buffering: no",
    "Connection: close",
    "",
    "",
  ].join("\r\n"));
}

function continueResponse() {
  return encode("HTTP/1.1 100 Continue\r\n\r\n");
}

function failedResponse(message, connectionId) {
  return {
    id: `resp_hypernode_${String(connectionId ?? "gateway").replace(/[^A-Za-z0-9_-]/g, "_")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "failed",
    background: false,
    error: { code: "invalid_prompt", message },
    incomplete_details: null,
    output: [],
    usage: null,
    metadata: {},
  };
}

function terminalCompatibilityFailure(message, connectionId, stream) {
  const failed = failedResponse(message, connectionId);
  if (!stream) return response(200, JSON.stringify(failed));
  const event = { type: "response.failed", sequence_number: 1, response: failed };
  return concat(streamHead(), encode(`event: response.failed\ndata: ${JSON.stringify(event)}\n\n`));
}

function requestWantsStream(body) {
  try {
    return JSON.parse(body)?.stream === true;
  } catch {
    return false;
  }
}

function nativeResponsesTerminal(value) {
  return /(?:^|\n)event:\s*response\.(?:completed|failed|incomplete)\s*(?:\r?\n|$)/.test(value)
    || /"type"\s*:\s*"response\.(?:completed|failed|incomplete)"/.test(value);
}

function chatCompletionsTerminal(value) {
  return /(?:^|\n)data:\s*\[DONE\]\s*(?:\r?\n|$)/.test(value);
}

function sanitizeNativeSSEFrame(frame) {
  let repairs = 0;
  const lines = frame.split(/\r?\n/).map((line) => {
    if (!line.startsWith("data:")) return line;
    const prefix = line.match(/^data:\s*/)?.[0] ?? "data: ";
    const payload = line.slice(prefix.length);
    try {
      const sanitized = sanitizeNativeResponseIds(JSON.parse(payload));
      repairs += sanitized.repairs;
      return sanitized.repairs > 0 ? `${prefix}${JSON.stringify(sanitized.value)}` : line;
    } catch {
      return line;
    }
  });
  return { frame: lines.join("\n"), repairs };
}

function normalizeNativeSSE(state, chunkBytes, closed = false) {
  state.nativeSSEBytes = concat(state.nativeSSEBytes, chunkBytes);
  let output = new Uint8Array();
  for (;;) {
    const lf = indexOf(state.nativeSSEBytes, encode("\n\n"));
    const crlf = indexOf(state.nativeSSEBytes, encode("\r\n\r\n"));
    const at = lf < 0 ? crlf : crlf < 0 ? lf : Math.min(lf, crlf);
    if (at < 0) break;
    const delimiterLength = at === crlf ? 4 : 2;
    const frameBytes = state.nativeSSEBytes.slice(0, at);
    state.nativeSSEBytes = state.nativeSSEBytes.slice(at + delimiterLength);
    const normalized = sanitizeNativeSSEFrame(decode(frameBytes));
    state.nativeIdRepairs += normalized.repairs;
    output = concat(output, encode(`${normalized.frame}\n\n`));
  }
  if (closed && state.nativeSSEBytes.length > 0) {
    const normalized = sanitizeNativeSSEFrame(decode(state.nativeSSEBytes));
    state.nativeIdRepairs += normalized.repairs;
    output = concat(output, encode(normalized.frame));
    state.nativeSSEBytes = new Uint8Array();
  }
  return output;
}

function parseRequest(bytes) {
  const marker = encode("\r\n\r\n");
  const end = indexOf(bytes, marker);
  if (end < 0) return null;
  const lines = decode(bytes.slice(0, end)).split("\r\n");
  const [method, target] = String(lines.shift() ?? "").split(" ");
  const headers = {};
  for (const line of lines) {
    const at = line.indexOf(":");
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  const length = Number(headers["content-length"] ?? 0);
  if (!Number.isInteger(length) || length < 0 || length > MAX_REQUEST_BYTES) {
    throw new Error("invalid content-length");
  }
  const bodyStart = end + marker.length;
  if (bytes.length < bodyStart + length) {
    return { method, target, headers, body: null, bodyComplete: false };
  }
  return {
    method,
    target,
    headers,
    body: decode(bytes.slice(bodyStart, bodyStart + length)),
    bodyComplete: true,
  };
}

export class ModelGatewayIngressService extends Service {
  constructor(ctx) {
    super(ctx, "modelGatewayIngress");
    this.connections = new Map();
  }

  open(metadata) {
    this.connections.set(metadata.connectionId, {
      bytes: new Uint8Array(), requestId: null, stream: false, translator: null,
      providerId: null, upstreamStatus: 0, upstreamBody: "", headersSent: false,
      upstreamBodyBytes: new Uint8Array(), nativeTerminalProbe: "", nativeTerminalSeen: false,
      nativeSSEBytes: new Uint8Array(), nativeIdRepairs: 0, sanitizeResponseIds: false,
      nativeAttemptBytes: new Uint8Array(), internalFinishTool: false,
      passthrough: false, passthroughKind: null,
      continueSent: false, done: false, upstream: null, upstreamAttempt: 0,
      telemetry: null, apiProtocol: null,
    });
    return { allow: true, stdoutBytes: [] };
  }

  data(metadata) {
    const state = this.connections.get(metadata.connectionId);
    if (!state || state.done) return { allow: false };
    state.bytes = concat(state.bytes, Uint8Array.from(metadata.dataBytes ?? []));
    if (state.bytes.length > MAX_REQUEST_BYTES) return this.fail(state, 400, "request too large");
    let request;
    try {
      request = parseRequest(state.bytes);
    } catch (error) {
      return this.fail(state, 400, error.message ?? String(error));
    }
    if (!request) return { allow: true, stdoutBytes: [] };
    if (request.method === "GET" && request.target === "/healthz") {
      return this.complete(state, response(200, JSON.stringify({ ok: true, runtime: "cordis" })));
    }
    const routeMatch = String(request.target ?? "")
      .match(/^\/providers\/([^/?#]+)\/v1\/(responses|chat\/completions)(?:\?.*)?$/);
    const providerId = routeMatch?.[1];
    const operation = routeMatch?.[2];
    if (request.method !== "POST" || !providerId) {
      const target = String(request.target ?? "").slice(0, 512);
      console.warn(`[model-gateway] rejected route method=${request.method} target=${target}`);
      return this.fail(state, 404, `model gateway route not found: ${request.method} ${target}`);
    }
    const authorization = request.headers.authorization;
    if (!authorization) return this.fail(state, 401, "missing Authorization header");
    const route = this.ctx.modelGateway.resolveGatewayRoute(decodeURIComponent(providerId));
    if (!route) return this.fail(state, 404, "unknown HyperNode model provider");
    if (!request.bodyComplete) {
      if (request.headers.expect?.toLowerCase() === "100-continue" && !state.continueSent) {
        state.continueSent = true;
        return { allow: true, sensitive: true, stdoutBytes: continueResponse() };
      }
      return { allow: true, sensitive: true, stdoutBytes: [] };
    }
    try {
      if (operation === "chat/completions") {
        if (route.apiProtocol !== OPENAI_COMPLETIONS) {
          return this.fail(state, 400, "model provider is not configured for Chat Completions");
        }
        state.stream = requestWantsStream(request.body);
        state.providerId = providerId;
        state.apiProtocol = route.apiProtocol;
        state.passthrough = true;
        state.passthroughKind = "chat";
        state.upstream = {
          method: "POST",
          url: route.endpoint,
          headers: {
            ...transparentRequestHeaders(request.headers),
            authorization,
            "content-type": request.headers["content-type"] || "application/json",
            accept: request.headers.accept || (state.stream ? "text/event-stream" : "application/json"),
          },
          // Pi AI owns the Chat dialect.  HyperNode deliberately does not
          // parse, rewrite, retry, or synthesize a terminal response here.
          body: request.body,
        };
        this.openUpstream(state, metadata.connectionId, request.body);
        state.bytes = new Uint8Array();
        return { allow: true, sensitive: true, stdoutBytes: [] };
      }
      if (route.apiProtocol === OPENAI_RESPONSES) {
        const contractedBody = route.internalFinishTool
          ? prepareNativeFinishRequest(request.body)
          : request.body;
        const prepared = route.sanitizeResponseIds
          ? sanitizeNativeResponsesBody(contractedBody)
          : { body: contractedBody, repairs: 0 };
        state.stream = requestWantsStream(request.body);
        state.providerId = providerId;
        state.apiProtocol = route.apiProtocol;
        state.passthrough = true;
        state.passthroughKind = "responses";
        state.internalFinishTool = route.internalFinishTool === true;
        state.sanitizeResponseIds = route.sanitizeResponseIds === true;
        state.nativeIdRepairs += prepared.repairs;
        state.upstream = {
          method: "POST",
          url: route.endpoint,
          headers: {
            Authorization: authorization,
            "Content-Type": request.headers["content-type"] || "application/json",
            Accept: request.headers.accept || (state.stream ? "text/event-stream" : "application/json"),
            ...(request.headers["openai-organization"]
              ? { "OpenAI-Organization": request.headers["openai-organization"] }
              : {}),
          },
          body: prepared.body,
        };
        this.openUpstream(state, metadata.connectionId, prepared.body);
        state.bytes = new Uint8Array();
        return { allow: true, sensitive: true, stdoutBytes: [] };
      }
      const modalities = Array.isArray(route.inputModalities) && route.inputModalities.length > 0
        ? route.inputModalities
        : (this.ctx.modelMetadata?.inputModalitiesForRecord?.(route) ?? ["text"]);
      const translated = responsesToChat(request.body, {
        // This is an ephemeral wire projection only. The authoritative DSH
        // ledger keeps its durable image attachments, so switching back to a
        // vision-capable provider remains lossless.
        supportsImages: modalities.includes("image"),
      });
      if (translated.toolTranscriptRepairs > 0) {
        console.info(
          `[model-gateway] repaired incomplete tool transcript provider=${providerId} ` +
          `count=${translated.toolTranscriptRepairs}`,
        );
      }
      state.stream = translated.stream;
      state.providerId = providerId;
      state.apiProtocol = route.apiProtocol;
      state.translator = translated.stream ? new ChatStreamTranslator(translated.codec) : translated.codec;
      state.upstream = {
        method: "POST",
        url: route.endpoint,
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          Accept: translated.stream ? "text/event-stream" : "application/json",
          ...(request.headers["openai-organization"]
            ? { "OpenAI-Organization": request.headers["openai-organization"] }
            : {}),
        },
        body: translated.body,
      };
      this.openUpstream(state, metadata.connectionId, translated.body);
      state.bytes = new Uint8Array();
      return { allow: true, sensitive: true, stdoutBytes: [] };
    } catch (error) {
      if (error instanceof OpaqueCodexHistoryError) {
        return this.complete(state, terminalCompatibilityFailure(
          error.message,
          metadata.connectionId,
          requestWantsStream(request.body),
        ));
      }
      return this.fail(state, 400, error.message ?? String(error));
    }
  }

  poll(metadata) {
    const state = this.connections.get(metadata.connectionId);
    if (!state) return { allow: false };
    if (state.done) return { allow: false };
    if (!state.requestId) return { allow: true, stdoutBytes: [] };
    let drained;
    try {
      drained = this.ctx.httpClient.drain(state.requestId);
    } catch (error) {
      return this.fail(state, 502, "model provider request failed");
    }
    if (Number(drained.status) > 0) state.upstreamStatus = Number(drained.status);
    const chunkBytes = Uint8Array.from(drained.dataBytes ?? []);
    this.recordDrain(state, chunkBytes, drained);
    const chunk = decode(chunkBytes);
    if (state.passthroughKind === "chat" && state.upstreamStatus >= 200 &&
      state.upstreamStatus < 300 && state.stream) {
      let output = new Uint8Array();
      if (!state.headersSent) {
        state.headersSent = true;
        output = streamHead();
      }
      if (chunkBytes.length > 0) {
        output = concat(output, chunkBytes);
        const probe = `${state.nativeTerminalProbe}${chunk}`;
        state.nativeTerminalSeen ||= chatCompletionsTerminal(probe);
        state.nativeTerminalProbe = probe.slice(-8192);
      }
      if (state.nativeTerminalSeen || drained.closed) {
        this.closeUpstream(state);
        state.done = true;
        this.finishTelemetry(state, "ok", {
          "http.response.status_code": state.upstreamStatus,
          "hypernode.gateway.terminal_seen": state.nativeTerminalSeen,
        });
        return { allow: true, sensitive: true, stdoutBytes: output, closeAfterWrite: true };
      }
      return { allow: true, sensitive: true, stdoutBytes: output };
    }
    if (state.passthrough && state.upstreamStatus >= 200 && state.upstreamStatus < 300 && state.stream) {
      let output = new Uint8Array();
      if (!state.internalFinishTool && !state.headersSent) {
        state.headersSent = true;
        output = streamHead();
      }
      const forwarded = state.sanitizeResponseIds
        ? normalizeNativeSSE(state, chunkBytes, drained.closed)
        : chunkBytes;
      if (state.internalFinishTool) {
        if (forwarded.length > 0) {
          state.nativeAttemptBytes = concat(state.nativeAttemptBytes, forwarded);
        }
      } else if (forwarded.length > 0) {
        output = concat(output, forwarded);
      }
      if (forwarded.length > 0) {
        const probe = `${state.nativeTerminalProbe}${decode(forwarded)}`;
        state.nativeTerminalSeen ||= nativeResponsesTerminal(probe);
        state.nativeTerminalProbe = probe.slice(-8192);
      }
      if (state.nativeTerminalSeen || drained.closed) {
        if (state.internalFinishTool) {
          const terminal = parseNativeTerminalSSE(decode(state.nativeAttemptBytes));
          const decision = decideNativeFinish(terminal?.response);
          if (terminal?.type === "response.completed" && decision.kind === "retry") {
            if (state.upstreamAttempt >= MAX_INTERNAL_CONTINUATIONS) {
              this.closeUpstream(state);
              return this.complete(state, terminalCompatibilityFailure(
                `K3 did not call its internal finish tool after ${MAX_INTERNAL_CONTINUATIONS} continuations`,
                metadata.connectionId,
                true,
              ));
            }
            const retryBody = retryNativeFinishRequest(
              state.upstream.body,
              terminal.response,
              decision,
            );
            console.info(
              `[model-gateway] native retry provider=${state.providerId} ` +
              `reason=${decision.reason} tools=0 attempt=${state.upstreamAttempt}`,
            );
            this.closeUpstream(state);
            state.upstreamStatus = 0;
            state.upstream.body = retryBody;
            state.nativeAttemptBytes = new Uint8Array();
            state.nativeTerminalProbe = "";
            state.nativeTerminalSeen = false;
            state.nativeSSEBytes = new Uint8Array();
            this.openUpstream(state, metadata.connectionId, retryBody);
            return { allow: true, sensitive: true, stdoutBytes: [] };
          }
          if (terminal?.type === "response.completed" && decision.kind === "finish") {
            output = concat(streamHead(), encode(nativeFinalSSE(terminal.response, decision.answer)));
          } else if (terminal?.type === "response.completed" && decision.kind === "invalid") {
            this.closeUpstream(state);
            return this.complete(state, terminalCompatibilityFailure(
              decision.reason,
              metadata.connectionId,
              true,
            ));
          } else {
            output = concat(streamHead(), state.nativeAttemptBytes);
          }
          state.headersSent = true;
        }
        console.info(
          `[model-gateway] native terminal provider=${state.providerId} ` +
          `event=${state.nativeTerminalSeen ? "yes" : "missing"} transportClosed=${String(drained.closed)} ` +
          `idRepairs=${state.nativeIdRepairs}`,
        );
        this.closeUpstream(state);
        state.done = true;
        this.finishTelemetry(state, "ok", {
          "http.response.status_code": state.upstreamStatus,
          "hypernode.gateway.terminal_seen": state.nativeTerminalSeen,
        });
        // Streaming clients such as pi-ai consume response.completed but do
        // not finish their async iterator until the HTTP body reaches EOF.
        // Ask the TCP host to write this terminal batch and close atomically;
        // a separate edge-triggered wake can be coalesced and leave the
        // client waiting forever on an otherwise complete response.
        return { allow: true, sensitive: true, stdoutBytes: output, closeAfterWrite: true };
      }
      return { allow: true, sensitive: true, stdoutBytes: output };
    }
    if (state.upstreamStatus >= 200 && state.upstreamStatus < 300 && state.stream) {
      let output = new Uint8Array();
      if (!state.headersSent) {
        state.headersSent = true;
        output = streamHead();
      }
      if (chunk) output = concat(output, encode(state.translator.push(chunk)));
      // Chat Completions SSE defines `data: [DONE]` as the semantic end of
      // one response.  Several compatible providers keep the underlying
      // HTTP connection alive after that marker.  Waiting exclusively for
      // the transport to close leaves Codex stuck after it has already run
      // the emitted tools: their outputs can never trigger the next sample.
      // Treat either boundary as the end of this upstream attempt.
      if (state.translator.sawDone || drained.closed) {
        const retryReason = state.translator.gatewayRetryReason();
        const retryLimit = retryReason === "continuation_intent" ? 3 : 2;
        if (retryReason && state.upstreamAttempt < retryLimit) {
          const assistantState = state.translator.beginGatewayRetry();
          const retryBody = retryChatRequest(state.upstream.body, assistantState, retryReason);
          console.info(
            `[model-gateway] retry provider=${state.providerId} reason=${retryReason} tools=0`,
          );
          this.closeUpstream(state);
          state.upstreamStatus = 0;
          this.openUpstream(state, metadata.connectionId, retryBody);
          return { allow: true, sensitive: true, stdoutBytes: output };
        }
        if (retryReason === "missing_finish_reason") {
          output = concat(output, encode(state.translator.finishMissingReason()));
        } else {
          output = concat(output, encode(state.translator.finish()));
        }
        const terminal = state.translator.terminalSummary();
        console.info(
          `[model-gateway] terminal provider=${state.providerId} status=${terminal.status} ` +
          `finishReason=${terminal.finishReason} endTurn=${String(terminal.endTurn)} ` +
          `tools=${terminal.toolCalls}`,
        );
        this.closeUpstream(state);
        state.done = true;
        this.finishTelemetry(state, terminal.status === "failed" ? "error" : "ok", {
          "http.response.status_code": state.upstreamStatus,
          "hypernode.gateway.tool_calls": terminal.toolCalls,
          "hypernode.gateway.end_turn": terminal.endTurn,
        });
        return { allow: true, sensitive: true, stdoutBytes: output, closeAfterWrite: true };
      }
      return { allow: true, sensitive: true, stdoutBytes: output };
    }
    if (state.passthrough) {
      if (chunkBytes.length > 0) state.upstreamBodyBytes = concat(state.upstreamBodyBytes, chunkBytes);
    } else if (chunk) state.upstreamBody += chunk;
    if (!drained.closed) return { allow: true, sensitive: true, stdoutBytes: [] };
    this.closeUpstream(state);
    if (drained.error && !state.upstreamStatus) {
      return this.complete(state, errorResponse(502, "model provider request failed"), "error");
    }
    if (state.upstreamStatus < 200 || state.upstreamStatus >= 300) {
      console.warn(
        `[model-gateway] upstream error provider=${state.providerId ?? "unknown"} ` +
        `status=${state.upstreamStatus || 502} endpoint=${endpointForLog(state.upstream?.url)}`,
      );
      const upstreamText = state.passthrough ? decode(state.upstreamBodyBytes) : state.upstreamBody;
      const body = upstreamText && this.isJSON(upstreamText)
        ? upstreamText
        : JSON.stringify({ error: { message: upstreamText.trim() || "upstream error", type: "upstream_error" } });
      return this.complete(state, response(state.upstreamStatus || 502, body), "error");
    }
    if (state.passthrough) {
      if (state.sanitizeResponseIds && state.upstreamBodyBytes.length > 0) {
        try {
          const sanitized = sanitizeNativeResponseIds(JSON.parse(decode(state.upstreamBodyBytes)));
          state.nativeIdRepairs += sanitized.repairs;
          if (sanitized.repairs > 0) state.upstreamBodyBytes = encode(JSON.stringify(sanitized.value));
        } catch {
          // Preserve malformed upstream JSON verbatim so Codex receives the
          // provider's actual compatibility failure.
        }
      }
      if (state.internalFinishTool && state.upstreamBodyBytes.length > 0) {
        try {
          const nativeResponse = JSON.parse(decode(state.upstreamBodyBytes));
          const decision = decideNativeFinish(nativeResponse);
          if (decision.kind === "retry") {
            if (state.upstreamAttempt >= MAX_INTERNAL_CONTINUATIONS) {
              return this.complete(state, errorResponse(
                502,
                `K3 did not call its internal finish tool after ${MAX_INTERNAL_CONTINUATIONS} continuations`,
              ), "error");
            }
            const retryBody = retryNativeFinishRequest(state.upstream.body, nativeResponse, decision);
            console.info(
              `[model-gateway] native retry provider=${state.providerId} ` +
              `reason=${decision.reason} tools=0 stream=false attempt=${state.upstreamAttempt}`,
            );
            state.upstreamBodyBytes = new Uint8Array();
            state.upstreamStatus = 0;
            state.upstream.body = retryBody;
            this.openUpstream(state, metadata.connectionId, retryBody);
            return { allow: true, sensitive: true, stdoutBytes: [] };
          }
          if (decision.kind === "finish") {
            state.upstreamBodyBytes = encode(JSON.stringify(nativeFinalResponse(nativeResponse, decision.answer)));
          } else if (decision.kind === "invalid") {
            return this.complete(state, errorResponse(502, decision.reason), "error");
          }
        } catch {
          // Preserve the provider response below; malformed JSON remains an
          // upstream compatibility error rather than being guessed at here.
        }
      }
      return this.complete(state, concat(encode([
        `HTTP/1.1 ${state.upstreamStatus || 200} ${reason(state.upstreamStatus || 200)}`,
        "Content-Type: application/json; charset=utf-8",
        `Content-Length: ${state.upstreamBodyBytes.length}`,
        "Cache-Control: no-store",
        "Connection: close",
        "",
        "",
      ].join("\r\n")), state.upstreamBodyBytes));
    }
    try {
      const retry = chatResponseRetryCandidate(state.upstreamBody);
      if (retry.retry && state.upstreamAttempt === 1) {
        const retryBody = retryChatRequest(state.upstream.body, retry);
        console.info(
          `[model-gateway] retry provider=${state.providerId} reason=missing_finish_reason tools=0 stream=false`,
        );
        state.upstreamBody = "";
        state.upstreamStatus = 0;
        this.openUpstream(state, metadata.connectionId, retryBody);
        return { allow: true, sensitive: true, stdoutBytes: [] };
      }
      const translated = JSON.stringify(translateChatResponse(
        state.upstreamBody,
        state.translator,
        { missingFinishExhausted: retry.retry },
      ));
      return this.complete(state, response(200, translated));
    } catch (error) {
      return this.complete(state, errorResponse(502, "invalid model provider response"), "error");
    }
  }

  isJSON(value) {
    try { JSON.parse(value); return true; } catch { return false; }
  }

  fail(state, status, message) {
    return this.complete(state, errorResponse(status, message), "error");
  }

  complete(state, bytes, telemetryStatus = "ok") {
    state.done = true;
    this.finishTelemetry(state, telemetryStatus, {
      "http.response.status_code": state.upstreamStatus || 0,
    });
    return { allow: true, sensitive: true, stdoutBytes: bytes, closeAfterWrite: true };
  }

  recordDrain(state, chunkBytes, drained) {
    if (!state.telemetry || chunkBytes.length === 0) return;
    const now = typeof globalThis.hostEvents?.monotonicNowMs === "function"
      ? globalThis.hostEvents.monotonicNowMs()
      : Date.now();
    const previous = state.telemetry.lastDrainAt;
    state.telemetry.lastDrainAt = now;
    state.telemetry.drainCount += 1;
    state.telemetry.responseBytes += chunkBytes.length;
    if (state.telemetry.drainCount === 1) {
      addSpanEvent(state.telemetry.span, "gateway.drain.first", {
        "network.io.bytes": chunkBytes.length,
      });
    } else if (previous != null && now - previous >= 1_000) {
      addSpanEvent(state.telemetry.span, "gateway.drain.gap", {
        "network.io.bytes": chunkBytes.length,
        "network.io.gap_ms": now - previous,
        "hypernode.gateway.drain_count": state.telemetry.drainCount,
      });
    }
    if (drained.closed) {
      addSpanEvent(state.telemetry.span, "gateway.transport.closed", {
        "hypernode.gateway.response_bytes": state.telemetry.responseBytes,
        "hypernode.gateway.drain_count": state.telemetry.drainCount,
      });
    }
  }

  finishTelemetry(state, status, attributes = {}) {
    if (!state.telemetry || state.telemetry.finished) return;
    state.telemetry.finished = true;
    addSpanEvent(state.telemetry.span, "gateway.terminal", {
      ...attributes,
      "hypernode.gateway.attempts": state.upstreamAttempt,
      "hypernode.gateway.response_bytes": state.telemetry.responseBytes,
      "hypernode.gateway.drain_count": state.telemetry.drainCount,
    });
    endSpan(state.telemetry.span, status);
  }

  closeUpstream(state) {
    if (!state.requestId) return;
    this.ctx.httpClient.close(state.requestId);
    state.requestId = null;
  }

  openUpstream(state, connectionId, body) {
    if (!state.telemetry) {
      const correlationId = `model-gateway:${connectionId}`;
      state.telemetry = {
        span: startSpan("hypernode.model.request", {
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": state.providerId ?? "unknown",
          "hypernode.model.api_protocol": state.apiProtocol ?? "unknown",
          "hypernode.model.stream": state.stream === true,
          "hypernode.correlation_id": correlationId,
        }),
        correlationId,
        drainCount: 0,
        responseBytes: 0,
        lastDrainAt: null,
        finished: false,
      };
    }
    state.upstreamAttempt += 1;
    state.requestId = `model-gateway:${connectionId}:${state.upstreamAttempt}`;
    addSpanEvent(state.telemetry.span, "gateway.upstream.attempt", {
      "hypernode.gateway.attempt": state.upstreamAttempt,
    });
    this.ctx.httpClient.open(state.requestId, {
      ...state.upstream,
      body,
      telemetry: {
        traceparent: state.telemetry.span.traceparent,
        correlationId: state.telemetry.correlationId,
        requestId: state.requestId,
      },
    });
  }

  close(metadata) {
    const state = this.connections.get(metadata.connectionId);
    this.connections.delete(metadata.connectionId);
    if (state) {
      this.closeUpstream(state);
      if (!state.done) this.finishTelemetry(state, "cancelled");
    }
    return { allow: true, stdoutBytes: [] };
  }
}

ModelGatewayIngressService.inject = ["httpClient", "modelGateway"];
