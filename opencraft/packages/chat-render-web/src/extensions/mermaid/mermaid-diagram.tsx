import type {
  ChatNodeRendererProps,
  ChatRenderContext,
  ChatRenderTheme,
} from "@opencraft/chat-render-react";
import type { MermaidConfig } from "mermaid";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { writeTextToClipboard } from "../../clipboard";
import { CodeBlockSurface } from "../../renderers/code/code-block";
import type { ChatEnhancementService } from "../../services/chat-enhancement-service";
import {
  createMermaidRenderKey,
  createMermaidRenderState,
  isMermaidRenderRevealed,
  mermaidShellHeight,
  MERMAID_REVEAL_DURATION_MS,
  prepareMermaidSource,
  reduceMermaidRenderState,
} from "./mermaid-render-model";
import "./mermaid.scss";

type MermaidModule = typeof import("mermaid");

let mermaidModulePromise: Promise<MermaidModule> | null = null;

function loadMermaid(): Promise<MermaidModule> {
  mermaidModulePromise ??= import("mermaid");
  return mermaidModulePromise;
}

function cssToken(
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
    "--color-background-elevated-primary",
    dark ? "rgba(255, 255, 255, 0.08)" : "rgb(255, 255, 255)",
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
    look: "neo",
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

async function renderMermaid(
  enhancements: ChatEnhancementService,
  id: string,
  source: string,
  element: HTMLElement,
  theme: ChatRenderTheme,
  signal: AbortSignal,
): Promise<string> {
  return enhancements.run({
    lane: "diagram",
    signal,
    run: async (runSignal) => {
      runSignal.throwIfAborted();
      const { default: mermaid } = await loadMermaid();
      runSignal.throwIfAborted();
      mermaid.initialize(mermaidConfiguration(element, theme));
      const rendered = await mermaid.render(id, source);
      runSignal.throwIfAborted();
      return rendered.svg;
    },
  });
}

function numericStyle(element: HTMLElement, property: string): number {
  const styles = element.ownerDocument.defaultView?.getComputedStyle(element);
  return Number.parseFloat(styles?.getPropertyValue(property) ?? "") || 0;
}

function horizontalInsets(element: HTMLElement): number {
  return (
    numericStyle(element, "padding-left") +
    numericStyle(element, "padding-right") +
    numericStyle(element, "border-left-width") +
    numericStyle(element, "border-right-width")
  );
}

function measureDiagram(
  block: HTMLElement,
  surface: HTMLElement,
  svg: SVGSVGElement,
): number {
  const naturalWidth = svg.viewBox.baseVal.width;
  const insets = horizontalInsets(surface);
  if (naturalWidth > 0) {
    svg.style.width = `${naturalWidth}px`;
    svg.style.maxWidth = "100%";
    block.style.setProperty(
      "--mermaid-natural-block-width",
      `${Math.ceil(naturalWidth + insets)}px`,
    );
    const availableWidth = Math.max(0, surface.clientWidth - insets);
    block.toggleAttribute(
      "data-mermaid-overflow",
      naturalWidth > availableWidth + 1,
    );
  } else {
    svg.style.width = "auto";
    svg.style.maxWidth = "100%";
    block.style.removeProperty("--mermaid-natural-block-width");
    block.removeAttribute("data-mermaid-overflow");
  }
  return surface.offsetHeight || Math.ceil(svg.getBoundingClientRect().height);
}

interface MermaidSvgRendererProps {
  readonly blockRef: React.RefObject<HTMLDivElement | null>;
  readonly code: string;
  readonly renderKey: string;
  readonly surfaceRef: React.RefObject<HTMLDivElement | null>;
  readonly theme: ChatRenderTheme;
  readonly enhancements: ChatEnhancementService;
  readonly onError: (key: string, error: string) => void;
  readonly onRendered: (key: string, height: number) => void;
}

function MermaidSvgRenderer({
  blockRef,
  code,
  enhancements,
  renderKey,
  surfaceRef,
  theme,
  onError,
  onRendered,
}: MermaidSvgRendererProps) {
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/gu, "");
  const generationRef = useRef(0);

  useEffect(() => {
    const block = blockRef.current;
    const surface = surfaceRef.current;
    if (block === null || surface === null) return;
    const source = prepareMermaidSource(code);
    if (source.length === 0) {
      onError(renderKey, "The Mermaid diagram is empty");
      return;
    }

    let active = true;
    const controller = new AbortController();
    let resizeObserver: ResizeObserver | null = null;
    let measurementFrame: number | null = null;
    let lastReportedHeight: number | null = null;
    const generation = ++generationRef.current;
    const diagramId = `opencraft-mermaid-${reactId}-${generation}`;

    void renderMermaid(enhancements, diagramId, source, surface, theme, controller.signal)
      .then((svgMarkup) => {
        if (!active) return;
        const template = surface.ownerDocument.createElement("template");
        template.innerHTML = svgMarkup;
        const svg = template.content.querySelector("svg");
        if (!(svg instanceof SVGSVGElement)) {
          throw new Error("Mermaid did not produce an SVG document");
        }
        svg.style.height = "auto";
        svg.style.maxHeight = "none";
        surface.replaceChildren(svg);
        surface.dataset.mermaidTheme = theme;

        const measure = () => {
          if (!active) return;
          const height = measureDiagram(block, surface, svg);
          if (height === lastReportedHeight) return;
          lastReportedHeight = height;
          onRendered(renderKey, height);
        };
        const scheduleMeasure = () => {
          if (measurementFrame !== null) return;
          measurementFrame =
            surface.ownerDocument.defaultView?.requestAnimationFrame(() => {
              measurementFrame = null;
              measure();
            }) ?? null;
        };
        measure();
        scheduleMeasure();
        if (typeof ResizeObserver !== "undefined") {
          // Measurement writes natural-width metadata. Commit it in the next
          // frame so ResizeObserver delivery itself remains read-only.
          resizeObserver = new ResizeObserver(scheduleMeasure);
          resizeObserver.observe(surface);
          if (block.parentElement !== null) {
            resizeObserver.observe(block.parentElement);
          }
        }
      })
      .catch((reason: unknown) => {
        if (!active) return;
        onError(
          renderKey,
          reason instanceof Error ? reason.message : String(reason),
        );
      });

    return () => {
      active = false;
      controller.abort();
      resizeObserver?.disconnect();
      if (measurementFrame !== null) {
        surface.ownerDocument.defaultView?.cancelAnimationFrame(
          measurementFrame,
        );
      }
      surface.replaceChildren();
    };
  }, [
    blockRef,
    code,
    enhancements,
    onError,
    onRendered,
    reactId,
    renderKey,
    surfaceRef,
    theme,
  ]);

  return null;
}

function ExpandIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16">
      <path d="M6 2H2v4M10 14h4v-4M2 6l4-4m4 12 4-4" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16">
      <rect height="8" rx="1.5" width="8" x="5" y="2" />
      <path d="M11 10v2.5A1.5 1.5 0 0 1 9.5 14h-6A1.5 1.5 0 0 1 2 12.5v-6A1.5 1.5 0 0 1 3.5 5H6" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16">
      <path d="M8 2v8m-3-3 3 3 3-3M3 13h10" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16">
      <path d="m4 4 8 8m0-8-8 8" />
    </svg>
  );
}

function downloadSvg(svg: string): void {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const anchor = document.createElement("a");
  anchor.download = "mermaid-diagram.svg";
  anchor.href = url;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function serializeSvgForPreview(
  source: SVGSVGElement,
  surface: HTMLElement,
): string {
  const clone = source.cloneNode(true) as SVGSVGElement;
  const background = cssToken(
    surface,
    "--color-background-surface",
    "rgb(255, 255, 255)",
  );
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.style.setProperty("--mermaid-surface-background", background);
  const { x, y, width, height } = source.viewBox.baseVal;
  if (width > 0 && height > 0) {
    clone.setAttribute("width", String(width));
    clone.setAttribute("height", String(height));
    clone.style.width = `${width}px`;
    clone.style.height = `${height}px`;
    clone.style.maxWidth = "none";
    const backdrop = source.ownerDocument.createElementNS(
      "http://www.w3.org/2000/svg",
      "rect",
    );
    backdrop.setAttribute("x", String(x));
    backdrop.setAttribute("y", String(y));
    backdrop.setAttribute("width", String(width));
    backdrop.setAttribute("height", String(height));
    backdrop.setAttribute("fill", background);
    clone.prepend(backdrop);
  }
  return clone.outerHTML;
}

function MermaidPreview({
  svg,
  onClose,
}: {
  readonly svg: string;
  readonly onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      aria-label="Mermaid diagram preview"
      className="chat-mermaid-preview"
      onCancel={onClose}
      onClose={onClose}
      ref={dialogRef}
    >
      <div
        className="chat-mermaid-preview__diagram"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div className="chat-mermaid-preview__actions">
        <button
          aria-label="Download Mermaid diagram"
          onClick={() => downloadSvg(svg)}
          type="button"
        >
          <DownloadIcon />
        </button>
        <button
          aria-label="Close Mermaid preview"
          onClick={onClose}
          type="button"
        >
          <CloseIcon />
        </button>
      </div>
    </dialog>
  );
}

function MermaidDiagram({
  context,
  code,
  enhancements,
}: {
  readonly context: ChatRenderContext;
  readonly code: string;
  readonly enhancements: ChatEnhancementService;
}) {
  const renderKey = createMermaidRenderKey(context.theme, code);
  const [state, dispatch] = useReducer(
    reduceMermaidRenderState,
    renderKey,
    createMermaidRenderState,
  );
  const blockRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [previewSvg, setPreviewSvg] = useState<string | null>(null);
  const presentedState = useMemo(
    () =>
      state.activeKey === renderKey
        ? state
        : reduceMermaidRenderState(state, { type: "begin", key: renderKey }),
    [renderKey, state],
  );

  useLayoutEffect(() => {
    dispatch({ type: "begin", key: renderKey });
  }, [renderKey]);

  const requestMeasurement = context.requestMeasurement;
  const handleRendered = useCallback(
    (key: string, height: number) => {
      dispatch({ type: "rendered", key, height });
      requestMeasurement?.({
        geometryChanged: true,
        reason: "diagram-render",
      });
    },
    [requestMeasurement],
  );
  const handleError = useCallback((key: string, error: string) => {
    dispatch({ type: "failed", key, error });
  }, []);

  useEffect(() => {
    if (
      presentedState.activeKey !== renderKey ||
      presentedState.status !== "rendered"
    ) {
      return;
    }
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const timer = window.setTimeout(
      () => dispatch({ type: "reveal", key: renderKey }),
      reducedMotion ? 0 : MERMAID_REVEAL_DURATION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [presentedState.activeKey, presentedState.status, renderKey]);

  if (presentedState.status === "error") {
    return (
      <div className="chat-mermaid-error" data-mermaid-error="true">
        <CodeBlockSurface
          code={code}
          language="mermaid"
          stickyHeader={context.stickyCodeHeaders}
        />
      </div>
    );
  }

  const revealed = isMermaidRenderRevealed(presentedState);
  const fencedCode = `\`\`\`mermaid\n${code}\n\`\`\``;
  const openPreview = () => {
    const svg = surfaceRef.current?.querySelector("svg");
    const surface = surfaceRef.current;
    if (svg instanceof SVGSVGElement && surface !== null) {
      setPreviewSvg(serializeSvgForPreview(svg, surface));
    }
  };

  return (
    <div
      className="chat-mermaid-block"
      data-markdown-copy="code-block"
      data-markdown-copy-text={fencedCode}
      data-wide-markdown-block={context.allowWideBlocks || undefined}
      data-wide-markdown-block-kind={
        context.allowWideBlocks ? "mermaid" : undefined
      }
      ref={blockRef}
    >
      <div
        className="chat-mermaid-shell"
        style={{ height: mermaidShellHeight(presentedState) }}
      >
        <div
          aria-hidden={revealed || undefined}
          aria-label="Loading Mermaid diagram"
          className="chat-mermaid-placeholder"
          data-visible={!revealed || undefined}
          role="status"
        />
        <div
          aria-hidden={!revealed || undefined}
          aria-label={revealed ? "Mermaid diagram" : undefined}
          className="chat-mermaid-surface"
          data-visible={revealed || undefined}
          dir="ltr"
          ref={surfaceRef}
          role={revealed ? "img" : undefined}
          tabIndex={-1}
        >
          <MermaidSvgRenderer
            blockRef={blockRef}
            code={code}
            enhancements={enhancements}
            onError={handleError}
            onRendered={handleRendered}
            renderKey={renderKey}
            surfaceRef={surfaceRef}
            theme={context.theme}
          />
        </div>
      </div>
      <div className="chat-mermaid-actions" data-markdown-copy="exclude">
        <button
          aria-label="Expand Mermaid diagram"
          onClick={openPreview}
          type="button"
        >
          <ExpandIcon />
        </button>
        <button
          aria-label="Copy Mermaid source"
          onClick={() => void writeTextToClipboard(fencedCode)}
          type="button"
        >
          <CopyIcon />
        </button>
      </div>
      <span className="sr-only">Mermaid source code</span>
      <pre className="sr-only">{code}</pre>
      {previewSvg === null ? null : (
        <MermaidPreview onClose={() => setPreviewSvg(null)} svg={previewSvg} />
      )}
    </div>
  );
}

export function MermaidDiagramRenderer({
  context,
  enhancements,
  node,
}: ChatNodeRendererProps & { readonly enhancements: ChatEnhancementService }) {
  if (node.kind !== "code-fence") return null;
  return <MermaidDiagram code={node.code} context={context} enhancements={enhancements} />;
}
