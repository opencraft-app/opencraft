import type { ChatNodeRendererProps } from "@opencraft/chat-render-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

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
  readonly theme: string;
  readonly language: string | null;
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
  const complete = isCodeFence && node.completeness === "complete";
  const cacheKey = `shiki:${context.theme}:${language ?? "text"}:${code}`;
  const cached = complete ? enhancements.peek<string>(cacheKey) : undefined;
  const reportMeasurement = useEffectEvent(() => context.requestMeasurement?.({
    geometryChanged: false, reason: "code-highlight",
  }));
  // Cache eviction affects future consumers, not output this mounted surface
  // has already presented. Capture the borrowed result before browser paint.
  useLayoutEffect(() => {
    if (cached !== undefined) setHighlighted(previous => previous?.html === cached
      && previous.code === code && previous.theme === context.theme && previous.language === language
      ? previous : { code, html: cached, theme: context.theme, language });
  }, [cached, code, context.theme, language]);

  useEffect(() => {
    if (cached !== undefined || !enhancement.granted || !complete) return;
    let active = true;
    const controller = new AbortController();
    const currentGeneration = ++generation.current;
    setHighlighted((previous) =>
      previous !== null && previous.theme === context.theme && previous.language === language && code.startsWith(previous.code)
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
          cacheKey,
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
          setHighlighted({ code, html, theme: context.theme, language });
          reportMeasurement();
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
  }, [cached, cacheKey, code, complete, context.theme, enhancement.granted, enhancements, language]);

  if (!isCodeFence) return null;

  const highlightedHtml = cached ?? (!complete || highlighted === null || highlighted.theme !== context.theme
    || highlighted.language !== language || !code.startsWith(highlighted.code)
    ? null
    : appendUnhighlightedCodeTail(highlighted.code, highlighted.html, code));

  return (
    <CodeBlockSurface
      code={code}
      readingKey={JSON.stringify([context.documentId, node.stableKey, "code"])}
      highlightedHtml={highlightedHtml}
      language={language}
      open={!complete}
      pending={complete && cached === undefined && enhancement.granted && highlighted?.code !== code}
      policy={surfaceProps?.policy}
      rootRef={enhancement.frameRef}
      showActions={surfaceProps?.showActions}
      stickyHeader={surfaceProps?.stickyHeader ?? context.stickyCodeHeaders}
      title={surfaceProps?.title}
    />
  );
}
