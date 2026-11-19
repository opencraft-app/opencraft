import { randomBytes } from "node:crypto";
import type { CapabilityResult, CapabilitySession, CapabilityTool, SessionCapabilityPort } from "./index.js";
import type { NativeToolExecution } from "./native-invocation.js";
import { capabilityResultFromMcp, capabilityResultToMcp } from "./content.js";

export interface ExecutionToolsDescriptor {
  version: 1;
  url: string;
  token: string;
  tools: readonly CapabilityTool[];
}
export interface ExecutionToolsSource {
  serverId: string;
  threadId: string;
  inputId: string;
  credential: string;
  signal: AbortSignal;
  /** Host-owned native→canonical binding for this exact issued command. */
  current(nativeTurnId: string): Promise<{ turnId: string }>;
}
export interface ExecutionToolsLease {
  descriptor: ExecutionToolsDescriptor;
  retire(): void;
  close(): Promise<void>;
}
export interface ExecutionToolsPort {
  issue(source: ExecutionToolsSource): Promise<ExecutionToolsLease>;
  forward(token: string, body: unknown, signal: AbortSignal): Promise<CapabilityResult | { allowed: true }>;
}
const denied = () =>
  Object.assign(Error("Execution tools unavailable; inspect any uncertain external effect before another input."), {
    code: "EXECUTION_TOOLS_DENIED",
    outcome: "unknown",
    retryable: false,
  });
function endpoint(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/execution-tools" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw denied();
  return url;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw denied();
  return value as Record<string, unknown>;
}
function id(value: unknown): value is string {
  return typeof value === "string" && !!value && value.length <= 1024;
}

/** Independent Host port. The issuer validates a signed input source; the
 * native process receives only an opaque, revocable per-command attachment.
 * Source credentials and canonical execution identity never enter model input. */
export function hostExecutionTools(options: {
  endpoint(): string;
  source(credential: string): CapabilitySession;
  authorize(credential: string, signal: AbortSignal): Promise<void>;
  capabilities(serverId: string): SessionCapabilityPort;
}): ExecutionToolsPort {
  interface Live {
    source: ExecutionToolsSource;
    session: CapabilitySession;
    port: SessionCapabilityPort;
    controller: AbortController;
    tools: readonly CapabilityTool[];
    pending: Set<Promise<unknown>>;
  }
  const active = new Map<string, Live>();
  let issuing = 0,
    pending = 0;
  return {
    async issue(source) {
      source = { ...source };
      source.signal.throwIfAborted();
      if (active.size + issuing >= 256) throw denied();
      const session = structuredClone(options.source(source.credential));
      if (
        session.serverId !== source.serverId ||
        session.threadId !== source.threadId ||
        session.execution?.inputId !== source.inputId ||
        !id(source.inputId)
      )
        throw denied();
      issuing++;
      try {
        await options.authorize(source.credential, source.signal);
        source.signal.throwIfAborted();
        const port = options.capabilities(source.serverId);
        await port.refresh?.(
          source.threadId,
          { ...session.execution, turnId: undefined, callId: undefined },
          source.signal,
        );
        source.signal.throwIfAborted();
        const tools = structuredClone(port.tools(source.threadId));
        if (tools.length > 128 || Buffer.byteLength(JSON.stringify(tools)) > 256 * 1024) throw denied();
        const token = randomBytes(32).toString("base64url"),
          controller = new AbortController();
        const live: Live = {
          source: { ...source },
          session: structuredClone(session),
          port,
          controller,
          tools,
          pending: new Set(),
        };
        const descriptor: ExecutionToolsDescriptor = {
          version: 1,
          url: endpoint(options.endpoint()).href,
          token,
          tools: structuredClone(tools),
        };
        const retire = () => {
          if (active.get(token) === live) active.delete(token);
          controller.abort();
          source.signal.removeEventListener("abort", retire);
        };
        source.signal.addEventListener("abort", retire, { once: true });
        source.signal.throwIfAborted();
        active.set(token, live);
        let closing: Promise<void> | undefined;
        return {
          descriptor,
          retire,
          close() {
            retire();
            return (closing ??= Promise.allSettled([...live.pending]).then(() => {}));
          },
        };
      } finally {
        issuing--;
      }
    },
    async forward(token, body, signal) {
      const live = active.get(token);
      if (!live || live.controller.signal.aborted || live.pending.size >= 8 || pending >= 32) throw denied();
      const input = structuredClone(object(body));
      if (
        !id(input.nativeTurnId) ||
        !["authorize", "call"].includes(String(input.method)) ||
        Object.keys(input).some(
          (key) =>
            !(
              input.method === "call"
                ? ["method", "nativeTurnId", "callId", "name", "args"]
                : ["method", "nativeTurnId"]
            ).includes(key),
        )
      )
        throw denied();
      if (
        input.method === "call" &&
        (!id(input.callId) ||
          !id(input.name) ||
          !live.tools.some((tool) => tool.name === input.name) ||
          Buffer.byteLength(JSON.stringify(object(input.args))) > 64 * 1024)
      )
        throw denied();
      const combined = AbortSignal.any([signal, live.controller.signal]);
      const validate = async () => {
        combined.throwIfAborted();
        await options.authorize(live.source.credential, combined);
        combined.throwIfAborted();
        const current = await live.source.current(input.nativeTurnId as string);
        combined.throwIfAborted();
        if (active.get(token) !== live || !id(current.turnId)) throw denied();
        return current;
      };
      const operation = (async () => {
        const current = await validate();
        if (input.method === "authorize") return { allowed: true as const };
        const result = await live.port.call(live.source.threadId, input.name as string, object(input.args), combined, {
          ...live.session.execution,
          turnId: current.turnId,
          callId: input.callId as string,
        });
        const after = await validate();
        if (after.turnId !== current.turnId) throw denied();
        return capabilityResultFromMcp(capabilityResultToMcp(result));
      })();
      live.pending.add(operation);
      pending++;
      try {
        return await operation;
      } finally {
        live.pending.delete(operation);
        pending--;
      }
    },
  };
}

/** Native adapter attachment. No retries: a lost response cannot replay an
 * external action. Domain receipts retain the exact native call identity. */
export function remoteExecutionTools(
  value: unknown,
  source: { inputId: string; nativeTurnId: string; signal: AbortSignal },
): Pick<NativeToolExecution, "tools" | "call" | "authorize"> {
  const descriptor = structuredClone(object(value));
  if (
    descriptor.version !== 1 ||
    typeof descriptor.url !== "string" ||
    typeof descriptor.token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(descriptor.token) ||
    !Array.isArray(descriptor.tools)
  )
    throw denied();
  const url = endpoint(descriptor.url),
    token = descriptor.token;
  const request = async (body: Record<string, unknown>, signal: AbortSignal) => {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ ...body, nativeTurnId: source.nativeTurnId }),
      signal: AbortSignal.any([signal, source.signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw denied();
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 32 * 1024 * 1024) throw denied();
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return object(JSON.parse(Buffer.concat(chunks).toString())).result;
  };
  return {
    tools: descriptor.tools as unknown as CapabilityTool[],
    async authorize(signal) {
      if (object(await request({ method: "authorize" }, signal)).allowed !== true) throw denied();
    },
    async call(name, args, signal, execution) {
      if (execution.inputId !== source.inputId || execution.turnId !== source.nativeTurnId || !id(execution.callId))
        throw denied();
      return capabilityResultFromMcp(
        capabilityResultToMcp(await request({ method: "call", name, args, callId: execution.callId }, signal)),
      );
    },
  };
}
