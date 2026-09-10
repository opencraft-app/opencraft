import type { ChatNodeRendererProps } from "@opencraft/chat-render-react";
import { useEffect, useState } from "react";
import "katex/dist/katex.min.css";

import "./katex.scss";

export function KatexMathRenderer({ node, context }: ChatNodeRendererProps) {
  const [html, setHtml] = useState<string | null>(null);
  if (node.kind !== "math") return null;
  useEffect(() => {
    let active = true;
    setHtml(null);
    void import("katex").then(({ default: katex }) => {
      const rendered = katex.renderToString(node.source, {
        displayMode: node.display,
        throwOnError: false,
        strict: false,
        trust: false,
        output: "htmlAndMathml",
      });
      if (active) {
        setHtml(rendered);
        context.requestMeasurement?.({
          geometryChanged: true,
          reason: "math-typeset",
        });
      }
    }).catch(() => {
      if (active) setHtml("");
    });
    return () => { active = false; };
  }, [context.requestMeasurement, node.display, node.source]);

  if (!html) return <span className={node.display ? "chat-math-fallback is-display" : "chat-math-fallback"}>{node.display ? `$$${node.source}$$` : `$${node.source}$`}</span>;
  return <span className={node.display ? "chat-math is-display" : "chat-math"} dangerouslySetInnerHTML={{ __html: html }} />;
}
