import { performance } from "node:perf_hooks";
import { initProfile } from "../src/adapters/local/profile.mjs";
import { createLocalDomain } from "../src/runtime/create-local-domain.mjs";
import { ModelCatalog } from "../src/adapters/models/model-catalog.mjs";
import { MemoryLearningModel } from "../src/adapters/models/memory-learning-model.mjs";
import { ConversationContextModel } from "../src/adapters/models/conversation-context-model.mjs";
import { ReceptionModel } from "../src/adapters/models/reception-model.mjs";
import { MemoryLearningCoordinator } from "../src/runtime/memory-learning-coordinator.mjs";
import { ConversationContextCoordinator } from "../src/runtime/conversation-context-coordinator.mjs";
import { ReceptionPlanner } from "../src/application/reception/planner.mjs";
import { resolveHarnesses } from "../src/adapters/codex/config.mjs";
import { CodexStructuredHarness } from "../src/adapters/codex/structured-harness.mjs";
import { createLocalTelemetry } from "../src/adapters/telemetry/local-telemetry.mjs";

/** Recorded-history replay plus the original assistant's memory, summary and read-only QA path.
 * No SQL, gold facts, alternative retrieval engine, historical tool execution or external delivery. */
export async function evaluateAssistant(
  input,
  { directory, mode, model, harnesses, signal = new AbortController().signal },
) {
  let clock = input.history[0].at;
  const profile = initProfile(directory, "isolated-evaluation-human", {
    mode,
    model,
    ...(harnesses ? { harnesses } : {}),
    fixtureDelayMs: 0,
    timeZone: "UTC",
    concurrency: 1,
    memoryPolicy: { debounceMs: 0 }, // Replay settles each user exchange; recorded explicitly in run metadata.
  });
  const { app, uow } = createLocalDomain(profile, null, { now: () => clock });
  let learning, transport, backgroundTransport;
  const telemetry = createLocalTelemetry(profile);
  try {
    const replay = async () => {
      const selected = resolveHarnesses(profile.config);
      if (selected.assistant === "codex")
        transport = new CodexStructuredHarness(selected.codex, { telemetry });
      if (selected.backgroundCodex)
        backgroundTransport = new CodexStructuredHarness(
          selected.backgroundCodex,
          { telemetry },
        );
      const catalog = transport
        ? { profile, configured: { mode: "model" } }
        : await ModelCatalog.open(profile);
      const options = {
        telemetry,
        transport,
        recordUsage: (value) => app.usage.recordCall(value),
        policy: profile.config.runPolicy,
      };
      const backgroundCatalog = backgroundTransport
        ? { profile, configured: { mode: "model" } }
        : catalog;
      const backgroundOptions = {
        ...options,
        transport: backgroundTransport ?? transport,
      };
      learning = new MemoryLearningCoordinator(
        app.memoryLearning,
        new MemoryLearningModel(backgroundCatalog, backgroundOptions),
        undefined,
        { telemetry },
      );
      const context = new ConversationContextCoordinator(
        app.conversationContext,
        new ConversationContextModel(backgroundCatalog, backgroundOptions),
        { telemetry },
      );
      const planner = new ReceptionPlanner(
        new ReceptionModel(catalog, options),
        app.receptionQueries,
      );
      const learningStates = {};
      let messages = 0,
        exchanges = 0;
      const indexingStart = performance.now();
      for (let s = 0; s < input.history.length; s++) {
        const session = input.history[s];
        for (let i = 0; i < session.messages.length; i++) {
          signal.throwIfAborted();
          const message = session.messages[i],
            identity = `replay:${s}:${i}`;
          clock = session.at;
          if (message.role === "assistant") {
            app.history.append(
              app.history.main.id,
              identity,
              "assistant",
              message.content,
              { kind: "historical-replay" },
            );
            messages++;
            continue;
          }
          const turn = {
            id: identity,
            conversation_id: app.history.main.id,
            text: message.content,
            created_at: clock,
            query_scope_json: JSON.stringify(
              app.scope.queryGrant(identity, app.history.main.id),
            ),
          };
          app.history.append(
            app.history.main.id,
            identity,
            "user",
            message.content,
            { kind: "historical-replay" },
          );
          messages++;
          await context.prepare(turn, signal);
          const next = session.messages[i + 1];
          const reply = next?.role === "assistant" ? next.content : "";
          if (reply) {
            app.history.append(
              app.history.main.id,
              `${identity}:reply`,
              "assistant",
              reply,
              { kind: "historical-replay" },
            );
            messages++;
            i++;
          }
          app.uow.transaction(() => app.memoryLearning.capture(turn, reply));
          const id = `learning:${identity}`;
          // Native bounded retries retain their original state. Virtual time only advances native backoff.
          for (let attempt = 0; attempt < 4; attempt++) {
            const state = app.memoryLearning.get(id);
            if (!state || !["queued", "proposed"].includes(state.state)) break;
            clock = Math.max(clock, state.next_at ?? clock);
            const job = app.memoryLearning
              .pending()
              .find((row) => row.id === id);
            if (!job)
              throw new Error("Native learning job did not become ready");
            await learning.process(job, signal);
            signal.throwIfAborted();
          }
          const state = app.memoryLearning.get(id)?.state ?? "disabled";
          if (["queued", "proposed"].includes(state))
            throw new Error("Native learning retry budget exhausted");
          learningStates[state] = (learningStates[state] ?? 0) + 1;
          exchanges++;
        }
      }
      const indexingMs = performance.now() - indexingStart;
      clock = input.queryAt;
      const queryStart = performance.now();
      app.reception.accept("evaluation-query", { text: input.question });
      const turn = app.reception.turn("evaluation-query");
      await context.prepare(turn, signal);
      const plan = await planner.plan(
        turn,
        app.reception.context(turn),
        signal,
      );
      signal.throwIfAborted();
      // This adapter benchmarks memory QA only. A task/command decision is recorded as a failure, never fabricated into an answer.
      if (!["reply", "clarify"].includes(plan.proposal?.kind))
        throw new Error("Assistant did not produce a memory QA reply");
      const result = app.reception.apply(turn, plan.proposal, plan.queries);
      return {
        hypothesis: result.reply_text,
        evidence: {
          mode,
          harnesses: { assistant: selected.assistant, execution: "not-run" },
          accuracy: null,
          messages,
          exchanges,
          sessions: input.history.length,
          indexingMs,
          queryMs: performance.now() - queryStart,
          learningStates,
          queries: plan.queries,
          workingContext: app.conversationContext.view(turn),
          memoryFacts: app.memory.list().filter((row) => !row.deleted).length,
          usage: app.dispatch({
            op: "usage",
            params: { limit: 100 },
            id: "usage-report",
          }),
          replay: {
            memoryDebounceMs: 0,
            questionUsesHistoryAndMemory: true,
            temporalMaintenance: "not-run",
            historyImportedWithoutExecutingOldCommands: true,
          },
        },
      };
    };
    return await telemetry.run(
      "evaluation.replay",
      { "app.mode": mode },
      replay,
    );
  } finally {
    await learning?.suspend();
    await transport?.close();
    await backgroundTransport?.close();
    await telemetry.close();
    uow.close();
  }
}
