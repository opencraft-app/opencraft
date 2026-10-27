import { ExpandIcon as SharedExpandIcon, CopyIcon as SharedCopyIcon, DownloadIcon as SharedDownloadIcon, CloseIcon as SharedCloseIcon } from "@opencraft/design-system-web/action-icons";
import type {
  ChatNodeRendererProps,
  ChatRenderContext,
  ChatRenderTheme,
} from "@opencraft/chat-render-react";
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
import { usePreviewFocusOrigin } from "../../preview-focus-origin";
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
import { cssToken, renderMermaidSvg } from "./mermaid-svg";

async function renderMermaid(
  enhancements: ChatEnhancementService,
  id: string,
  source: string,
  element: HTMLElement,
  theme: ChatRenderTheme,
  signal: AbortSignal,
): Promise<string> {
  return enhancements.run({ lane: "diagram", signal,
    run: runSignal => renderMermaidSvg(id, source, element, theme, runSignal),
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

/**
 * Validate the serialized viewport against the attached SVG's final geometry.
 * Fitting only the outer element can scale an already clipped picture.
 */
function fitDiagramViewport(svg: SVGSVGElement): void {
  const bounds = svg.getBBox();
  const view = svg.viewBox.baseVal;
  if (
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
    bounds.width <= 0 || bounds.height <= 0
  ) return;
  if (
    view.width > 0 && view.height > 0 &&
    bounds.x >= view.x && bounds.y >= view.y &&
    bounds.x + bounds.width <= view.x + view.width &&
    bounds.y + bounds.height <= view.y + view.height
  ) return;
  const padding = 8;
  svg.setAttribute("viewBox", [
    bounds.x - padding, bounds.y - padding,
    bounds.width + padding * 2, bounds.height + padding * 2,
  ].join(" "));
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
  // The shell has its own border; round upward so fractional SVG dimensions
  // never lose their last row of pixels to the shell's clipping boundary.
  const shell = surface.parentElement!;
  return Math.ceil(
    surface.getBoundingClientRect().height +
    numericStyle(shell, "border-top-width") +
    numericStyle(shell, "border-bottom-width"),
  );
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
        fitDiagramViewport(svg);
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

function ExpandIcon() { return <SharedExpandIcon size={16} />; }

function CopyIcon() { return <SharedCopyIcon size={16} />; }

function DownloadIcon() { return <SharedDownloadIcon size={16} />; }

function CloseIcon() { return <SharedCloseIcon size={16} />; }

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
  openedByPointer,
  onKeyboardNavigation,
}: {
  readonly svg: string;
  readonly onClose: () => void;
  readonly openedByPointer: boolean;
  readonly onKeyboardNavigation: ReturnType<typeof usePreviewFocusOrigin>["onPreviewKeyDown"];
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
      data-opened-by-pointer={openedByPointer || undefined}
      onCancel={onClose}
      onClose={onClose}
      onKeyDown={onKeyboardNavigation}
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
  const previewFocus = usePreviewFocusOrigin();
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

  // Document generations change as prose streams past a closed fence. Keep
  // measurement delivery current without restarting the SVG render effect.
  const requestMeasurementRef = useRef(context.requestMeasurement);
  useLayoutEffect(() => {
    requestMeasurementRef.current = context.requestMeasurement;
  }, [context.requestMeasurement]);
  const handleRendered = useCallback(
    (key: string, height: number) => {
      dispatch({ type: "rendered", key, height });
      requestMeasurementRef.current?.({
        geometryChanged: true,
        reason: "diagram-render",
      });
    },
    [],
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
      <span aria-hidden className="chat-mermaid-label" data-markdown-copy="exclude">Mermaid</span>
      <div className="chat-mermaid-actions" data-markdown-copy="exclude">
        <button
          aria-label="Expand Mermaid diagram"
          onClick={(event) => { previewFocus.recordOpen(event); openPreview(); }}
          onKeyDown={previewFocus.onTriggerKeyDown}
          onPointerCancel={previewFocus.onTriggerPointerCancel}
          onPointerDown={previewFocus.onTriggerPointerDown}
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
        <MermaidPreview onClose={() => setPreviewSvg(null)} onKeyboardNavigation={previewFocus.onPreviewKeyDown} openedByPointer={previewFocus.openedByPointer} svg={previewSvg} />
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
