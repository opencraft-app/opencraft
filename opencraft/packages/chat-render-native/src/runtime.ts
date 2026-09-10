import type { Context } from "@deepseek-ai/cordis";
import { createChatRenderRuntime, type ChatRenderRuntime } from "@opencraft/chat-render-react";

import { NativeCodeRenderer, NativeDiagramFallback } from "./renderers/code";
import { NativeMathFallback } from "./renderers/math";
import { nativeProseNodeKinds, NativeProseRenderer } from "./renderers/prose";
import { NativeImageRenderer, NativeLinkRenderer } from "./renderers/resource";
import { NativeTableRenderer } from "./renderers/table";

const NativeBuiltinRenderers = Object.assign(function NativeBuiltinRenderers(ctx: Context): void {
  const remove = [
    ctx.chatNodeRenderers.register({ name: "native-prose", priority: 0, kinds: nativeProseNodeKinds, component: NativeProseRenderer }),
    ctx.chatNodeRenderers.register({ name: "native-code", priority: 0, kinds: ["code-fence"], component: NativeCodeRenderer }),
    ctx.chatNodeRenderers.register({ name: "native-diagram-fallback", priority: 100, kinds: ["code-fence"], matches: (node) => node.kind === "code-fence" && node.language === "mermaid", component: NativeDiagramFallback }),
    ctx.chatNodeRenderers.register({ name: "native-math-fallback", priority: 0, kinds: ["math"], component: NativeMathFallback }),
    ctx.chatNodeRenderers.register({ name: "native-table", priority: 0, kinds: ["table"], component: NativeTableRenderer }),
    ctx.chatNodeRenderers.register({ name: "native-link", priority: 0, kinds: ["link"], component: NativeLinkRenderer }),
    ctx.chatNodeRenderers.register({ name: "native-image", priority: 0, kinds: ["image"], component: NativeImageRenderer }),
  ];
  ctx.effect(() => () => remove.reverse().forEach((dispose) => dispose()));
}, { inject: ["chatNodeRenderers"] });

export async function createNativeChatRenderRuntime(context?: Context): Promise<ChatRenderRuntime> {
  const runtime = await createChatRenderRuntime({}, context);
  try {
    await runtime.install(NativeBuiltinRenderers);
    return runtime;
  } catch (error) {
    await runtime.dispose().catch(() => undefined);
    throw error;
  }
}
