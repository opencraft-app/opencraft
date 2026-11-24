import { LocalAttachmentStore } from "../adapters/filesystem/attachment-store.mjs";
import { withRequestDeadline } from "../adapters/local/request-deadline.mjs";
import { BotAuthority } from "./bot-authority.mjs";
import { PlatformChannels } from "../application/platform-channels.mjs";
import { MessageDispatcher } from "./message-dispatcher.mjs";
import { LocalMessageDelivery } from "../adapters/filesystem/message-delivery.mjs";
import { ConversationContextCoordinator } from "./conversation-context-coordinator.mjs";
import { ConversationContextModel } from "../adapters/models/conversation-context-model.mjs";
import { createExecutionPorts } from "./execution-ports.mjs";
import { FileEventSource } from "../adapters/filesystem/file-event-source.mjs";
import { MemoryLearningCoordinator } from "./memory-learning-coordinator.mjs";
import { MemoryLearningModel } from "../adapters/models/memory-learning-model.mjs";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { acquireOwnerLock } from "@opencraft/sqlite-node/writer-lock";
import { createLocalDomain } from "./create-local-domain.mjs";
import { ThreadCompletionCoordinator } from "./thread-completion-coordinator.mjs";
import { WorkCoordinator } from "./work-coordinator.mjs";
import { ReceptionCoordinator } from "./reception-coordinator.mjs";
import { DeliveryDispatcher } from "./delivery-dispatcher.mjs";
import { DirectoryKnowledgeSource } from "../adapters/filesystem/knowledge-source.mjs";
import { LocalArtifactStore } from "../adapters/filesystem/artifact-store.mjs";
import { LocalMailboxDelivery } from "../adapters/filesystem/mailbox-delivery.mjs";
import { ModelCatalog } from "../adapters/models/model-catalog.mjs";
import { ReceptionModel } from "../adapters/models/reception-model.mjs";
import { PiExecutionAdapter } from "../adapters/pi/pi-execution-adapter.mjs";
import { UnixSocketGateway } from "../adapters/local/unix-socket.mjs";
import { fault } from "../adapters/local/profile.mjs";
import { validateRequest } from "../interfaces/local-protocol.mjs";
import { ReceptionPlanner } from "../application/reception/planner.mjs";
import { resolveHarnesses } from "../adapters/codex/config.mjs";
import { CodexStructuredHarness } from "../adapters/codex/structured-harness.mjs";
import { CodexExecutionAdapter } from "../adapters/codex/codex-execution-adapter.mjs";
import { ExecutionRouter } from "./execution-router.mjs";
import { createLocalTelemetry } from "../adapters/telemetry/local-telemetry.mjs";

/** Composition/lifecycle root. It owns process resources; application services own business decisions. */
/** Upper bound for noticing memory files edited outside a unit of work. */
export const MEMORY_FILE_SYNC_MS = 2000;

export class LocalRunner {
  constructor(profile) {
    this.profile = profile;
    this.stopping = false;
    this.pumping = false;
    this.healthError = null;
    this.phaseErrors = {};
  }
  static async open(profile, overrides = {}) {
    const runner = new LocalRunner(profile),
      onError = (error) => {
        runner.healthError = String(error);
      };
    try {
      // A process-lifetime kernel lock beside the profile (the former lease's path): a
      // stalled runner is never replaced, and its death frees the profile at once. The
      // retries (one second apart) wait out a runner that is still closing.
      runner.release = await acquireOwnerLock(
        `${await realpath(profile.path)}.lock`,
        { retries: 12 },
      );
      if (profile.config.botBinding && !overrides.platformChannelPort)
        throw Error("Managed Bot requires its Host authority port");
      if (overrides.platformChannelPort) {
        if (!profile.config.botBinding)
          throw Error("Platform channel access requires a Bot binding");
        runner.authority = new BotAuthority(
          profile.config.botBinding,
          overrides.platformChannelPort,
        );
        await runner.authority.refresh();
      }
      if (overrides.managedHarnesses) {
        if (!runner.authority || typeof overrides.resolveModel !== "function")
          throw Error("Managed model requires Host authority");
        // Runtime projection under the existing profile lock. Platform selection is authoritative.
        profile.config = {
          ...profile.config,
          mode: "model",
          harnesses: overrides.managedHarnesses,
        };
      }
      if (profile.config.harnesses?.codex?.managed && !overrides.resolveModel)
        throw Error("Managed model requires Host resolver");
      if (
        overrides.executionEnvironment &&
        (profile.config.harnesses?.execution !== "codex" ||
          !runner.authority ||
          typeof overrides.runEnvironment !== "function" ||
          overrides.executionEnvironment.id !== "execution.environment" ||
          typeof overrides.executionEnvironment.binding !== "string")
      )
        throw Error(
          "Isolated environment requires an authorized Codex execution binding",
        );
      runner.telemetry = createLocalTelemetry(profile);
      const knowledgeSource = profile.config.workspace
        ? new DirectoryKnowledgeSource(profile.config.workspace)
        : null;
      Object.assign(
        runner,
        createLocalDomain(profile, knowledgeSource, {
          claimWriter: true,
          executionEnvironment: overrides.executionEnvironment,
          attachmentMaxBytes: overrides.attachmentMaxBytes,
          platformThreads: overrides.platformChannelPort
            ? {
                id: "platform.threads",
                binding: JSON.stringify(profile.config.botBinding),
              }
            : null,
          platformReads: overrides.platformChannelPort
            ? { query: (...args) => runner.platformChannels.query(...args) }
            : null,
          // Crew work arrives from the Bot's teammates. Whether this Bot is in a space at all is the
          // Core's decision; the tools appear only in Work that answers crew work.
          crewWork: overrides.platformChannelPort && overrides.crewPort
            ? { id: "crew.work", binding: JSON.stringify(profile.config.botBinding) }
            : null,
          assertAuthority: runner.authority
            ? () => runner.authority.assertCurrent()
            : undefined,
        }),
      );
      if (runner.authority) {
        runner.platformChannels = new PlatformChannels(
          profile.config.botBinding,
          overrides.platformChannelPort,
          { assertWriter: () => runner.uow.assertWriter() },
        );
        runner.authorityTimer = setInterval(() => {
          void runner.authority.refresh().catch(onError);
        }, 2000);
        runner.authorityTimer.unref();
      }
      runner.fileEvents = new FileEventSource({
        source: knowledgeSource,
        watchedPaths: () => runner.app.triggers.watchedPaths(),
        observe: (...args) => runner.app.triggers.observe(...args),
        onError,
      });
      const harnesses = resolveHarnesses(profile.config);
      const required = runner.app.executions.requiredHarnesses();
      if (required.includes("codex") && !harnesses.codex)
        throw new Error(
          "Pending Codex executions require their explicit Codex configuration",
        );
      for (const binding of runner.app.executions
        .requiredNativeBindings()
        .filter((binding) => !binding.providerId))
        if (
          binding.modelId !== harnesses.codex?.modelId ||
          binding.baseUrl !== harnesses.codex?.baseUrl
        )
          throw new Error(
            "Pending Codex execution backend differs; restore its explicit model/endpoint or explicitly revise that work",
          );
      const catalog =
        harnesses.assistant === "pi" ||
        required.includes("pi") ||
        profile.config.mode === "fixture" ||
        profile.config.model
          ? await ModelCatalog.open(profile)
          : null;
      if (harnesses.assistant === "codex")
        runner.assistantHarness = new CodexStructuredHarness(harnesses.codex, {
          botPresentation: profile.config.botPresentation,
          telemetry: runner.telemetry,
          resolveModel: overrides.resolveModel,
          resolveModelFailure: overrides.resolveModelFailure,
          readAttachment: (id) => runner.attachmentStore.read(id),
        });
      if (harnesses.backgroundCodex)
        runner.backgroundHarness = new CodexStructuredHarness(
          harnesses.backgroundCodex,
          { telemetry: runner.telemetry },
        );
      // Fixture execution remains independent from an explicitly selected native assistant.
      const assistantCatalog = runner.assistantHarness
        ? { profile, configured: { mode: "model" } }
        : catalog;
      const modelOptions = {
        telemetry: runner.telemetry,
        transport: runner.assistantHarness,
        onUsageError: onError,
        policy: profile.config.runPolicy,
        recordUsage: (value) => {
          try {
            runner.app.usage.recordCall(value);
          } catch (error) {
            onError(error);
          }
        },
      };
      const backgroundCatalog = runner.backgroundHarness
        ? { profile, configured: { mode: "model" } }
        : assistantCatalog;
      const backgroundOptions = {
        ...modelOptions,
        transport: runner.backgroundHarness ?? runner.assistantHarness,
      };
      const threadCommand = overrides.platformChannelPort
        ? async (argv, workId, signal) => {
            runner.authority.assertCurrent();
            runner.uow.assertWriter();
            const result = await overrides.platformChannelPort.request(
              profile.config.botBinding,
              "opencraft/personal-assistant/threads/command",
              { argv, ...(workId ? { workId } : {}) },
              signal,
            );
            runner.authority.assertCurrent();
            runner.uow.assertWriter();
            return result;
          }
        : undefined;
      runner.threadCommand = threadCommand;
      const executionPorts = createExecutionPorts(
        runner.app,
        () => runner.uow.assertWriter(),
        threadCommand,
        runner.platformChannels,
        overrides.executionEnvironment
          ? {
              resource: overrides.executionEnvironment,
              run: overrides.runEnvironment,
            }
          : undefined,
        overrides.crewPort && runner.authority
          ? {
              ...overrides.crewPort,
              request: async (method, params, signal) => {
                runner.authority.assertCurrent();
                runner.uow.assertWriter();
                const result = await overrides.crewPort.request(method, params, signal);
                runner.authority.assertCurrent();
                runner.uow.assertWriter();
                return result;
              },
            }
          : undefined,
      );
      const commonExecution = {
        telemetry: runner.telemetry,
        profile,
        onUsageError: onError,
        ...executionPorts,
        knowledgeSource,
        artifactStore: new LocalArtifactStore(
          join(profile.path, "artifacts"),
          runner.attachmentStore,
        ),
        afterInteractionRequest: () =>
          fault(profile, "interaction-saved-before-suspend"),
      };
      const executor = new ExecutionRouter({
        executions: executionPorts.executions,
        factories: {
          pi: async () =>
            new PiExecutionAdapter({
              ...commonExecution,
              catalog: catalog ?? (await ModelCatalog.open(profile)),
              afterAdmission: () =>
                fault(profile, "pi-admitted-before-binding"),
            }),
          codex: () => {
            if (!harnesses.codex)
              throw new Error("Codex execution configuration is required");
            return new CodexExecutionAdapter({
              ...commonExecution,
              config: harnesses.codex,
              resolveModel: overrides.resolveModel,
              resolveModelFailure: overrides.resolveModelFailure,
              afterAdmission: () => fault(profile, "codex-bound-before-turn"),
              afterToolEffect: () =>
                fault(profile, "codex-tool-effect-before-receipt"),
              afterNativeResult: () =>
                fault(profile, "codex-result-before-report"),
            });
          },
        },
      });
      runner.work = new WorkCoordinator({
        telemetry: runner.telemetry,
        app: runner.app,
        executor,
        concurrency: profile.config.concurrency,
        afterResult: (kind) =>
          fault(
            profile,
            kind === "report"
              ? "report-saved-before-reception"
              : "result-saved-before-delivery",
          ),
        onError,
      });
      if (threadCommand)
        runner.threadCompletions = new ThreadCompletionCoordinator({
          app: runner.app,
          command: threadCommand,
          settle: (...args) => runner.work.settleReport(...args),
          assertOwner: () => {
            runner.authority.assertCurrent();
            runner.uow.assertWriter();
          },
          onError: () =>
            runner.telemetry?.event("thread-completion.observation-failed", {
              "app.error_type": "observation_failed",
            }),
        });
      runner.reception = new ReceptionCoordinator(
        runner.app.reception,
        new ReceptionPlanner(
          overrides.receptionModel ??
            new ReceptionModel(assistantCatalog, modelOptions),
          runner.app.receptionQueries,
        ),
        {
          context: new ConversationContextCoordinator(
            runner.app.conversationContext,
            overrides.contextModel ??
              new ConversationContextModel(
                backgroundCatalog,
                backgroundOptions,
              ),
            {
              telemetry: runner.telemetry,
              timeoutMs: Math.min(
                30000,
                profile.config.runPolicy.modelTimeoutMs,
              ),
              // The coordinator durably records a failed best-effort summary and
              // reception continues with the bounded original-history gap. Do not
              // poison runtime health: Host/group observers would retire its
              // transport and cancel the foreground turn. Usage persistence and
              // authority failures still use the fatal onError paths above.
              onError: () =>
                runner.telemetry?.event("context.summary-unavailable", {
                  "app.error_type": "summary_unavailable",
                }),
              afterProposal: () =>
                fault(profile, "context-proposed-before-commit"),
              afterCommit: () =>
                fault(profile, "context-saved-before-reception"),
            },
          ),
          afterProposal: (turn) =>
            fault(
              profile,
              turn.source_json
                ? "report-proposed-before-commit"
                : "reception-proposed-before-commit",
            ),
          onError,
          telemetry: runner.telemetry,
          timeoutMs: profile.config.runPolicy.modelTimeoutMs,
        },
      );
      runner.learning = new MemoryLearningCoordinator(
        runner.app.memoryLearning,
        overrides.memoryLearningModel ??
          new MemoryLearningModel(backgroundCatalog, backgroundOptions),
        onError,
        {
          telemetry: runner.telemetry,
          timeoutMs: Math.min(
            profile.config.memoryPolicy.deadlineMs,
            profile.config.runPolicy.modelTimeoutMs,
          ),
        },
      );
      runner.delivery = new DeliveryDispatcher(
        runner.app,
        new LocalMailboxDelivery(join(profile.path, "mailbox"), {
          afterWrite: () => fault(profile, "mailbox-written-before-receipt"),
        }),
        () => runner.uow.assertWriter(),
      );
      runner.messages = new MessageDispatcher(
        runner.app.messages,
        overrides.messageTransport ??
          new LocalMessageDelivery(
            join(profile.path, "outgoing"),
            runner.attachmentStore,
            {
              afterWrite: () =>
                fault(profile, "message-written-before-receipt"),
            },
          ),
        onError,
        () => runner.uow.assertWriter(),
      );
      if (overrides.localSocket !== false) {
        runner.gateway = new UnixSocketGateway(profile.socket, (request) =>
          runner.dispatch(request),
        );
        await runner.gateway.open();
      }
      runner.timer = setInterval(() => runner.pump(), 50);
      runner.pump();
      return runner;
    } catch (error) {
      await runner.close();
      throw error;
    }
  }
  dispatch(raw) {
    if (this.authority)
      return this.authority.refresh().then(() => this.dispatchCurrent(raw));
    return this.dispatchCurrent(raw);
  }
  dispatchCurrent(raw) {
    if (this.stopping) throw new Error("Runner is closing");
    this.uow.assertWriter();
    const request = validateRequest(raw);
    if (request.op === "thread.command") {
      if (!this.threadCommand) throw Error("Platform threads unavailable");
      if (Object.keys(request.params).some((k) => k !== "argv"))
        throw Error("Invalid thread command");
      return withRequestDeadline(
        (signal) => this.threadCommand(request.params.argv, undefined, signal),
        this.authority.controller.signal,
        30000,
      );
    }
    if (
      request.op.startsWith("channels.") ||
      request.op.startsWith("platform.")
    ) {
      const c = this.platformChannels,
        p = request.params;
      if (!c) throw Error("Platform channels unavailable");
      return withRequestDeadline(
        (signal) => {
          if (request.op.startsWith("platform."))
            return c.query(request.op, p, signal);
          switch (request.op) {
            case "channels.list":
              return c.list(signal);
            case "channels.history":
              return c.history(p.channelId, p, signal);
            case "channels.search":
              return c.search(p.channelId, p, signal);
            case "channels.send":
              return c.send(p.channelId, p, signal);
            default:
              throw Error("Unknown platform channel operation");
          }
        },
        this.authority.controller.signal,
        15000,
      );
    }
    const result = this.app.dispatch(request);
    if (request.op === "status")
      return {
        ...result,
        active: this.work.active.size,
        receptionActive: !!this.reception.task,
        healthError: this.healthError,
        telemetry: this.telemetry?.health(),
        phaseErrors: this.phaseErrors,
      };
    this.pump();
    return result;
  }
  pump() {
    if (this.stopping || this.pumping) return;
    this.pumping = true;
    try {
      try {
        this.uow.assertWriter();
      } catch (error) {
        this.healthError = String(error);
        return;
      }
      const phases = {
        fileEvents: () => this.fileEvents.tick(),
        routines: () => this.app.routines.tick(),
        interactions: () => this.app.interactions.expire(),
        threadCompletions: () => this.threadCompletions?.tick(),
        work: () => this.work.tick(),
        reception: () => this.reception.tick(),
        delivery: () => this.delivery.tick(),
        messages: () => this.messages.tick(),
        learning: () => this.learning.tick(),
        notifications: () => this.app.notifications.flush(),
        // Idle phases no longer open units of work every pump. Entering one is
        // what detects external memory file edits, so keep a bounded cadence.
        memoryFiles: () => {
          if (Date.now() < (this.memoryFilesAt ?? 0)) return;
          this.memoryFilesAt = Date.now() + MEMORY_FILE_SYNC_MS;
          this.uow.transaction(() => {});
        },
      };
      for (const [name, run] of Object.entries(phases)) {
        if (this.phaseErrors[name]?.nextAt > Date.now()) continue;
        try {
          run();
          const previous = this.phaseErrors[name];
          delete this.phaseErrors[name];
          if (previous && this.healthError === previous.error)
            this.healthError =
              Object.values(this.phaseErrors).at(-1)?.error ?? null;
        } catch (error) {
          const attempts = (this.phaseErrors[name]?.attempts ?? 0) + 1;
          this.healthError = String(error);
          this.phaseErrors[name] = {
            error: String(error),
            attempts,
            nextAt:
              Date.now() +
              Math.min(30000, 250 * 2 ** Math.min(attempts - 1, 7)),
          };
        }
      }
    } finally {
      this.pumping = false;
    }
  }
  close() {
    if (this.closing) return this.closing;
    this.stopping = true;
    this.closing = (async () => {
      clearInterval(this.timer);
      const errors = [];
      const close = async (action) => {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      };
      clearInterval(this.authorityTimer);
      await close(() => this.gateway?.close());
      await close(() => this.reception?.suspend());
      await close(() => this.threadCompletions?.close());
      await close(() => this.work?.suspend());
      await close(() => this.learning?.suspend());
      await close(() => this.messages?.close());
      await close(() => this.assistantHarness?.close());
      await close(() => this.backgroundHarness?.close());
      await close(() => this.telemetry?.close());
      await close(() => this.authority?.close());
      await close(() => this.uow?.close());
      if (this.release) {
        const release = this.release;
        this.release = null;
        await close(release);
      }
      if (errors.length)
        throw new AggregateError(
          errors,
          "Runner cleanup failed after releasing owned resources",
        );
    })();
    return this.closing;
  }
}
