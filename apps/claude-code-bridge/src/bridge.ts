import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  negotiateHandshake,
  type BridgeDeclaration,
  type BridgeInitializeParams,
  type BridgeInitializeResult,
  type DeliveryMethod,
} from "@opencraft/agent-bridge-protocol";
import { CLAUDE_BRIDGE_DECLARATION, CLAUDE_BRIDGE_PROVIDER_ID } from "./declaration.js";
import { BridgeCommandError, authRequired, invalid, staleTarget, unsupported } from "./errors.js";
import { ClaudeSession, type InputStatus, type SessionInfo, type StartTurnInput, type SteerInput } from "./session.js";
import type { NativeFactory, NativeSessionPort, NativeStartOptions, PermissionModeName } from "./types.js";
import { isRecord, stringArray, stringField } from "./types.js";

export interface BridgeCallbacks {
  notify(method: "thread/delta" | "thread/identity" | "provider/recovery", params: Record<string, unknown>): Promise<void>;
}

export interface ClaudeBridgeOptions {
  readonly factory: NativeFactory;
  readonly callbacks: BridgeCallbacks;
  readonly declaration?: BridgeDeclaration;
  readonly initializeTimeoutMs?: number;
}

interface SessionEntry {
  readonly session: ClaudeSession;
  readonly routeId: string;
}

const PERMISSION_MODES: readonly PermissionModeName[] = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"];

/** Process-loader variables belong to the pinned Host launch, not a command. */
const RESERVED_ENV = new Set([
  "ANTHROPIC_BASE_URL",
  "ALL_PROXY",
  "CLAUDE_CODE_EXECUTABLE",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NO_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "PATH",
]);

/**
 * Command dispatcher for one bridge process. It owns session objects and
 * parameter validation; the state machine and native adapter stay separate.
 */
export class ClaudeBridge {
  private readonly declaration: BridgeDeclaration;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly routeQueues = new Map<string, Promise<unknown>>();
  private capabilities?: BridgeInitializeResult["effectiveCapabilities"];

  constructor(private readonly options: ClaudeBridgeOptions) {
    this.declaration = options.declaration ?? CLAUDE_BRIDGE_DECLARATION;
  }

  get providerId(): string {
    return this.declaration.providerId;
  }

  get effectiveCapabilities(): BridgeInitializeResult["effectiveCapabilities"] | undefined {
    return this.capabilities;
  }

  initialize(params: unknown): BridgeInitializeResult {
    const input = isRecord(params) ? params : {};
    const handshake = negotiateHandshake(input as unknown as BridgeInitializeParams, this.declaration);
    if (!handshake.ok) {
      this.capabilities = undefined;
      throw new BridgeCommandError("unsupported", handshake.error.code, handshake.error.message, handshake.error.data);
    }
    this.capabilities = handshake.result.effectiveCapabilities;
    return handshake.result;
  }

  command(method: string, rawParams: unknown): Promise<unknown> {
    const params = isRecord(rawParams) ? rawParams : {};
    const routeId = stringField(params, "threadId");
    if (routeId === undefined) return this.dispatch(method, params, undefined);
    const previous = this.routeQueues.get(routeId) ?? Promise.resolve();
    const next = previous.then(
      () => this.dispatch(method, params, routeId),
      () => this.dispatch(method, params, routeId),
    );
    const settled = next.then(() => undefined, () => undefined);
    this.routeQueues.set(routeId, settled);
    void settled.finally(() => { if (this.routeQueues.get(routeId) === settled) this.routeQueues.delete(routeId); });
    return next;
  }

  private async dispatch(method: string, params: Record<string, unknown>, routeId: string | undefined): Promise<unknown> {
    switch (method) {
      case "session/create":
        if (routeId === undefined) throw invalid("session/create requires threadId");
        return this.createSession(routeId, params);
      case "session/close": {
        if (routeId === undefined) throw invalid("session/close requires threadId");
        const entry = this.sessions.get(routeId);
        if (entry === undefined) return { closed: true };
        await entry.session.close();
        this.sessions.delete(routeId);
        return { closed: true };
      }
      case "session/resume":
        throw unsupported("This batch does not implement Claude native resume");
      case "turn/start": {
        const entry = this.requireSession(routeId);
        return entry.session.startTurn(this.startTurnInput(params));
      }
      case "turn/steer": {
        const entry = this.requireSession(routeId);
        return entry.session.steer(this.steerInput(params));
      }
      case "turn/stop": {
        const entry = this.requireSession(routeId);
        return entry.session.stop();
      }
      case "input/query": {
        const entry = routeId !== undefined ? this.sessions.get(routeId) : undefined;
        if (entry === undefined) return { inputs: [] };
        if (params.inputIds !== undefined
          && (!Array.isArray(params.inputIds) || !params.inputIds.every((value) => typeof value === "string"))) {
          throw invalid("input/query inputIds must be an array of strings");
        }
        const ids = stringArray(params.inputIds);
        return { inputs: entry.session.query(ids) };
      }
      case "input/withdraw": {
        const entry = this.requireSession(routeId);
        const inputId = stringField(params, "inputId");
        if (inputId === undefined) throw invalid("input/withdraw needs inputId");
        return entry.session.withdraw(inputId);
      }
      case "model/list":
        return this.modelList(params);
      case "maintenance/probe":
        return this.probe(routeId);
      case "history/read":
        throw unsupported("This batch does not implement Claude history read");
      case "interaction/resolve":
        throw unsupported("This batch does not implement Claude approvals");
      case "skills/configure":
      case "installation/status":
      case "installation/run":
        throw unsupported(`Claude bridge does not implement ${method}`);
      default:
        throw unsupported(`Unsupported Claude bridge command ${method}`);
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.routeQueues.values()]);
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(entries.map((entry) => entry.session.close()));
  }

  /** Readable status for tests and maintenance; no native mutation. */
  sessionInfo(routeId: string): SessionInfo | undefined {
    return this.sessions.get(routeId)?.session.sessionInfo;
  }

  inputStatus(routeId: string): readonly InputStatus[] {
    return this.sessions.get(routeId)?.session.query() ?? [];
  }

  private requireSession(routeId: string | undefined): SessionEntry {
    const entry = routeId !== undefined ? this.sessions.get(routeId) : undefined;
    if (entry === undefined) throw staleTarget("No Claude session is bound to this Thread");
    return entry;
  }

  private async createSession(routeId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const existing = this.sessions.get(routeId);
    if (existing !== undefined) {
      const info = existing.session.sessionInfo;
      if (info === undefined) throw staleTarget("Claude session is still initializing");
      return this.infoResult(info, true);
    }
    const cwd = this.absolutePath(params.cwd, "session/create cwd");
    if (cwd === undefined) throw invalid("session/create requires an absolute Thread workspace cwd");
    const permissionMode = this.permissionMode(params.permissionMode);
    const allowBypass = params.allowDangerouslySkipPermissions === true;
    if (permissionMode === "bypassPermissions" && !allowBypass) {
      throw invalid("bypassPermissions requires allowDangerouslySkipPermissions: true");
    }
    const allowedTools = this.stringList(params.allowedTools, "allowedTools");
    const disallowedTools = this.stringList(params.disallowedTools, "disallowedTools");
    const maxTurns = this.positiveInteger(params.maxTurns, "maxTurns");
    const model = this.optionalString(params.model, "model");
    const systemPromptAppend = this.optionalString(params.systemPromptAppend, "systemPromptAppend");
    const env = this.environment(params.env);
    const session = new ClaudeSession(
      {
        scopeId: routeId,
        cwd,
        ...(model !== undefined ? { model } : {}),
        ...(permissionMode !== undefined ? { permissionMode } : {}),
        ...(allowBypass ? { allowDangerouslySkipPermissions: true } : {}),
        ...(allowedTools !== undefined ? { allowedTools } : {}),
        ...(disallowedTools !== undefined ? { disallowedTools } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        ...(env !== undefined ? { env } : {}),
        ...(systemPromptAppend !== undefined ? { systemPromptAppend } : {}),
        emit: (deltas) => this.options.callbacks.notify("thread/delta", { threadId: routeId, deltas }),
        emitIdentity: (identity) => this.options.callbacks.notify("thread/identity", {
          threadId: routeId,
          providerThreadId: identity.providerThreadId,
          sessionRestorable: identity.sessionRestorable,
        }),
      },
      this.options.factory,
    );
    this.sessions.set(routeId, { session, routeId });
    try {
      const info = await session.create();
      return this.infoResult(info, false);
    } catch (error) {
      this.sessions.delete(routeId);
      throw error;
    }
  }

  private async modelList(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const routeId = stringField(params, "threadId");
    if (routeId !== undefined) {
      const entry = this.sessions.get(routeId);
      if (entry !== undefined) {
        const info = entry.session.sessionInfo;
        if (info !== undefined) return { models: info.models, nativeVersion: info.nativeVersion, session: true };
      }
    }
    const cwd = this.absolutePath(params.cwd, "model/list cwd") ?? process.cwd();
    const env = this.environment(params.env);
    const model = this.optionalString(params.model, "model");
    const native = this.options.factory.start({
      cwd,
      sessionId: randomUUID(),
      ...(model !== undefined ? { model } : {}),
      ...(env !== undefined ? { env } : {}),
    });
    try {
      const info = await this.withTimeout(
        native.initialize(),
        this.options.initializeTimeoutMs ?? 30_000,
        "Claude model probe initialization",
      );
      return { models: info.models, nativeVersion: info.version };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/auth|login|credential|token/i.test(message)) throw authRequired(`Claude Code authentication failed: ${message}`);
      throw new BridgeCommandError("internal", -32603, `Claude model probe failed: ${message}`);
    } finally {
      await native.close().catch(() => {});
    }
  }

  private probe(routeId: string | undefined): Record<string, unknown> {
    const entry = routeId !== undefined ? this.sessions.get(routeId) : undefined;
    const info = entry?.session.sessionInfo;
    return {
      ok: true,
      providerId: CLAUDE_BRIDGE_PROVIDER_ID,
      processId: process.pid,
      ...(info !== undefined
        ? {
            threadId: routeId,
            providerThreadId: info.providerThreadId,
            nativeVersion: info.nativeVersion,
            model: info.model,
            permissionMode: info.permissionMode,
            models: info.models,
          }
        : {}),
    };
  }

  private startTurnInput(params: Record<string, unknown>): StartTurnInput {
    const nested = isRecord(params.input) ? params.input : params;
    const text = stringField(nested, "text");
    if (text === undefined) throw invalid("turn/start needs input text");
    const inputId = stringField(nested, "inputId") ?? randomUUID();
    const clientRequestId = stringField(nested, "clientRequestId") ?? inputId;
    const model = this.optionalString(params.model, "model");
    const permissionMode = this.permissionMode(params.permissionMode);
    return {
      inputId,
      clientRequestId,
      text,
      ...(model !== undefined ? { model } : {}),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
    };
  }

  private steerInput(params: Record<string, unknown>): SteerInput {
    const nested = isRecord(params.input) ? params.input : params;
    const text = stringField(nested, "text");
    const inputId = stringField(nested, "inputId") ?? stringField(params, "inputId");
    const clientRequestId = stringField(nested, "clientRequestId") ?? stringField(params, "clientRequestId");
    if (text === undefined) throw invalid("turn/steer needs input text");
    if (inputId === undefined) throw invalid("turn/steer needs inputId");
    if (clientRequestId === undefined) throw invalid("turn/steer needs clientRequestId");
    const rawDelivery = params.deliveryMethod;
    if (rawDelivery !== undefined && typeof rawDelivery !== "string") throw invalid("deliveryMethod must be a string");
    const deliveryMethod = rawDelivery as DeliveryMethod | undefined;
    const expectedTurnId = stringField(params, "expectedTurnId");
    return {
      inputId,
      clientRequestId,
      text,
      ...(expectedTurnId !== undefined ? { expectedTurnId } : {}),
      ...(deliveryMethod !== undefined ? { deliveryMethod } : {}),
    };
  }

  private permissionMode(value: unknown): PermissionModeName | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !(PERMISSION_MODES as readonly string[]).includes(value)) {
      throw invalid(`Unknown Claude permission mode ${String(value)}`);
    }
    return value as PermissionModeName;
  }

  private absolutePath(value: unknown, label: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !isAbsolute(value)) throw invalid(`${label} must be an absolute path`);
    return value;
  }

  private optionalString(value: unknown, label: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw invalid(`${label} must be a string`);
    return value;
  }

  private stringList(value: unknown, label: string): string[] | undefined {
    if (value === undefined) return undefined;
    const list = stringArray(value);
    if (list === undefined) throw invalid(`${label} must be an array of strings`);
    return list;
  }

  private positiveInteger(value: unknown, label: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw invalid(`${label} must be a positive integer`);
    return value;
  }

  private environment(value: unknown): Readonly<Record<string, string>> | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)) throw invalid("env must be an object of string values");
    const env: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw invalid("env must contain string values");
      if (RESERVED_ENV.has(key)) throw invalid(`env may not override reserved process variable ${key}`);
      env[key] = entry;
    }
    return env;
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private infoResult(info: SessionInfo, idempotent: boolean): Record<string, unknown> {
    return {
      providerThreadId: info.providerThreadId,
      sessionRestorable: false,
      nativeVersion: info.nativeVersion,
      model: info.model,
      permissionMode: info.permissionMode,
      models: info.models,
      pid: info.pid,
      idempotent,
    };
  }
}

export type { NativeSessionPort, NativeStartOptions };
export { CLAUDE_BRIDGE_DECLARATION, CLAUDE_BRIDGE_PROVIDER_ID };
