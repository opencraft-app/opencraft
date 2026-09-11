import { Context, type Fiber } from "@deepseek-ai/cordis";
import {
  createNativeChatRenderRuntime,
  NativeChatRenderRuntimeProvider,
} from "@opencraft/chat-render-native";
import type { ChatRenderRuntime } from "@opencraft/chat-render-react";
import {
  TimelineBlockRendererProvider,
  TimelineBlockRendererRegistryService,
} from "@opencraft/timeline-render-react";
import { use, type ReactNode } from "react";

import { NativeBuiltinTimelineRendererPlugin } from "../components/workbench-conversation";

export interface ExpoPresentationRuntime {
  readonly cordis: Context;
  readonly chat: ChatRenderRuntime;
  readonly timelineRenderers: TimelineBlockRendererRegistryService;
  dispose(): Promise<void>;
}

/**
 * Root-owned Native presentation graph. Chat document compilation and timeline
 * block dispatch share one Cordis scope, matching the Web ownership boundary.
 */
export async function createExpoPresentationRuntime(): Promise<ExpoPresentationRuntime> {
  const cordis = new Context();
  const fibers: Fiber[] = [];
  let chat: ChatRenderRuntime | null = null;
  const install = async (plugin: Parameters<Context["plugin"]>[0]) => {
    const fiber = cordis.plugin(plugin);
    fibers.push(fiber);
    await fiber;
  };
  try {
    chat = await createNativeChatRenderRuntime(cordis);
    await install(TimelineBlockRendererRegistryService);
    await install(NativeBuiltinTimelineRendererPlugin);
  } catch (error) {
    for (const fiber of fibers.splice(0).reverse()) await fiber.dispose().catch(() => undefined);
    await chat?.dispose().catch(() => undefined);
    throw error;
  }
  let disposed = false;
  return {
    cordis,
    chat,
    timelineRenderers: cordis.timelineBlockRenderers,
    async dispose() {
      if (disposed) return;
      disposed = true;
      const failures: unknown[] = [];
      for (const fiber of fibers.splice(0).reverse()) {
        try {
          await fiber.dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await chat.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) throw new AggregateError(failures, "Failed to dispose Expo presentation runtime");
    },
  };
}

export function ExpoPresentationRuntimeProvider({
  children,
  runtime,
}: {
  readonly children: ReactNode;
  readonly runtime: Promise<ExpoPresentationRuntime>;
}) {
  const resolved = use(runtime);
  return (
    <NativeChatRenderRuntimeProvider runtime={resolved.chat}>
      <TimelineBlockRendererProvider registry={resolved.timelineRenderers}>
        {children}
      </TimelineBlockRendererProvider>
    </NativeChatRenderRuntimeProvider>
  );
}
