import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { Streamdown, type Components } from "streamdown";
import { useMemo } from "react";

import { cn } from "../lib/utils";
import {
  createMarkdownComponents,
  type ImageHookPayload,
  type LinkHookPayload,
} from "./markdownComponents";

export interface MarkdownContentProps {
  isAnimating: boolean;
  onImage?: (payload: ImageHookPayload) => void;
  onLink?: (payload: LinkHookPayload) => void;
  text: string;
}

const streamdownPlugins = { cjk, code, math, mermaid };

export function MarkdownContent({
  isAnimating,
  onImage = logMarkdownImage,
  onLink = logMarkdownLink,
  text,
}: MarkdownContentProps) {
  const components = useMemo<Components>(
    () => createMarkdownComponents(onImage, onLink),
    [onImage, onLink],
  );

  return (
    <Streamdown
      animated
      className={cn(
        "mt-1 min-w-0 break-words text-[17px] leading-8 [overflow-wrap:anywhere]",
        "[&_a]:text-accent [&_a]:underline [&_a]:underline-offset-4",
        "[&_img]:max-w-full [&_img]:rounded-md [&_img]:border [&_img]:border-border",
      )}
      components={components}
      isAnimating={isAnimating}
      mode={isAnimating ? "streaming" : "static"}
      plugins={streamdownPlugins}
    >
      {text}
    </Streamdown>
  );
}

export default MarkdownContent;

function logMarkdownLink(payload: LinkHookPayload) {
  console.info("[markdown-link]", payload);
}

function logMarkdownImage(payload: ImageHookPayload) {
  console.info("[markdown-image]", payload);
}
