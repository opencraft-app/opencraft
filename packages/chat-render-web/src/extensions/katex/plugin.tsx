import type { Context } from "@deepseek-ai/cordis";
import type { ChatNodeRendererProps } from "@opencraft/chat-render-react";
import { lazy, Suspense } from "react";

import { loadKatexMathRenderer } from "./loader";

const LazyKatexMath = lazy(() => loadKatexMathRenderer().then((module) => ({ default: module.KatexMathRenderer })));

function RawMath({ node }: ChatNodeRendererProps) {
  if (node.kind !== "math") return null;
  return <span className={node.display ? "chat-math-fallback is-display" : "chat-math-fallback"}>{node.display ? `$$${node.source}$$` : `$${node.source}$`}</span>;
}

function KatexRendererBoundary(props: ChatNodeRendererProps) {
  return <Suspense fallback={<RawMath {...props} />}><LazyKatexMath {...props} /></Suspense>;
}

export const KatexWebExtension = Object.assign(function KatexWebExtension(ctx: Context): void {
  ctx.effect(() => ctx.chatNodeRenderers.register({
    name: "web-katex",
    priority: 100,
    kinds: ["math"],
    component: KatexRendererBoundary,
  }));
}, { inject: ["chatNodeRenderers"] });
