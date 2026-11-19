import { nativeTurnFailure, enrichModelFailure } from "./turn-failure.mjs";
import { codexSessionRoot } from "../local/profile-layout.mjs";
import { workInstruction } from "../work-tools/instruction.mjs";
import { join } from "node:path";
import { digest, stable } from "../../domain/values.mjs";
import { RunPolicy, RunLimitError } from "../../domain/run-policy.mjs";
import { NativeCodexSession, nativeUsage } from "./native-session.mjs";
import { assistantTools } from "../work-tools/assistant-tools.mjs";
import { validArguments } from "../work-tools/validate-arguments.mjs";

class WaitingForOwner extends Error {
  constructor(interaction) {
    super("Codex execution is waiting for its owner");
    this.interaction = interaction;
  }
}
// Same execution contract as Pi; only native lifecycle differs. No Shell or arbitrary I/O.
const instruction =
  workInstruction +
  " Recovery receipts describe already-observed host effects or answers: use them instead of publishing or asking the same question again. A read receipt does not authorize a fresh read. Truncated output must not be claimed as fully read. Report the final result to the parent.";
export class CodexExecutionAdapter {
  constructor(options) {
    Object.assign(this, options);
    this.config = structuredClone(options.config);
    this.sessions = new Map();
    this.suspending = false;
    this.onUsageError ??= () => {};
    this.afterAdmission ??= () => {};
    this.afterInteractionRequest ??= () => {};
    this.afterToolEffect ??= () => {};
    this.afterNativeResult ??= () => {};
  }
  async run(work, signal) {
    const execution = this.executions.execution(work);
    if (execution.harness !== "codex") throw new Error("Codex cannot take over another harness execution");
    const policy = RunPolicy.resolve(this.profile.config.runPolicy),
      controller = new AbortController(),
      combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const entry = { controller };
    this.sessions.set(execution.id, entry);
    const timer = setTimeout(
      () => controller.abort(new RunLimitError("work-timeout", policy.workTimeoutMs)),
      policy.workTimeoutMs,
    );
    timer.unref?.();
    const started = performance.now();
    let outcome = "returned";
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.execute(work, execution, combined, policy);
        } catch (error) {
          if (error instanceof WaitingForOwner) {
            outcome = "waiting_input";
            return { status: "waiting_input", workId: work.id };
          }
          if (
            error.code === "CODEX_NATIVE_EXITED" &&
            !combined.aborted &&
            !this.suspending &&
            attempt < policy.maxRetries
          )
            continue;
          outcome = this.suspending ? "suspended" : combined.aborted ? "aborted" : "error";
          throw error;
        }
      }
    } finally {
      clearTimeout(timer);
      this.sessions.delete(execution.id);
      this.executions.observeRun(work, {
        elapsedMs: performance.now() - started,
        outcome,
      });
    }
  }
  async execute(work, execution, signal, policy) {
    signal.throwIfAborted();
    if (this.suspending) throw new Error("Runner is suspending");
    this.executions.assertCurrent(work);
    let rows = this.executions.nativeCalls(work);
    const saved = rows.find((r) => r.call_id === "__final__" && r.state === "completed");
    if (saved) return JSON.parse(saved.output_json).text;
    const ioController = new AbortController(),
      ioSignal = AbortSignal.any([signal, ioController.signal]);
    const predecessor = this.executions.predecessor(work);
    const inheritedBinding = execution.conversation_id ?? predecessor?.conversation_id;
    const previousBinding = inheritedBinding ? JSON.parse(inheritedBinding) : null;
    // A durable work owns its accepted route, even after the owner's next-task choice changes.
    const config =
      this.config.managed && previousBinding?.providerId
        ? {
            ...this.config,
            providerId: previousBinding.providerId,
            modelId: previousBinding.modelId,
          }
        : this.config;
    const snapshot = this.executions.snapshot(work),
      ports = this.toolsFor(work, snapshot),
      root = codexSessionRoot(this.profile, execution.session_root ?? execution.id);
    let session,
      threadId,
      turnId,
      resolveTurn,
      rejectTurn,
      acceptTurn,
      queue = Promise.resolve(),
      boundaryError,
      waiting,
      usage,
      turnTimer,
      early = [],
      runningTurn = false;
    const finished = new Promise((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    finished.catch(() => {});
    const accepted = new Promise((resolve) => {
      acceptTurn = resolve;
    });
    const tools = assistantTools({
        ports,
        snapshot,
        artifactStore: this.artifactStore,
        knowledgeSource: this.knowledgeSource,
        onBoundaryError: (e) => {
          boundaryError = e;
        },
      }),
      byName = new Map(tools.map((t) => [t.name, t]));
    const saveUsage = () => {
      if (usage)
        try {
          this.recordUsage(
            work.id,
            {
              models: { [`codex/${config.modelId}`]: nativeUsage(usage) },
            },
            "model",
            {
              engine: "codex",
              executionId: execution.session_root ?? execution.id,
            },
          );
        } catch (e) {
          this.onUsageError(e);
        }
    };
    const runTool = async (callId, name, args) => {
      ioSignal.throwIfAborted();
      this.executions.assertCurrent(work);
      const tool = byName.get(name);
      if (!tool || !validArguments(tool.parameters, args)) throw new Error("Unknown host tool or invalid arguments");
      // Guard even cached results: a receipt cannot widen the original grant.
      try {
        ports.assertAction(
          name,
          name === "list_materials" || name === "read_material"
            ? this.knowledgeSource?.reference()
            : name === "environment_run"
              ? snapshot.delegation.resources.find((r) => r.id === "execution.environment")
              : undefined,
          name === "publish_note"
            ? snapshot.explicitMemoryEpoch === undefined
              ? snapshot.memoryEpoch
              : { epoch: snapshot.explicitMemoryEpoch }
            : undefined,
        );
      } catch (error) {
        boundaryError = error;
        throw error;
      }
      const known = this.executions.nativeCalls(work).some((row) => row.call_id === callId);
      const receipt = this.executions.prepareNativeCall(work, callId, name, args);
      if (receipt.state === "completed") {
        if (!["publish_note", "ask_user", "request_intervention", "thread_command", "environment_run"].includes(name))
          throw new Error("This read already completed; use a new call ID for a freshly authorized read");
        return JSON.parse(receipt.output_json);
      }
      if (tool.replay !== "safe" && !(tool.replay === "once" && !known))
        throw Object.assign(new Error("Unknown native tool outcome requires explicit reconciliation"), {
          code: "ENVIRONMENT_OUTCOME_UNKNOWN",
        });
      try {
        const result = await tool.execute(
          args,
          { callId },
          {
            abortSignal: ioSignal,
            suspend: (interaction) => {
              throw new WaitingForOwner(interaction);
            },
          },
        );
        this.afterToolEffect(name, callId);
        ioSignal.throwIfAborted();
        this.executions.assertCurrent(work);
        const output = {
          contentItems: result.output.map((c) => ({
            type: "inputText",
            text: c.text,
          })),
          success: true,
        };
        this.executions.nativeOutcome(
          work,
          callId,
          "completed",
          ["publish_note", "ask_user", "request_intervention", "environment_run"].includes(name)
            ? output
            : { success: true, read: true, outputHash: digest(output) },
        );

        return output;
      } catch (error) {
        if (error instanceof WaitingForOwner) {
          this.executions.nativeOutcome(work, callId, "waiting", {
            interactionId: error.interaction.id,
          });
          this.afterInteractionRequest();
          throw error;
        }
        if (
          ioSignal.aborted ||
          error.code === "ENVIRONMENT_OUTCOME_UNKNOWN" ||
          boundaryError ||
          error.code?.startsWith("RUN_LIMIT_")
        )
          throw error;
        const output = {
          contentItems: [{ type: "inputText", text: String(error.message).slice(0, 1000) }],
          success: false,
        };
        this.executions.nativeOutcome(work, callId, "completed", output);

        return output;
      }
    };
    const nativeEvent = (p) => {
      const v = p.params;
      if ((v.turnId ?? v.turn?.id) !== turnId) return;
      if (p.method === "turn/completed") {
        clearTimeout(turnTimer);
        if (v.turn.status !== "completed") {
          rejectTurn(nativeTurnFailure(v.turn, this.telemetry, "execution"));
          return;
        }
        const text = currentText;
        try {
          signal.throwIfAborted();
          this.executions.assertCurrent(work);
          if (boundaryError) throw boundaryError;
          this.executions.prepareNativeCall(work, "__final__", "__final__", {
            threadId,
            executionId: execution.id,
          });
          this.executions.nativeOutcome(work, "__final__", "completed", {
            text,
            nativeTurnId: turnId,
          });
          this.afterNativeResult();
          resolveTurn(text);
        } catch (e) {
          rejectTurn(e);
        }
      }
      if (p.method === "item/completed" && v.item?.type === "agentMessage" && v.item.phase !== "commentary")
        currentText = v.item.text;
    };
    let currentText = "";
    try {
      session = await NativeCodexSession.open(config, {
        resolveModel: this.resolveModel,
        modelRole: "execution",
        home: join(root, "home"),
        cwd: join(root, "empty"),
        signal,
        modelTimeoutMs: policy.modelTimeoutMs,
        telemetry: this.telemetry,
        onFailure: (e) => {
          ioController.abort(e);
          rejectTurn(waiting ?? boundaryError ?? e);
        },
        onNotification: (p) => {
          if (!p.params || p.params.threadId !== threadId) return;
          if (p.method === "thread/tokenUsage/updated") {
            const u = p.params.tokenUsage?.total;
            if (u && (!usage || u.totalTokens >= usage.totalTokens)) {
              usage = u;
              saveUsage();
            }
          }
          if (runningTurn && ["item/completed", "turn/completed"].includes(p.method))
            turnId ? nativeEvent(p) : early.push(p);
        },
        onRequest: (p) => {
          if (p.method !== "item/tool/call" || p.params.threadId !== threadId)
            throw new Error("Unexpected native host authority request");
          const job = queue.then(async () => {
            const id = await accepted;
            if (p.params.turnId !== id) throw new Error("Native tool belongs to a different turn");
            if (waiting) throw waiting;
            const { callId: nativeCallId, tool, arguments: args } = p.params;
            const callId = "tool:" + p.params.turnId + ":" + nativeCallId;
            const reply = (output) => {
              this.executions.modelStep(work, "codex-reply:" + p.params.turnId + ":" + p.id, policy.maxSteps);
              return output;
            };
            try {
              return reply(await runTool(callId, tool, args));
            } catch (error) {
              if (error.code === "ENVIRONMENT_OUTCOME_UNKNOWN") {
                boundaryError = error;
                ioController.abort(error);
                session.fail(error);
                rejectTurn(error);
                throw error;
              }
              if (error instanceof WaitingForOwner) {
                waiting = error;
                session.fail(error);
                throw error;
              }
              if (boundaryError || ioSignal.aborted || error.code?.startsWith("RUN_LIMIT_")) throw error;
              return reply({
                contentItems: [
                  {
                    type: "inputText",
                    text: String(error.message).slice(0, 1000),
                  },
                ],
                success: false,
              });
            }
          });
          queue = job.catch(() => {});
          return job;
        },
      });
      let native;
      if (inheritedBinding) {
        const binding = JSON.parse(inheritedBinding);
        if (
          binding.engine !== "codex" ||
          binding.modelId !== config.modelId ||
          binding.baseUrl !== config.baseUrl ||
          (binding.providerId ?? null) !== (config.providerId ?? null)
        )
          throw new Error("Codex execution backend binding differs; restore its explicit configuration");
        threadId = binding.threadId;
        native = (
          await session.rpc("thread/resume", {
            threadId,
            model: config.modelId,
            modelProvider: "superapp",
            excludeTurns: true,
            config: session.settings,
            baseInstructions:
              instruction +
              (this.profile.config.botPresentation
                ? "\nOwner-configured identity and responsibilities, not additional grants: " +
                  JSON.stringify(this.profile.config.botPresentation)
                : ""),
          })
        ).thread;
        if (!execution.conversation_id)
          this.executions.bound(work, binding, { engine: "codex", requestId: execution.id }, { admitted: false });
      } else {
        native = (
          await session.rpc("thread/start", {
            model: config.modelId,
            cwd: join(root, "empty"),
            ephemeral: false,
            approvalPolicy: "never",
            sandbox: "read-only",
            baseInstructions:
              instruction +
              (this.profile.config.botPresentation
                ? "\nOwner-configured identity and responsibilities, not additional grants: " +
                  JSON.stringify(this.profile.config.botPresentation)
                : ""),
            dynamicTools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: JSON.parse(JSON.stringify(t.parameters)),
            })),
          })
        ).thread;
        threadId = native.id;
        // thread/start is lazy; the native metadata operation materializes and
        // flushes this empty thread before we commit its binding.
        await session.rpc("thread/name/set", {
          threadId,
          name: "superapp:" + execution.id,
        });
        this.executions.bound(
          work,
          {
            engine: "codex",
            threadId,
            modelId: config.modelId,
            ...(config.managed ? { providerId: config.providerId } : { baseUrl: config.baseUrl }),
          },
          { engine: "codex", requestId: execution.id },
          { admitted: false },
        );
        this.afterAdmission();
      }
      // Reconcile received host calls before any new model request. Native pending RPCs
      // do not survive app-server restart; continuation uses these owner-checked receipts.
      for (const row of rows.filter((r) => !r.tool.startsWith("__") && r.state !== "completed"))
        await runTool(row.call_id, row.tool, JSON.parse(row.args_json));
      rows = this.executions.nativeCalls(work);
      const last = execution.conversation_id
        ? (
            await session.rpc("thread/turns/list", {
              threadId,
              limit: 1,
              sortDirection: "desc",
              itemsView: "summary",
            })
          ).data[0]
        : undefined;
      if (last?.status === "completed") {
        const first = await session.rpc("thread/items/list", {
          threadId,
          turnId: last.id,
          limit: 1,
          sortDirection: "asc",
        });
        const tail = await session.rpc("thread/items/list", {
          threadId,
          turnId: last.id,
          limit: 16,
          sortDirection: "desc",
        });
        last.items = [...first.data, ...tail.data.reverse()];
      }
      const message = last?.items?.find((i) => i.type === "userMessage");
      let envelope;
      try {
        envelope = JSON.parse(
          message?.content
            ?.filter((c) => c.type === "text")
            .map((c) => c.text)
            .join(""),
        );
      } catch {}
      if (
        last?.status === "completed" &&
        envelope?.executionId === execution.id &&
        rows.some((r) => r.call_id === envelope.hostRequestId && r.tool === "__turn__")
      ) {
        const final = last.items.findLast((i) => i.type === "agentMessage" && i.phase !== "commentary");
        if (final && typeof final.text === "string") {
          this.executions.bound(work, JSON.parse(execution.conversation_id), JSON.parse(execution.submission_id));
          this.executions.prepareNativeCall(work, "__final__", "__final__", {
            threadId,
            executionId: execution.id,
          });
          this.executions.nativeOutcome(work, "__final__", "completed", {
            text: final.text,
            nativeTurnId: last.id,
          });
          return final.text;
        }
      }
      const hostRequestId = `turn:${rows.filter((r) => r.tool === "__turn__").length}`;
      const recovery = rows
        .filter((r) => !r.tool.startsWith("__"))
        .slice(-32)
        .map((r) => ({
          callId: r.call_id,
          tool: r.tool,
          state: r.state,
          output: ["publish_note", "ask_user", "request_intervention"].includes(r.tool)
            ? r.output_json?.slice(0, 2000)
            : "Previous read completed; request a fresh authorized read if native history is insufficient.",
          truncated:
            ["publish_note", "ask_user", "request_intervention"].includes(r.tool) &&
            (r.output_json?.length ?? 0) > 2000,
        }));
      const input = {
        executionId: execution.id,
        hostRequestId,
        snapshot,
        recovery,
      };
      this.executions.prepareNativeCall(work, hostRequestId, "__turn__", {
        inputHash: digest(input),
      });
      this.executions.modelStep(work, `codex:${hostRequestId}`, policy.maxSteps);
      runningTurn = true;
      turnTimer = setTimeout(
        () => session.fail(new RunLimitError("model-timeout", policy.modelTimeoutMs)),
        policy.modelTimeoutMs,
      );
      turnTimer.unref?.();
      const started = await session.rpc("turn/start", {
        threadId,
        input: [{ type: "text", text: JSON.stringify(input), text_elements: [] }],
      });
      turnId = started.turn?.id;
      if (!turnId) throw new Error("Codex did not return a native turn identity");
      this.executions.bound(
        work,
        {
          engine: "codex",
          threadId,
          modelId: config.modelId,
          ...(config.managed ? { providerId: config.providerId } : { baseUrl: config.baseUrl }),
        },
        { engine: "codex", requestId: execution.id },
      );
      acceptTurn(turnId);
      this.executions.nativeOutcome(work, hostRequestId, "completed", {
        threadId,
        turnId,
      });
      for (const p of early) nativeEvent(p);
      early = [];
      const answer = await finished;
      signal.throwIfAborted();
      return answer;
    } catch (error) {
      await enrichModelFailure(error, this.resolveModelFailure, "execution");
      acceptTurn(null);
      throw waiting ?? boundaryError ?? error;
    } finally {
      clearTimeout(turnTimer);
      acceptTurn(null);
      await session?.close();
      await queue;
      saveUsage();
    }
  }
  activeSessionCount() {
    return this.sessions.size;
  }
  async suspendAll() {
    this.suspending = true;
    for (const e of this.sessions.values()) e.controller.abort(new Error("Runner is suspending"));
  }
}
