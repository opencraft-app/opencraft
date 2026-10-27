import type { Context } from "@deepseek-ai/cordis";
import type { ChatNodeRendererProps } from "@opencraft/chat-render-react";

import { ShikiCodeRenderer } from "./shiki-code";

/**
 * Registration is synchronous and lightweight. Only the engine and grammar
 * leaves are dynamically imported after the permanent Frame receives a
 * near-viewport enhancement lease.
 */
export const ShikiWebExtension = Object.assign(
  function ShikiWebExtension(ctx: Context): void {
    const Renderer = (props: ChatNodeRendererProps) => (
      <ShikiCodeRenderer {...props} enhancements={ctx.chatEnhancements} />
    );
    ctx.effect(() =>
      ctx.chatNodeRenderers.register({
        name: "web-shiki",
        priority: 100,
        kinds: ["code-fence"],
        matches: (node) =>
          node.kind === "code-fence" &&
          node.language !== "mermaid",
        component: Renderer,
      }),
    );
  },
  { inject: ["chatEnhancements", "chatNodeRenderers"] },
);
