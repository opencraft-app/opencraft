import type { Context } from "@deepseek-ai/cordis";
import { createChatRenderRuntime, registerStandardChatResourcePolicy, type ChatRenderRuntime } from "@opencraft/chat-render-react";

import { NativeCodeRenderer } from "./renderers/code";
import { NativeMermaidRenderer } from "./renderers/mermaid";
import { NativeMathRenderer } from "./renderers/math";
import { nativeProseNodeKinds, NativeProseRenderer } from "./renderers/prose";
import { createNativeFileCitationRenderer, createNativeImageRenderer, createNativeLinkRenderer, createNativeReferenceRenderer } from "./renderers/resource";
import { NativeTableRenderer } from "./renderers/table";

const NativeBuiltinRenderers = Object.assign(function NativeBuiltinRenderers(ctx: Context): void {
  const remove = [
    ctx.chatNodeRenderers.register({ name: "native-prose", priority: 0, kinds: nativeProseNodeKinds, component: NativeProseRenderer }),
    ctx.chatNodeRenderers.register({ name: "native-code", priority: 0, kinds: ["code-fence"], component: NativeCodeRenderer }),
    ctx.chatNodeRenderers.register({ name: "native-diagram", priority: 100, kinds: ["code-fence"], matches: (node) => node.kind === "code-fence" && node.language?.toLowerCase() === "mermaid", component: NativeMermaidRenderer }),
    ctx.chatNodeRenderers.register({ name: "native-math", priority: 0, kinds: ["math"], component: NativeMathRenderer }),
    ctx.chatNodeRenderers.register({ name: "native-table", priority: 0, kinds: ["table"], component: NativeTableRenderer }),
    ctx.chatNodeRenderers.register({ name: "native-link", priority: 0, kinds: ["link"], component: createNativeLinkRenderer(ctx.chatResourcePolicies) }),
    ctx.chatNodeRenderers.register({ name: "native-reference", priority: 0, kinds: ["reference"], component: createNativeReferenceRenderer(ctx.chatResourcePolicies) }),
    ctx.chatNodeRenderers.register({ name: "native-image", priority: 0, kinds: ["image"], component: createNativeImageRenderer(ctx.chatResourcePolicies) }),
    ctx.chatDirectives.register({ name: "codex-file-citation", priority: 0, component: createNativeFileCitationRenderer(ctx.chatResourcePolicies) }),
    registerStandardChatResourcePolicy(ctx.chatResourcePolicies, "native-standard-url"),
  ];
  ctx.effect(() => () => remove.reverse().forEach((dispose) => dispose()));
}, { inject: ["chatDirectives", "chatNodeRenderers", "chatResourcePolicies"] });

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
