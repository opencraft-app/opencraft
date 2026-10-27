import type { ChatRenderTheme } from "@opencraft/chat-render-react";
import type { MermaidConfig } from "mermaid";

type MermaidModule = typeof import("mermaid");

let mermaidModulePromise: Promise<MermaidModule> | null = null;

function loadMermaid(): Promise<MermaidModule> {
  mermaidModulePromise ??= Promise.all([
    import("mermaid"),
    import("@mermaid-js/layout-elk"),
  ]).then(([module, elk]) => {
    module.default.registerLayoutLoaders(elk.default);
    return module;
  });
  return mermaidModulePromise;
}

export function cssToken(
  element: HTMLElement,
  token: string,
  fallback: string,
): string {
  const value =
    element.ownerDocument.defaultView
      ?.getComputedStyle(element)
      .getPropertyValue(token)
      .trim() ?? "";
  return value.length === 0 ? fallback : value;
}

function mermaidConfiguration(
  element: HTMLElement,
  theme: ChatRenderTheme,
): MermaidConfig {
  const dark = theme === "dark";
  const background = cssToken(
    element,
    "--color-background-surface",
    dark ? "rgb(10, 10, 10)" : "rgb(255, 255, 255)",
  );
  const primary = cssToken(
    element,
    "--color-background-secondary-soft-alpha",
    dark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.04)",
  );
  const secondary = cssToken(
    element,
    "--color-background-elevated-secondary",
    dark ? "rgba(255, 255, 255, 0.04)" : "rgba(0, 0, 0, 0.04)",
  );
  const tertiary = cssToken(
    element,
    "--color-background-secondary-soft-alpha",
    dark ? "rgba(255, 255, 255, 0.06)" : "rgba(0, 0, 0, 0.04)",
  );
  const text = cssToken(
    element,
    "--color-text",
    dark ? "rgb(255, 255, 255)" : "rgb(17, 24, 28)",
  );
  const secondaryText = cssToken(
    element,
    "--color-text-secondary",
    dark ? "rgba(255, 255, 255, 0.72)" : "rgba(17, 24, 28, 0.7)",
  );
  const border = cssToken(
    element,
    "--color-border-default",
    dark ? "rgba(255, 255, 255, 0.16)" : "rgba(17, 24, 28, 0.12)",
  );
  const fontFamily = cssToken(
    element,
    "--font-family-ui",
    '"Inter Variable", "PingFang SC", "Noto Sans SC", system-ui, sans-serif',
  );

  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    deterministicIds: false,
    deterministicIDSeed: "opencraft-mermaid",
    htmlLabels: false,
    darkMode: dark,
    look: "classic",
    layout: "elk",
    theme: "base",
    fontFamily,
    flowchart: { curve: "rounded", htmlLabels: false },
    themeVariables: {
      background,
      primaryColor: primary,
      primaryBorderColor: border,
      primaryTextColor: text,
      secondaryColor: secondary,
      secondaryBorderColor: border,
      secondaryTextColor: secondaryText,
      tertiaryColor: tertiary,
      tertiaryBorderColor: border,
      tertiaryTextColor: secondaryText,
      lineColor: secondaryText,
      textColor: text,
      mainBkg: primary,
      nodeBorder: border,
      clusterBkg: secondary,
      clusterBorder: border,
      edgeLabelBackground: background,
      actorBkg: primary,
      actorBorder: border,
      actorTextColor: text,
      actorLineColor: secondaryText,
      signalColor: secondaryText,
      signalTextColor: text,
      labelBoxBkgColor: primary,
      labelBoxBorderColor: border,
      labelTextColor: text,
      loopTextColor: text,
      noteBkgColor: secondary,
      noteBorderColor: border,
      noteTextColor: text,
      activationBkgColor: secondary,
      activationBorderColor: border,
      sequenceNumberColor: text,
    },
  };
}

let rendering: Promise<unknown> = Promise.resolve();

/** Mermaid owns process-global configuration; all document and chat calls share this gate. */
export function renderMermaidSvg(id: string, source: string, element: HTMLElement, theme: ChatRenderTheme, signal: AbortSignal): Promise<string> {
  const task = rendering.catch(() => undefined).then(async () => {
    signal.throwIfAborted();
    const { default: mermaid } = await loadMermaid();
    signal.throwIfAborted();
    mermaid.initialize(mermaidConfiguration(element, theme));
    try {
      const rendered = await mermaid.render(id, source);
      signal.throwIfAborted();
      return rendered.svg;
    } finally {
      element.ownerDocument.getElementById(`d${id}`)?.remove();
    }
  });
  rendering = task;
  return task;
}
