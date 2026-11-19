import { parseThreadCommand } from "@opencraft/appserver-protocol/thread-command";
import { executePlatformRead } from "../application/platform-read.mjs";
/** Composition only. Project existing owners into the exact capabilities used by Pi. */
export function createExecutionPorts(app, assertOwner = () => {}, threadCommand, platformReads, environment) {
  return Object.freeze({
    executions: Object.freeze({
      execution: (work) => app.executions.execution(work),
      predecessor: (work) => app.executions.predecessor(work),
      nativeCalls: (work) => app.executions.nativeCalls(work),
      prepareNativeCall: (...args) => app.executions.prepareNativeCall(...args),
      nativeOutcome: (...args) => app.executions.nativeOutcome(...args),
      snapshot: (work) => app.executions.snapshot(work),
      modelStep: (work, taskId, limit) => app.executions.modelStep(work, taskId, limit),
      bound: (...args) => app.executions.bound(...args),
      assertCurrent: (work) => {
        assertOwner();
        return app.works.assertCurrent(work);
      },
      observeRun: (work, observation) => app.executions.observeRun(work, observation),
    }),
    toolsFor: (work, snapshot) =>
      Object.freeze({
        ...(environment
          ? {
              environmentRun: async (args, callId, signal) => {
                const resource = snapshot.delegation.resources.find((r) => r.id === "execution.environment");
                const check = () => {
                  signal?.throwIfAborted();
                  assertOwner();
                  app.works.assertCurrent(work);
                  if (!resource || resource.binding !== environment.resource.binding)
                    throw Error("Execution environment is outside the original delegation");
                  app.executions.assertAction(work, "environment_run", resource);
                };
                check();
                const result = await environment.run({ ...args, callId, workId: work.id }, signal);
                check();
                if (!result || !["completed", "rejected"].includes(result.state))
                  throw Object.assign(Error("Environment effect is unknown; explicit reconciliation required"), {
                    code: "ENVIRONMENT_OUTCOME_UNKNOWN",
                  });
                return result;
              },
            }
          : {}),
        ...(platformReads
          ? {
              platformRead: async (request, signal) => {
                const resource = snapshot.delegation.resources.find((r) => r.id === "platform.reads");
                const check = () => {
                  signal?.throwIfAborted();
                  assertOwner();
                  app.works.assertCurrent(work);
                  if (!resource) throw Error("Platform read resource is outside the original delegation");
                  app.executions.assertAction(work, "platform_read", resource);
                };
                check();
                const result = await executePlatformRead(platformReads, request, signal);
                check();
                app.completion.platformRead(work, result);
                return result;
              },
            }
          : {}),
        ...(threadCommand
          ? {
              threadCommand: async (argv, signal) => {
                assertOwner();
                app.works.assertCurrent(work);
                app.executions.assertThreadAction(work);
                const link = app.executions.threads.prepare(work, parseThreadCommand(argv), argv);
                const result = await threadCommand(link ? app.executions.threads.argv(link) : argv, work.id, signal);
                assertOwner();
                app.works.assertCurrent(work);
                app.executions.assertThreadAction(work);
                app.executions.threads.accepted(work, link, result);
                return result;
              },
            }
          : {}),
        assertAction: (tool, resource, epoch) => {
          assertOwner();
          return app.executions.assertAction(work, tool, resource, epoch);
        },
        readContext: () => ({
          work: app.works.require(work.id).record,
          memoryEpoch: app.memory.epoch(),
          memories: app.memory.recall({ limit: 20 }, snapshot.delegation.resources).items,
        }),
        searchHistory: (options) => app.history.search(options, work.id),
        listMemoryFiles: (options) => app.memory.listFiles(options, snapshot.delegation.resources),
        readMemoryFile: (options) => app.memory.readFile(options, snapshot.delegation.resources),
        recallMemory: (options) => app.memory.recall(options, snapshot.delegation.resources),
        publishedNote: (artifact, body) => app.completion.publishedNote(work, artifact, body),
        materialRead: (material) => app.completion.materialRead(work, material),
        requestInteraction: (callId, question, options) => app.interactions.request(work, callId, question, options),
        listSkills: () => app.skills.available(snapshot),
        loadSkill: (id) => app.skills.load(work, snapshot, id),
        event: (kind, data) => app.event(kind, work.id, data),
      }),
    recordUsage: (workId, state, mode, options) => app.usage.recordNative(workId, state, mode, options),
    report: (workId, error) => app.event("pi.report", workId, { error: String(error) }),
  });
}
