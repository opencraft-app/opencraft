import { Context, type Fiber } from "@deepseek-ai/cordis";

import { registerBuiltinThreadHistoryStrategies, ThreadHistoryStrategyRegistryService } from "./history-strategies";
import { ResumeNotificationBufferService } from "./notification-buffer";
import { registerBuiltinThreadProjectors, ThreadNotificationProjectorRegistryService, ThreadResumeProjectorRegistryService } from "./projectors";
import { ThreadResumeCoordinatorService, type ThreadResumeCoordinatorConfig } from "./resume-coordinator";
import { ThreadStreamOwnershipService } from "./stream-ownership";
import { ThreadViewStoreService } from "./view-store";

const BuiltinSessionPlugins = Object.assign(function BuiltinSessionPlugins(ctx: Context): void {
  const removeHistory = registerBuiltinThreadHistoryStrategies(ctx);
  const removeProjectors = registerBuiltinThreadProjectors(ctx);
  ctx.effect(() => () => {
    removeProjectors();
    removeHistory();
  });
}, {
  inject: ["threadHistoryStrategies", "threadResumeProjectors", "threadNotificationProjectors"],
});

export interface CordisThreadSessionRuntime {
  readonly context: Context;
  readonly views: ThreadViewStoreService;
  readonly resume: ThreadResumeCoordinatorService;
  readonly historyStrategies: ThreadHistoryStrategyRegistryService;
  readonly resumeProjectors: ThreadResumeProjectorRegistryService;
  readonly notificationProjectors: ThreadNotificationProjectorRegistryService;
  readonly ownership: ThreadStreamOwnershipService;
  dispose(): Promise<void>;
}

export async function createCordisThreadSessionRuntime(
  config: ThreadResumeCoordinatorConfig,
): Promise<CordisThreadSessionRuntime> {
  const context = new Context();
  const fibers: Fiber[] = [];
  const install = async <TConfig>(plugin: new (ctx: Context, config: TConfig) => unknown, pluginConfig: TConfig) => {
    const fiber = context.plugin(plugin, pluginConfig);
    fibers.push(fiber);
    await fiber;
  };
  const installEmpty = async (plugin: new (ctx: Context) => unknown) => {
    const fiber = context.plugin(plugin);
    fibers.push(fiber);
    await fiber;
  };

  await install(ThreadViewStoreService, {
    hostId: config.client.hostId,
    connectionGeneration: () => config.client.connectionGeneration,
    frameScheduler: config.frameScheduler,
  });
  await installEmpty(ThreadHistoryStrategyRegistryService);
  await installEmpty(ThreadResumeProjectorRegistryService);
  await installEmpty(ThreadNotificationProjectorRegistryService);
  await installEmpty(ThreadStreamOwnershipService);
  await install(ResumeNotificationBufferService, { client: config.client });
  const builtinFiber = context.plugin(BuiltinSessionPlugins);
  fibers.push(builtinFiber);
  await builtinFiber;
  await install(ThreadResumeCoordinatorService, config);

  return {
    context,
    views: context.threadViews,
    resume: context.threadResume,
    historyStrategies: context.threadHistoryStrategies,
    resumeProjectors: context.threadResumeProjectors,
    notificationProjectors: context.threadNotificationProjectors,
    ownership: context.threadStreamOwnership,
    async dispose() {
      const failures: unknown[] = [];
      for (const fiber of fibers.reverse()) {
        try {
          await fiber.dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, "Failed to dispose Thread Session runtime");
    },
  };
}
