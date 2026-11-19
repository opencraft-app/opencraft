import { captureLocalDiagnostics } from "./runtime/local-diagnostics";
import { getRuntimeDiagnosticsSnapshot } from "./runtime-diagnostics";
import { captureRuntimeEnvironment, probeCssSupports } from "./runtime-diagnostic-snapshot";
import { captureViewportHistory } from "./runtime/viewport-history";
import { measureViewportProbes } from "./runtime/viewport-probes";

// Fixed selectors/properties only: never serialize DOM, input values or storage.
const elements = {
  root: "html",
  body: "body",
  shell: ".app-shell-root",
  row: ".app-shell-row",
  frame: ".main-content-frame",
  viewport: ".main-content-viewport",
  scrollPlane: ".thread-scroll-plane",
  scroll: ".thread-scroll",
  footer: ".thread-scroll-footer",
  composer: ".opencraft-composer-shell",
  editor: ".opencraft-composer-shell [contenteditable=true]",
  send: ".opencraft-composer-submit",
  fixedReference: "[data-timeline-fixed-reference]",
} as const;
const properties = [
  "position",
  "top",
  "bottom",
  "height",
  "min-height",
  "max-height",
  "overflow",
  "overflow-y",
  "padding-top",
  "padding-bottom",
  "margin-top",
  "margin-bottom",
  "transform",
  "contain",
  "box-sizing",
  "--timeline-available-viewport-top",
  "--timeline-available-viewport-height",
  "--timeline-document-viewport-top",
  "--shell-content-safe-bottom",
  "--safe-layout-inset-bottom",
  "--inset-scene-dock",
  "--shell-conversation-bottom-bleed",
];

export function captureBrowserLayout() {
  const active = document.activeElement;
  const focusedComposer = active?.closest(".opencraft-composer-shell");
  return {
    at: Date.now(),
    visibility: document.visibilityState,
    focusedTag: active?.tagName ?? null,
    focusedEditable:
      active instanceof HTMLElement && (active.isContentEditable || /^(INPUT|TEXTAREA)$/.test(active.tagName)),
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    pageTop: window.visualViewport?.pageTop ?? null,
    pageLeft: window.visualViewport?.pageLeft ?? null,
    screen: {
      width: screen.width,
      height: screen.height,
      availableWidth: screen.availWidth,
      availableHeight: screen.availHeight,
    },
    viewportProbes: measureViewportProbes(),
    state: Object.fromEntries(
      [
        "timelineKeyboardOpen",
        "timelineViewportOccluded",
        "timelineTracksVisualViewport",
        "timelineEditingViewportReduced",
        "keyboardClearance",
        "uiDensity",
        "windowHost",
        "windowDisplayMode",
      ].map((key) => [key, document.documentElement.dataset[key] ?? null]),
    ),
    elements: Object.fromEntries(
      Object.entries(elements).map(([name, selector]) => {
        const element =
          name === "composer" && focusedComposer
            ? focusedComposer
            : name === "editor" && focusedComposer
              ? active
              : name === "send" && focusedComposer
                ? focusedComposer.querySelector(selector)
                : document.querySelector(selector);
        if (!element) return [name, null];
        const rect = element.getBoundingClientRect(),
          style = getComputedStyle(element);
        return [
          name,
          {
            rect: {
              top: rect.top,
              left: rect.left,
              bottom: rect.bottom,
              right: rect.right,
              width: rect.width,
              height: rect.height,
            },
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            scrollTop: element.scrollTop,
            style: Object.fromEntries(properties.map((property) => [property, style.getPropertyValue(property)])),
          },
        ];
      }),
    ),
  };
}

function captureDiagnosticContext() {
  return { environment: captureRuntimeEnvironment(), layout: captureBrowserLayout() };
}

function redactDiagnosticText(value: string): string {
  return value
    .slice(0, 12_000)
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/giu, (address) => {
      try {
        const url = new URL(address);
        return `${url.protocol}//${url.host}${url.pathname}`;
      } catch {
        return "[url]";
      }
    })
    .replace(/\bBearer\s+[^\s,;"']+/giu, "Bearer [redacted]")
    .replace(
      /\b(token|password|secret|authorization|cookie|api[_-]?key)\b["']?\s*[=:]\s*["']?[^"'\s,;}]+/giu,
      "$1=[redacted]",
    );
}

export function createBrowserDiagnosticReport() {
  const runtime = getRuntimeDiagnosticsSnapshot();
  const scrub = <T>(value: T): T =>
    JSON.parse(
      JSON.stringify(value, (_key, item: unknown) => (typeof item === "string" ? redactDiagnosticText(item) : item)),
    ) as T;
  return {
    schemaVersion: 2,
    capturedAt: new Date().toISOString(),
    diagnostics: scrub(captureLocalDiagnostics()),
    collection: {
      scope: "queue failures: device-local last 7 days; detailed samples: enabled intervals in current page lifetime",
      console: "captured errors and warnings only",
      network: "captured failures only",
      keyboardBounds: "not exposed by this browser capture",
    },
    current: captureDiagnosticContext(),
    viewport: captureViewportHistory(),
    css: probeCssSupports(),
    runtime: scrub(runtime),
  };
}

export function downloadBrowserDiagnostics(): void {
  const report = createBrowserDiagnosticReport();
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  try {
    link.href = url;
    link.download = `opencraft-diagnostics-${report.capturedAt.replace(/[:.]/g, "-")}.json`;
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    // iOS may consume the download navigation after the click handler returns.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
