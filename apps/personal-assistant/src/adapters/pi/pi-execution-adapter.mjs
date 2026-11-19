import { piSessionPath } from "../local/profile-layout.mjs";
import { workInstruction } from "../work-tools/instruction.mjs";
import { RunPolicy } from "../../domain/run-policy.mjs";
import { PiRunGuard } from "./run-guard.mjs";
import { readNativeUsage } from "./native-usage.mjs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  hook,
  GenerationTask,
  ToolTask,
  createRegistry,
  defineExtension,
  section,
  Harness,
  AssistantEntry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { assistantTools } from "./assistant-tools.mjs";

/** @implements {import('../../ports/contracts.mjs').ExecutionPort} */
export class PiExecutionAdapter {
  constructor({
    profile,
    executions,
    toolsFor,
    recordUsage,
    report,
    catalog,
    artifactStore,
    knowledgeSource,
    onUsageError = () => {},
    afterAdmission = () => {},
    afterInteractionRequest = () => {},
  }) {
    Object.assign(this, {
      profile,
      executions,
      toolsFor,
      recordUsage,
      report,
      catalog,
      artifactStore,
      knowledgeSource,
      onUsageError,
      afterAdmission,
      afterInteractionRequest,
    });
    this.sessions = new Map();
    this.suspending = false;
  }
  async run(work, signal) {
    if (this.executions.execution(work).harness !== "pi")
      throw new Error("Pi cannot take over another harness execution");
    const execution = this.executions.execution(work),
      snapshot = this.executions.snapshot(work),
      choice = this.catalog.forExecution(execution.id);
    let boundaryError,
      interactionPause = false,
      pauseTask,
      runError;
    const policy = RunPolicy.resolve(this.profile.config.runPolicy);
    const runGuard = new PiRunGuard({
      policy,
      step: (taskId) => this.executions.modelStep(work, taskId, policy.maxSteps),
    });
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "personal-assistant-lab",
        hooks: [
          hook(GenerationTask, {
            beforeRequest: (...args) => runGuard.beforeRequest(...args),
          }),
          hook(ToolTask, {
            beforeTool: (...args) => runGuard.beforeTool(...args),
          }),
        ],
        sections: [section("preamble", () => workInstruction, { tag: false })],
        tools: assistantTools({
          ports: this.toolsFor(work, snapshot),
          snapshot,
          artifactStore: this.artifactStore,
          knowledgeSource: this.knowledgeSource,
          onBoundaryError: (error) => {
            boundaryError = error;
          },
          onInteractionWait: () => {
            interactionPause = true;
            runGuard.pause();
            this.afterInteractionRequest();
            pauseTask = harness.close(context);
            void pauseTask.catch(() => {});
          },
        }),
      }),
    );
    const storage = await openNodeSqliteStorage(piSessionPath(this.profile, work.id));
    let harness, root, samplingTask, usageTimer;
    const sampleUsage = () => {
      if (samplingTask || !harness) return samplingTask;
      samplingTask = harness
        .usage(context)
        .then((state) => this.recordUsage(work.id, state, this.profile.config.mode))
        .catch((error) => {
          if (!this.suspending && !interactionPause) this.onUsageError(error);
        })
        .finally(() => {
          samplingTask = null;
        });
      return samplingTask;
    };
    try {
      harness = await Harness.open(
        storage,
        {
          models: choice.models,
          registry,
          settings: {
            stream: {
              timeoutMs: policy.modelTimeoutMs,
              maxRetries: policy.maxRetries,
            },
            retry: { maxRetries: policy.maxRetries },
          },
          onReport: (error) => this.report(work.id, error),
        },
        context,
      );
      if (this.suspending) throw new Error("Runner is suspending");
      root = await harness.root(context, { agent: { model: choice.model } });
      if (this.suspending) throw new Error("Runner is suspending");
      this.sessions.set(work.id, { harness, root, runGuard });
      runGuard.start({ abort: () => root.abort(context) });
      usageTimer = setInterval(sampleUsage, 2000);
      usageTimer.unref?.();
      void sampleUsage();
      const existing = await storage.submissionByRequest(root.id, execution.id, context);
      if (!existing) await root.abort(context);
      await root.configure({ model: choice.model }, context);
      this.executions.assertCurrent(work);
      if (signal.aborted) throw new Error("Execution superseded before admission");
      const onAbort = () => {
        runGuard.abort();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const submission = await root.submit(
          {
            type: "input",
            requestId: execution.id,
            whenBusy: "reject",
            content: JSON.stringify(snapshot),
            entry: {
              kind: "superapp.work-input",
              data: {
                inputId: execution.input_id,
                workId: work.id,
                revision: work.revision,
              },
            },
          },
          context,
        );
        this.afterAdmission();
        this.executions.bound(work, root.id, submission.id);
        const settled = await submission.wait(context);
        if (runGuard.error) throw runGuard.error;
        if (boundaryError) throw boundaryError;
        if (settled.status !== "done" || settled.type !== "input")
          throw new Error(
            `Pi submission did not finish: ${settled.reason ?? settled.status}${typeof settled.detail === "string" ? `: ${settled.detail.slice(0, 2000)}` : ""}`,
          );
        const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
        const text = (answer?.model ?? [])
          .flatMap((m) =>
            Array.isArray(m.content) ? m.content.filter((v) => v.type === "text").map((v) => v.text) : [],
          )
          .join("\n");
        this.executions.assertCurrent(work);
        return text;
      } finally {
        signal.removeEventListener("abort", onAbort);
        await runGuard.close();
      }
    } catch (error) {
      runError = runGuard.error ?? error;
      if (interactionPause && !signal.aborted) return { status: "waiting_input", workId: work.id };
      throw runGuard.error ?? error;
    } finally {
      clearInterval(usageTimer);
      await runGuard.close();
      if (runGuard.elapsedMs !== undefined)
        this.executions.observeRun(work, {
          elapsedMs: runGuard.elapsedMs,
          outcome:
            runGuard.error?.code ??
            (interactionPause
              ? "waiting_input"
              : this.suspending
                ? "suspended"
                : signal.aborted
                  ? "aborted"
                  : runError
                    ? "error"
                    : "returned"),
        });
      if (samplingTask) await samplingTask;
      this.sessions.delete(work.id);
      if (pauseTask) await pauseTask;
      if (harness) await harness.close(context);
      else await storage.close(context);
      try {
        const state = await readNativeUsage(piSessionPath(this.profile, work.id), choice.models);
        this.recordUsage(work.id, state, this.profile.config.mode);
      } catch (error) {
        this.onUsageError(error);
      }
    }
  }
  activeSessionCount() {
    return this.sessions.size;
  }
  async suspendAll() {
    this.suspending = true;
    await Promise.all(
      [...this.sessions.values()].map((s) => {
        s.runGuard.pause();
        return s.harness.close(context);
      }),
    );
  }
}
