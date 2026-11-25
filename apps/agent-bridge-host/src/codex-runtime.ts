import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import {
  negotiateHandshake,
  type BridgeWireMessage,
  type BridgeRequest,
  type BridgeInitializeParams,
  type BridgeErrorKind,
} from "@opencraft/agent-bridge-protocol";
import { CodexBridge, CodexBridgeError, type CodexOwnerPort } from "./codex.js";
import { codexDeclaration } from "./codex-declaration.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CodexBridgeError("invalid", "Expected parameters");
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512)
    throw new CodexBridgeError("invalid", "Expected identifier");
  return value;
}
export interface CodexRuntimeOwner extends CodexOwnerPort {
  resolve(id: string | number, result: unknown): void;
  reject?(id: string | number): void;
}
/** One pinned generation; the Host keeps command/outbox durability. */
export class CodexBridgeRuntime {
  readonly adapter: CodexBridge;
  private initialized = false;
  private creating = new Set<string>();
  private interactions = new Map<string, { threadId: string; nativeId: string | number }>();
  constructor(
    private owner: CodexRuntimeOwner,
    private send: (message: BridgeWireMessage) => void,
    private readonly nativeProjectless = false,
  ) {
    this.adapter = new CodexBridge(
      owner,
      (threadId, deltas) => this.callback("thread/delta", { threadId, deltas }),
      (threadId, method, params) => this.callback("thread/notification", { threadId, method, params }),
    );
  }
  private callback(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", id: `codex-event:${randomUUID()}`, method, params });
  }
  lost(): void {
    for (const [id, interaction] of this.interactions)
      this.retireInteraction(id, interaction.threadId, "connection-lost");
    for (const threadId of this.adapter.boundThreads())
      this.callback("provider/recovery", {
        threadId,
        kind: "restartRecommended",
        message: "Codex connection lost; native outcome requires reconciliation",
        retryable: false,
      });
  }
  private retireInteraction(interactionId: string, threadId: string, reason: "resolved" | "connection-lost"): void {
    this.interactions.delete(interactionId);
    this.callback("interaction/resolved", { threadId, interactionId, reason });
  }
  notification(method: string, params: unknown): void {
    if (method === "serverRequest/resolved") {
      const p = object(params);
      for (const [id, interaction] of this.interactions) {
        if (
          interaction.nativeId === p.requestId &&
          (p.threadId === undefined || this.adapter.route(String(p.threadId)) === interaction.threadId)
        )
          this.retireInteraction(id, interaction.threadId, "resolved");
      }
      return;
    }
    this.adapter.notification(method, params);
  }
  interaction(nativeId: string | number, method: string, raw: unknown): void {
    if (
      ![
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/tool/requestUserInput",
        "mcpServer/elicitation/request",
        // The client's own dynamic tools (declared at thread/start) are answered by that client.
        "item/tool/call",
      ].includes(method)
    ) {
      this.owner.reject?.(nativeId);
      return;
    }
    const params = object(raw);
    const threadId = typeof params.threadId === "string" ? this.adapter.route(params.threadId) : undefined;
    if (!threadId) {
      this.owner.reject?.(nativeId);
      return;
    }
    const interactionId = `codex-interaction:${randomUUID()}`;
    this.interactions.set(interactionId, { threadId, nativeId });
    this.callback("interaction/request", {
      threadId,
      interactionId,
      kind: method.endsWith("/requestApproval")
        ? "approval"
        : method === "item/tool/call"
          ? "codex/dynamic-tool"
          : "question",
      payload: { method, params },
      providerNativeIds: true,
    });
  }
  async handle(request: BridgeRequest): Promise<void> {
    try {
      this.send({ jsonrpc: "2.0", id: request.id, result: await this.command(request.method, request.params) });
    } catch (error) {
      const kind: BridgeErrorKind = error instanceof CodexBridgeError ? error.kind : "unknown-outcome";
      const code =
        kind === "stale-target"
          ? -32002
          : kind === "invalid"
            ? -32602
            : kind === "unsupported"
              ? -32001
              : kind === "explicit-reject"
                ? -32006
                : -32005;
      this.send({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code,
          kind,
          message: error instanceof CodexBridgeError ? error.message : "Native command outcome unknown",
        },
      });
    }
  }
  private async command(method: string, raw: unknown): Promise<unknown> {
    const p = object(raw);
    if (method === "initialize") {
      if (this.initialized) throw new CodexBridgeError("explicit-reject", "Bridge already initialized");
      const grammar = object(p.grammarRange);
      if (!Number.isInteger(grammar.min) || !Number.isInteger(grammar.max))
        throw new CodexBridgeError("invalid", "Invalid grammar range");
      const outcome = negotiateHandshake(p as unknown as BridgeInitializeParams, codexDeclaration);
      if (!outcome.ok) throw new CodexBridgeError("unsupported", outcome.error.message);
      this.initialized = true;
      return outcome.result;
    }
    if (!this.initialized) throw new CodexBridgeError("explicit-reject", "Initialize first");
    if (method === "model/list") return this.owner.request("model/list", {});
    if (method === "maintenance/probe") return { providerId: "codex", attached: true };
    const threadId = identifier(p.threadId);
    switch (method) {
      case "session/create":
      case "session/fork": {
        if (this.creating.has(threadId))
          throw new CodexBridgeError("explicit-reject", "Session creation already pending");
        try {
          this.adapter.nativeSession(threadId);
          throw new CodexBridgeError("explicit-reject", "Session already exists");
        } catch (error) {
          if (!(error instanceof CodexBridgeError) || error.message !== "Session is not bound") throw error;
        }
        const native = { ...object(p.native) };
        if (p.cliEnvironment !== undefined) {
          const environment = object(p.cliEnvironment);
          if (Object.values(environment).some((v) => typeof v !== "string" || v.includes("\0")))
            throw new CodexBridgeError("invalid", "Invalid initial execution environment");
          const config = native.config == null ? {} : object(native.config);
          const configured = config["shell_environment_policy.set"];
          native.config = {
            ...config,
            "shell_environment_policy.set": { ...(configured == null ? {} : object(configured)), ...environment },
          };
          // The attached minimum native supports materialization probes for legacy history.
          // Respect an explicitly selected history contract.
          native.historyMode ??= "legacy";
        }
        // A fork inherits its source's workspace; only a new session must name one.
        const source = method === "session/fork" ? this.adapter.nativeSession(identifier(p.sourceThreadId)) : undefined;
        // Workspace deployments may delegate projectless allocation to their fixed AppServer.
        // Otherwise the provider requires an absolute cwd on this machine's platform.
        const allocateInNative = this.nativeProjectless && native.cwd == null;
        if (!source && !allocateInNative && (typeof native.cwd !== "string" || !isAbsolute(native.cwd)))
          throw new CodexBridgeError("invalid", "Explicit absolute workspace required");
        this.creating.add(threadId);
        try {
          const result = object(
            await this.owner.request(
              source ? "thread/fork" : "thread/start",
              source ? { ...native, threadId: source } : native,
            ),
          );
          const nativeId = identifier(object(result.thread).id);
          this.adapter.bind(threadId, nativeId);
          this.callback("thread/identity", { threadId, providerThreadId: nativeId, sessionRestorable: true });
          return result;
        } finally {
          this.creating.delete(threadId);
        }
      }
      case "session/adopt": {
        // Only an idle session its previous owner released; the Host pins the public ID to it.
        if (this.creating.has(threadId))
          throw new CodexBridgeError("explicit-reject", "Session creation already pending");
        try {
          this.adapter.nativeSession(threadId);
          throw new CodexBridgeError("explicit-reject", "Session already exists");
        } catch (error) {
          if (!(error instanceof CodexBridgeError) || error.message !== "Session is not bound") throw error;
        }
        const nativeId = identifier(p.providerThreadId);
        this.creating.add(threadId);
        try {
          const read = object(
            object(await this.owner.request("thread/read", { threadId: nativeId, includeTurns: false })).thread,
          );
          const status = object(read.status).type;
          if (read.id !== nativeId || !["idle", "notLoaded"].includes(String(status)))
            throw new CodexBridgeError("explicit-reject", "Only an idle existing session can be adopted");
          const result = object(await this.owner.request("thread/resume", { threadId: nativeId, excludeTurns: true }));
          if (object(result.thread).id !== nativeId)
            throw new CodexBridgeError("explicit-reject", "Native session identity changed during adoption");
          this.adapter.bind(threadId, nativeId);
          this.callback("thread/identity", { threadId, providerThreadId: nativeId, sessionRestorable: true });
          const open = Array.isArray(p.openTurns)
            ? p.openTurns.filter((id): id is string => typeof id === "string")
            : [];
          if (open.length) {
            // The session is idle natively, so each turn the Host held open has ended; use its native outcome.
            const turns = (object(
              object(await this.owner.request("thread/read", { threadId: nativeId, includeTurns: true })).thread,
            ).turns ?? []) as unknown[];
            const status = (id: string) =>
              String(object(turns.map(object).find((turn) => turn.id === id)).status ?? "interrupted");
            this.adapter.recovered(
              threadId,
              open.map((nativeTurnId) => ({ nativeTurnId, status: status(nativeTurnId) })),
            );
          }
          return result;
        } finally {
          this.creating.delete(threadId);
        }
      }
      case "session/rename": {
        if (typeof p.name !== "string" || p.name.length > 1024)
          throw new CodexBridgeError("invalid", "Invalid session name");
        return this.owner.request("thread/name/set", { threadId: this.adapter.nativeSession(threadId), name: p.name });
      }
      case "session/archive":
        return this.owner.request("thread/archive", { threadId: this.adapter.idle(threadId, "archive").nativeId });
      case "session/unarchive":
        return this.owner.request("thread/unarchive", { threadId: this.adapter.nativeSession(threadId) });
      case "session/delete":
        return this.adapter.delete(threadId);
      case "session/settings":
        return this.owner.request("thread/settings/update", {
          ...object(p.native),
          threadId: this.adapter.nativeSession(threadId),
        });
      case "goal/get":
      case "goal/set":
      case "goal/clear":
        return this.owner.request(`thread/${method}`, {
          ...object(p.native),
          threadId: this.adapter.nativeSession(threadId),
        });
      case "session/resume": {
        const nativeId = this.adapter.nativeSession(threadId);
        // Only this generation's bound session can resume; old legacy sessions
        // cannot be adopted by asking for an arbitrary native session ID.
        if (p.excludeTurns !== undefined && typeof p.excludeTurns !== "boolean")
          throw new CodexBridgeError("invalid", "Invalid resume history selection");
        return this.owner.request("thread/resume", { threadId: nativeId, excludeTurns: p.excludeTurns ?? true });
      }
      case "session/close":
        await this.adapter.close(threadId);
        return {};
      case "session/release":
        await this.adapter.release(threadId);
        return {};
      case "turn/start": {
        const environment = p.cliEnvironment === undefined ? undefined : object(p.cliEnvironment);
        const deadline = p.cliPreparationDeadlineMs;
        const sessionMcp = p.sessionMcp === undefined ? undefined : p.sessionMcp === null ? null : object(p.sessionMcp);
        if (
          (environment &&
            Object.values(environment).some((value) => typeof value !== "string" || value.includes("\0"))) ||
          (deadline !== undefined && (typeof deadline !== "number" || !Number.isSafeInteger(deadline)))
        )
          throw new CodexBridgeError("invalid", "Invalid execution CLI configuration");
        return this.adapter.start(
          threadId,
          object(p.native),
          environment as Record<string, string> | undefined,
          deadline,
          sessionMcp,
        );
      }
      case "turn/steer":
        return this.adapter.steer(threadId, p);
      case "turn/stop":
        return this.adapter.stop(threadId, identifier(p.expectedTurnId));
      case "input/query":
        return this.adapter.query(threadId, identifier(p.inputId));
      case "input/withdraw":
        throw new CodexBridgeError("unsupported", "Native input withdrawal is unavailable");
      case "history/read": {
        if (p.view === "thread") {
          const nativeId = this.adapter.nativeSession(threadId);
          // Between turn/start and native recording the first user message the session has no
          // readable turns yet; native refuses includeTurns there, which is not a failure of the
          // read. On Windows even the session metadata is unreadable while the new rollout file is
          // still empty, so that short window is waited out (bounded) before the read fails.
          const notYet = (error: unknown) =>
            error instanceof CodexBridgeError && ["unmaterialized", "turns-unavailable"].includes(error.nativeReason ?? "");
          for (let attempt = 0; ; attempt++) {
            try {
              return await this.owner.request("thread/read", { threadId: nativeId, includeTurns: p.includeTurns === true });
            } catch (error) {
              if (!notYet(error)) throw error;
            }
            try {
              const read = object(await this.owner.request("thread/read", { threadId: nativeId, includeTurns: false }));
              return { ...read, thread: { ...object(read.thread), turns: [] } };
            } catch (error) {
              if (!notYet(error) || attempt >= 9) throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
        const nativeId = this.adapter.nativeSession(threadId);
        if (p.turnId !== undefined)
          return this.owner.request("thread/items/list", {
            threadId: nativeId,
            turnId: identifier(p.turnId),
            limit: p.limit ?? 100,
            cursor: p.cursor ?? null,
          });
        return this.owner.request("thread/turns/list", {
          threadId: nativeId,
          limit: p.limit ?? 100,
          cursor: p.cursor ?? null,
          itemsView: p.itemsView ?? "full",
          ...(p.sortDirection !== undefined ? { sortDirection: p.sortDirection } : {}),
        });
      }
      case "interaction/resolve": {
        const key = identifier(p.interactionId),
          interaction = this.interactions.get(key);
        if (!interaction || interaction.threadId !== threadId)
          throw new CodexBridgeError("explicit-reject", "Interaction unavailable");
        this.owner.resolve(interaction.nativeId, p.result);
        this.interactions.delete(key);
        return {};
      }
      default:
        throw new CodexBridgeError("unsupported", "Unsupported bridge method");
    }
  }
}
