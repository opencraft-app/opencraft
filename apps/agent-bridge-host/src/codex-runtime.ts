import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { isHumanInteraction } from "@opencraft/appserver-protocol";
import {
  BRIDGE_ERROR_CODES,
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
    if (method !== "item/tool/call" && !isHumanInteraction(method, raw)) {
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
  private readHistory(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.owner.readHistory?.(method, params) ?? this.owner.request(method, params);
  }
  private async readOpenTurnOutcomes(nativeId: string, open: readonly string[], discoverActive = false) {
    const statuses = new Map<string, string>();
    const remaining = new Set(open);
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const response = object(await this.readHistory("thread/turns/list", {
        threadId: nativeId, cursor, limit: 20, sortDirection: "desc", itemsView: "notLoaded",
      }));
      if (!Array.isArray(response.data)) throw new CodexBridgeError("unknown-outcome", "Native Turn page unavailable");
      for (const value of response.data) {
        const turn = object(value);
        if (typeof turn.id !== "string" || typeof turn.status !== "string") continue;
        if (remaining.delete(turn.id) || (discoverActive && page === 0 && turn.status === "inProgress"))
          statuses.set(turn.id, turn.status);
      }
      if (!remaining.size || response.nextCursor == null) {
        if (!discoverActive) for (const id of remaining) statuses.set(id, "interrupted");
        return [...statuses].map(([nativeTurnId, status]) => ({ nativeTurnId, status }));
      }
      if (typeof response.nextCursor !== "string" || response.nextCursor === cursor)
        throw new CodexBridgeError("unknown-outcome", "Native Turn pagination did not advance");
      cursor = response.nextCursor;
    }
    throw new CodexBridgeError("unknown-outcome", "Native Turn reconciliation exceeded its page limit");
  }
  async handle(request: BridgeRequest): Promise<void> {
    try {
      this.send({ jsonrpc: "2.0", id: request.id, result: await this.command(request.method, request.params) });
    } catch (error) {
      // An oversized mutation receipt does not prove the mutation was rejected.
      const kind: BridgeErrorKind = error instanceof CodexBridgeError
        && (error.kind !== "frame-too-large" || request.method === "history/read") ? error.kind : "unknown-outcome";
      const codes: Partial<Record<BridgeErrorKind, number>> = {
        "frame-too-large": BRIDGE_ERROR_CODES.frameTooLarge,
        "stale-target": BRIDGE_ERROR_CODES.staleTarget,
        invalid: BRIDGE_ERROR_CODES.invalidParams,
        unsupported: BRIDGE_ERROR_CODES.unsupportedCapability,
        "explicit-reject": BRIDGE_ERROR_CODES.explicitReject,
      };
      const code = codes[kind] ?? BRIDGE_ERROR_CODES.unknownOutcome;
      this.send({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code,
          kind,
          message: error instanceof CodexBridgeError ? error.message : "Native command outcome unknown",
          ...(request.method === "session/create" && error instanceof CodexBridgeError && error.nativeCreateFailure
            ? { data: { nativeCreateFailure: error.nativeCreateFailure,
              ...(kind === "explicit-reject" && error.nativeCreateFailure.notAllocated ? { creationOutcome: "not-allocated",
                ...(error.nativeCreateFailure.reason === "model-catalog-unavailable" ? { creationRejectionCode: "model_catalog_unavailable" } : {}) } : {}) } } : {}),
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
          // Respect an explicitly selected history contract on new sessions; forks inherit their source's format.
          if (method === "session/create") native.historyMode ??= "legacy";
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
        // Normal adoption requires an idle session. The Host can recover an
        // active execution through its own persisted native binding.
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
        let recovering = false;
        try {
          const read = object(
            object(await this.owner.request("thread/read", { threadId: nativeId, includeTurns: false })).thread,
          );
          const status = object(read.status).type;
          const recoverRunning = p.recoverActive === true && status === "active";
          if (read.id !== nativeId || (!recoverRunning && !["idle", "notLoaded"].includes(String(status))))
            throw new CodexBridgeError("explicit-reject", "Only an idle existing session can be adopted");
          const open = Array.isArray(p.openTurns) ? p.openTurns.map(identifier) : [];
          let outcomes = !recoverRunning && open.length ? await this.readOpenTurnOutcomes(nativeId, open) : [];
          if (recoverRunning) {
            // Install the route before subscribing to the existing loop so
            // completion and approval replay can reach it during resume.
            this.adapter.bind(threadId, nativeId);
            recovering = true;
          }
          const result = object(await this.owner.request("thread/resume", { threadId: nativeId, excludeTurns: true }));
          if (object(result.thread).id !== nativeId)
            throw new CodexBridgeError("explicit-reject", "Native session identity changed during adoption");
          if (recoverRunning) outcomes = await this.readOpenTurnOutcomes(nativeId, open, true);
          else this.adapter.bind(threadId, nativeId);
          this.callback("thread/identity", { threadId, providerThreadId: nativeId, sessionRestorable: true });
          if (outcomes.length) this.adapter.recovered(threadId, outcomes);
          return result;
        } catch (error) {
          if (recovering) this.adapter.forgetBinding(threadId);
          throw error;
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
        const native = p.native === undefined ? {} : object(p.native);
        const overrides = Object.fromEntries(Object.entries(native).filter(([key]) =>
          ["model", "modelProvider", "serviceTier", "approvalPolicy", "approvalsReviewer", "permissions", "sandbox"].includes(key),
        ));
        return this.owner.request("thread/resume", { ...overrides, threadId: nativeId, excludeTurns: p.excludeTurns ?? true });
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
        const read = (method: string, params: Record<string, unknown>) =>
          this.readHistory(method, params);
        if (p.view === "occurrences") {
          return read("thread/searchOccurrences", {
            threadId: this.adapter.nativeSession(threadId), searchTerm: p.searchTerm, limit: p.limit, cursor: p.cursor,
          });
        }
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
              return await read("thread/read", { threadId: nativeId, includeTurns: p.includeTurns === true });
            } catch (error) {
              if (!notYet(error)) throw error;
            }
            try {
              const metadata = object(await read("thread/read", { threadId: nativeId, includeTurns: false }));
              return { ...metadata, thread: { ...object(metadata.thread), turns: [] } };
            } catch (error) {
              if (!notYet(error) || attempt >= 9) throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
        const nativeId = this.adapter.nativeSession(threadId);
        if (p.view === "items" || p.turnId != null)
          return read("thread/items/list", {
            threadId: nativeId,
            ...(p.turnId != null ? { turnId: identifier(p.turnId) } : {}),
            limit: p.limit ?? 100,
            cursor: p.cursor ?? null,
            ...(p.sortDirection !== undefined ? { sortDirection: p.sortDirection } : {}),
          });
        return read("thread/turns/list", {
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
