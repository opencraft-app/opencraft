import type {
  DebugExecCommandContext,
  DebugExecCommandLifecycle,
} from "@/pages/marketing/agent-tat-adapter";

type LifecycleMetadataList = unknown[];

async function applyTransform(
  lifecycle: DebugExecCommandLifecycle,
  context: DebugExecCommandContext,
): Promise<string | undefined> {
  return lifecycle.transformCommand?.(context);
}

export function composeDebugExecCommandLifecycles(
  ...lifecycles: Array<DebugExecCommandLifecycle | null | undefined>
): DebugExecCommandLifecycle {
  const activeLifecycles = lifecycles.filter((lifecycle): lifecycle is DebugExecCommandLifecycle => Boolean(lifecycle));

  return {
    transformCommand: async (context) => {
      let command = context.command;
      let transformed = false;
      for (const lifecycle of activeLifecycles) {
        const nextCommand = await applyTransform(lifecycle, { ...context, command });
        if (typeof nextCommand === "string" && nextCommand !== command) {
          command = nextCommand;
          transformed = true;
        }
      }
      return transformed ? command : undefined;
    },
    beforeExecute: async (context) => {
      const metadata: LifecycleMetadataList = [];
      for (const lifecycle of activeLifecycles) {
        metadata.push(await lifecycle.beforeExecute?.(context));
      }
      return metadata;
    },
    afterExecute: async (context) => {
      const metadata = Array.isArray(context.metadata)
        ? context.metadata
        : [];
      for (let index = 0; index < activeLifecycles.length; index += 1) {
        const lifecycle = activeLifecycles[index]!;
        await lifecycle.afterExecute?.({
          ...context,
          metadata: metadata[index],
        });
      }
    },
  };
}
