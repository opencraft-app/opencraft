import type { ChatNodeRendererProps } from "@opencraft/chat-render-react";
import { useEffect, useEffectEvent, useLayoutEffect, useState } from "react";
import type { ChatEnhancementService } from "../../services/chat-enhancement-service";
import "katex/dist/katex.min.css";

import "./katex.scss";

export function KatexMathRenderer({ node, context, enhancements }: ChatNodeRendererProps & { enhancements: ChatEnhancementService }) {
  const [result, setResult] = useState<{ key: string; html: string } | null>(null);
  const reportMeasurement = useEffectEvent(() => context.requestMeasurement?.({ geometryChanged: true, reason: "math-typeset" }));
  if (node.kind !== "math") return null;
  const key = JSON.stringify(["katex", node.display, node.source]);
  const cached = enhancements.peek<string>(key);
  useLayoutEffect(() => {
    if (cached !== undefined) setResult(previous => previous?.key === key && previous.html === cached ? previous : { key, html: cached });
  }, [cached, key]);
  useEffect(() => {
    if (cached !== undefined) return;
    let active = true;
    const controller = new AbortController();
    void enhancements.run({ cacheKey: key, lane: "highlight", signal: controller.signal, run: async signal => {
      const { default: katex } = await import("katex");
      signal.throwIfAborted();
      return katex.renderToString(node.source, {
        displayMode: node.display,
        throwOnError: false,
        strict: false,
        trust: false,
        output: "htmlAndMathml",
      });
    }}).then(html => {
      if (!active) return;
      setResult({ key, html });
      reportMeasurement();
    }).catch(() => {
      if (active) setResult({ key, html: "" });
    });
    return () => { active = false; controller.abort(); };
  }, [cached, enhancements, key, node.display, node.source]);

  const html = cached ?? (result?.key === key ? result.html : null);
  if (!html) return <span className={node.display ? "chat-math-fallback is-display" : "chat-math-fallback"}>{node.display ? `$$${node.source}$$` : `$${node.source}$`}</span>;
  return <span className={node.display ? "chat-math is-display" : "chat-math"} dangerouslySetInnerHTML={{ __html: html }} />;
}
