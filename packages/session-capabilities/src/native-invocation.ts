import { createHash, randomBytes } from "node:crypto";
import type { CapabilityExecution, CapabilityResult, CapabilityTool } from "./index.js";
import { capabilityResultFromMcp, capabilityResultToMcp } from "./content.js";

/** Supplied by the trusted execution owner, never deserialized from tool input. */
export interface NativeToolExecution {
  readonly tools: readonly CapabilityTool[];
  readonly execution: CapabilityExecution;
  readonly signal: AbortSignal;
  /** Recheck live authority even when returning a process-local cached result. */
  authorize(signal: AbortSignal): void | Promise<void>;
  call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    execution: CapabilityExecution,
  ): Promise<CapabilityResult>;
}

const correlationField = "_opencraftNativeInvocation";
const fail = (message: string) =>
  Object.assign(new Error(message), { code: "NATIVE_INVOCATION_DENIED", retryable: false, outcome: "unknown" });
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => JSON.stringify(key) + ":" + canonical(entry))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("Native tool input must be an object");
  return structuredClone(value) as Record<string, unknown>;
}
interface Invocation {
  readonly name: string;
  readonly callId: string;
  readonly fingerprint: string;
  readonly token: string;
  pending?: Promise<CapabilityResult>;
  settled?: boolean;
  result?: CapabilityResult;
}

/** Joins a trusted native pre-tool callback to a separate MCP dispatch. The
 * opaque correlation grants no authority: execution/catalog are captured here,
 * and the domain provider still authorizes every invocation. It is deliberately
 * absent from the model's schema. A retired scope never adopts a later turn.
 * This bounded process-local correlation is not a durable effect receipt. */
export class NativeInvocationScope {
  private readonly catalog: readonly CapabilityTool[];
  private readonly execution: CapabilityExecution;
  private readonly controller = new AbortController();
  private readonly entries = new Map<string, Invocation>();
  private readonly tokens = new Map<string, Invocation>();
  private inputBytes = 0;
  private resultBytes = 0;
  private readonly call: NativeToolExecution["call"];
  private readonly authorize: NativeToolExecution["authorize"];
  private readonly signal: AbortSignal;
  private readonly cancel = () => this.close();
  constructor(owner: NativeToolExecution) {
    this.call = owner.call.bind(owner);
    this.authorize = owner.authorize.bind(owner);
    this.signal = owner.signal;
    this.execution = Object.freeze(structuredClone(owner.execution));
    if (
      [this.execution.inputId, this.execution.turnId].some(
        (value) => typeof value !== "string" || !value || value.length > 1024,
      ) ||
      this.execution.callId !== undefined
    )
      throw fail("Native tools require one exact execution without a caller-selected call ID");
    this.catalog = structuredClone(owner.tools);
    if (
      this.catalog.length > 128 ||
      Buffer.byteLength(JSON.stringify(this.catalog)) > 1024 * 1024 ||
      new Set(this.catalog.map((tool) => tool.name)).size !== this.catalog.length ||
      this.catalog.some(
        (tool) =>
          !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(tool.name) ||
          Object.hasOwn((tool.inputSchema.properties ?? {}) as object, correlationField),
      )
    )
      throw fail("Invalid native tool catalog");
    owner.signal.addEventListener("abort", this.cancel, { once: true });
    if (owner.signal.aborted) this.close();
  }
  private validate() {
    if (this.controller.signal.aborted) throw fail("Native execution has retired");
  }
  get tools(): readonly CapabilityTool[] {
    this.validate();
    return structuredClone(this.catalog);
  }
  /** Only a native adapter's trusted callback may supply callId. */
  capture(name: string, callId: string, input: unknown): Record<string, unknown> {
    this.validate();
    if (
      !this.catalog.some((tool) => tool.name === name) ||
      typeof callId !== "string" ||
      !callId ||
      callId.length > 1024
    )
      throw fail("Native call identity is unavailable");
    const args = object(input);
    if (Object.hasOwn(args, correlationField)) throw fail("Reserved native correlation input");
    const serialized = canonical(args),
      size = Buffer.byteLength(serialized);
    if (size > 64 * 1024) throw fail("Native tool input is too large");
    const fingerprint = createHash("sha256")
      .update(name + "\0" + serialized)
      .digest("hex");
    let entry = this.entries.get(callId);
    if (entry && entry.fingerprint !== fingerprint) throw fail("Native call identity reused with different input");
    if (!entry) {
      if (this.entries.size >= 256 || this.inputBytes + size > 2 * 1024 * 1024)
        throw fail("Native invocation capacity exhausted");
      entry = { name, callId, fingerprint, token: randomBytes(32).toString("base64url") };
      this.entries.set(callId, entry);
      this.tokens.set(entry.token, entry);
      this.inputBytes += size;
    }
    return { ...args, [correlationField]: entry.token };
  }
  async invoke(name: string, input: unknown, signal: AbortSignal): Promise<CapabilityResult> {
    this.validate();
    signal.throwIfAborted();
    const args = object(input),
      token = args[correlationField];
    delete args[correlationField];
    const entry = typeof token === "string" ? this.tokens.get(token) : undefined;
    if (
      !entry ||
      entry.name !== name ||
      entry.fingerprint !==
        createHash("sha256")
          .update(name + "\0" + canonical(args))
          .digest("hex")
    )
      throw fail("Native tool dispatch has no matching trusted callback");
    const combined = AbortSignal.any([signal, this.controller.signal]);
    await this.authorize(combined);
    this.validate();
    combined.throwIfAborted();
    if (entry.settled) {
      if (!entry.result) throw fail("Native result unavailable; inspect the original operation before another call");
      return structuredClone(entry.result);
    }
    if (!entry.pending) {
      const operation = (async () => {
        const result = capabilityResultFromMcp(
          capabilityResultToMcp(
            await this.call(name, args, combined, Object.freeze({ ...this.execution, callId: entry.callId })),
          ),
        );
        this.validate();
        combined.throwIfAborted();
        const size = Buffer.byteLength(JSON.stringify(result));
        if (this.resultBytes + size <= 8 * 1024 * 1024) {
          entry.result = structuredClone(result);
          this.resultBytes += size;
        }
        return result;
      })();
      entry.pending = operation;
      void operation
        .finally(() => {
          entry.settled = true;
          entry.pending = undefined;
        })
        .catch(() => {});
    }
    const result = await entry.pending;
    await this.authorize(combined);
    this.validate();
    combined.throwIfAborted();
    return structuredClone(result);
  }
  close() {
    this.controller.abort();
    this.signal.removeEventListener("abort", this.cancel);
    this.entries.clear();
    this.tokens.clear();
    this.inputBytes = 0;
    this.resultBytes = 0;
  }
}
