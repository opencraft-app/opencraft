import type { Context } from "@deepseek-ai/cordis";
import {
  createChatRenderRuntime,
  registerStandardChatResourcePolicy,
  type ChatRenderRuntime,
} from "@opencraft/chat-render-react";

import { KatexWebExtension } from "./extensions/katex/plugin";
import { MermaidWebExtension } from "./extensions/mermaid/plugin";
import { ShikiWebExtension } from "./extensions/shiki/plugin";
import { BaseCodeBlockRenderer } from "./renderers/code/code-block";
import { createImageRenderer } from "./renderers/media/image-renderer";
import { proseNodeKinds, ProseRenderer } from "./renderers/prose/prose-renderer";
import { createFileCitationRenderer, createInlineMarkdownFileRenderer, createLinkRenderer, createMediaFileRenderer, createReferenceRenderer, mediaFilePath } from "./renderers/resource-link/resource-link";
import { TableRenderer } from "./renderers/table/table-renderer";
import { ChatEnhancementService } from "./services/chat-enhancement-service";

export type { ChatRenderRuntime } from "@opencraft/chat-render-react";

const WebBuiltinRenderers = Object.assign(function WebBuiltinRenderers(ctx: Context): void {
  const remove = [
    ctx.chatNodeRenderers.register({
      name: "web-prose",
      priority: 0,
      kinds: proseNodeKinds,
      component: ProseRenderer,
    }),
    ctx.chatNodeRenderers.register({
      name: "web-inline-markdown-file",
      priority: 1,
      kinds: ["inline-code"],
      component: createInlineMarkdownFileRenderer(ctx.chatResourcePolicies),
    }),
    ctx.chatNodeRenderers.register({
      name: "web-media-file",
      priority: 1,
      kinds: ["text"],
      matches: (node, context) => node.kind === "text" && !context.streaming
        && context.openResource !== undefined && mediaFilePath(node.text) !== null,
      component: createMediaFileRenderer(ctx.chatResourcePolicies),
    }),
    ctx.chatNodeRenderers.register({
      name: "web-code-fallback",
      priority: 0,
      kinds: ["code-fence"],
      component: BaseCodeBlockRenderer,
    }),
    ctx.chatNodeRenderers.register({
      name: "web-table",
      priority: 0,
      kinds: ["table"],
      component: TableRenderer,
    }),
    ctx.chatNodeRenderers.register({
      name: "web-link",
      priority: 0,
      kinds: ["link"],
      component: createLinkRenderer(ctx.chatResourcePolicies),
    }),
    ctx.chatNodeRenderers.register({
      name: "web-inline-reference",
      priority: 0,
      kinds: ["reference"],
      component: createReferenceRenderer(ctx.chatResourcePolicies),
    }),
    ctx.chatNodeRenderers.register({
      name: "web-image",
      priority: 0,
      kinds: ["image"],
      component: createImageRenderer(ctx.chatResourcePolicies),
    }),
    ctx.chatDirectives.register({
      name: "codex-file-citation",
      priority: 0,
      component: createFileCitationRenderer(ctx.chatResourcePolicies),
    }),
    registerStandardChatResourcePolicy(ctx.chatResourcePolicies, "web-standard-url"),
  ];
  ctx.effect(() => () => remove.reverse().forEach((dispose) => dispose()));
}, {
  inject: ["chatDirectives", "chatNodeRenderers", "chatResourcePolicies"],
});

export async function createWebChatRenderRuntime(
  context?: Context,
): Promise<ChatRenderRuntime> {
  const runtime = await createChatRenderRuntime({}, context);
  try {
    await runtime.install(ChatEnhancementService);
    await runtime.install(WebBuiltinRenderers);
    await runtime.install(ShikiWebExtension);
    await runtime.install(KatexWebExtension);
    await runtime.install(MermaidWebExtension);
    return runtime;
  } catch (error) {
    await runtime.dispose().catch(() => undefined);
    throw error;
  }
}
