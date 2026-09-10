import type { ChatNodeRendererProps } from "@opencraft/chat-render-react";
import { useEffect, useRef, useState } from "react";

import {
  CodeBlockSurface,
  type CodeBlockSurfaceProps,
} from "../../renderers/code/code-block";
import type { ChatEnhancementService } from "../../services/chat-enhancement-service";
import { useChatEnhancementLease } from "../../services/use-chat-enhancement-lease";
import { appendUnhighlightedCodeTail } from "./highlighted-code-html";
import { loadShikiEngine } from "./loader";

interface HighlightedPrefix {
  readonly code: string;
  readonly html: string;
}

export interface ShikiCodeRendererProps extends ChatNodeRendererProps {
  readonly enhancements: ChatEnhancementService;
  readonly surfaceProps?: Pick<
    CodeBlockSurfaceProps,
    "policy" | "showActions" | "stickyHeader" | "title"
  >;
}

/**
 * Lightweight React adapter. It permanently owns one CodeBlockSurface and
 * only commits immutable HTML returned by the dynamically loaded engine.
 * The engine never receives a DOM node and therefore cannot own geometry.
 */
export function ShikiCodeRenderer({
  enhancements,
  node,
  context,
  surfaceProps,
}: ShikiCodeRendererProps) {
  const [highlighted, setHighlighted] = useState<HighlightedPrefix | null>(null);
  const lastHighlightStartedAt = useRef<number | null>(null);
  const generation = useRef(0);
  const enhancement = useChatEnhancementLease(enhancements);
  const isCodeFence = node.kind === "code-fence";
  const code = isCodeFence ? node.code : "";
  const language = isCodeFence ? node.language : null;

  useEffect(() => {
    if (!enhancement.granted || !isCodeFence) return;
    let active = true;
    const controller = new AbortController();
    const currentGeneration = ++generation.current;
    setHighlighted((previous) =>
      previous !== null && code.startsWith(previous.code)
        ? previous
        : null,
    );

    const now = performance.now();
    const elapsed = lastHighlightStartedAt.current === null
      ? 120
      : now - lastHighlightStartedAt.current;
    const timeout = window.setTimeout(() => {
      lastHighlightStartedAt.current = performance.now();
      void enhancements.run({
          cacheKey: `shiki:${context.theme}:${language ?? "text"}:${code}`,
          lane: "highlight",
          signal: controller.signal,
          run: async (signal) => {
            signal.throwIfAborted();
            const engine = await loadShikiEngine();
            signal.throwIfAborted();
            return engine.highlightCode(code, language, context.theme, signal);
          },
        })
        .then((html) => {
          if (!active || currentGeneration !== generation.current) return;
          setHighlighted({ code, html });
          context.requestMeasurement?.({
            geometryChanged: false,
            reason: "code-highlight",
          });
        })
        .catch(() => {
          if (active && currentGeneration === generation.current) {
            setHighlighted(null);
          }
        });
    }, Math.max(0, 120 - elapsed));

    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [code, context.requestMeasurement, context.theme, enhancement.granted, enhancements, isCodeFence, language]);

  if (!isCodeFence) return null;

  const highlightedHtml = highlighted === null
    ? null
    : appendUnhighlightedCodeTail(highlighted.code, highlighted.html, code);

  return (
    <CodeBlockSurface
      code={code}
      highlightedHtml={highlightedHtml}
      language={language}
      pending={enhancement.granted && highlighted?.code !== code}
      policy={surfaceProps?.policy}
      rootRef={enhancement.frameRef}
      showActions={surfaceProps?.showActions}
      stickyHeader={surfaceProps?.stickyHeader ?? context.stickyCodeHeaders}
      title={surfaceProps?.title}
    />
  );
}
