import type { Context } from "@deepseek-ai/cordis";
import type { ChatNodeRendererProps } from "@opencraft/chat-render-react";

import { CodeBlockSurface } from "../../renderers/code/code-block";
import type { ChatEnhancementService } from "../../services/chat-enhancement-service";
import { useChatEnhancementLease } from "../../services/use-chat-enhancement-lease";
import { MermaidDiagramRenderer } from "./mermaid-diagram";

function createMermaidRendererBoundary(enhancements: ChatEnhancementService) {
  return function MermaidRendererBoundary(props: ChatNodeRendererProps) {
    const enhancement = useChatEnhancementLease(enhancements);
    if (props.node.kind !== "code-fence") return null;
    if (props.node.completeness !== "complete" || !enhancement.granted) {
      return (
        <CodeBlockSurface
          code={props.node.code}
          language="mermaid"
          open={props.node.completeness !== "complete"}
          rootRef={enhancement.frameRef}
          stickyHeader={props.context.stickyCodeHeaders}
        />
      );
    }
    return <MermaidDiagramRenderer {...props} enhancements={enhancements} />;
  };
}

export const MermaidWebExtension = Object.assign(
  function MermaidWebExtension(ctx: Context): void {
    const Renderer = createMermaidRendererBoundary(ctx.chatEnhancements);
    ctx.effect(() =>
      ctx.chatNodeRenderers.register({
        name: "web-mermaid",
        priority: 200,
        kinds: ["code-fence"],
        matches: (node) =>
          node.kind === "code-fence" &&
          (node.language === "mermaid" ||
            (node.completeness === "open" &&
              node.language !== null &&
              node.language.length >= 2 &&
              "mermaid".startsWith(node.language.toLowerCase()))),
        component: Renderer,
      }),
    );
  },
  { inject: ["chatEnhancements", "chatNodeRenderers"] },
);
