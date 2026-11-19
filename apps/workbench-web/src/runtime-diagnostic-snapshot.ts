import type { CssSupportProbe, RuntimeEnvironmentSnapshot, RuntimeDiagnosticErrorEntry, RuntimeDiagnosticNetworkEntry } from "./runtime-diagnostics";

// Loaded with the diagnostic export/developer surface, never normal startup.
function readSafeAreaInset(side: "top" | "right" | "bottom" | "left"): string {
  if (typeof window === "undefined" || typeof document === "undefined") return "0px";
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.padding = `env(safe-area-inset-${side}, 0px)`;
  document.documentElement.appendChild(probe);
  const value = window.getComputedStyle(probe).paddingTop || "0px";
  probe.remove();
  return value;
}

export function parseAppleVersions(userAgent: string): { readonly iosVersion?: string; readonly safariVersion?: string } {
  const ios = /(?:iPhone|iPad|iPod).*?OS (\d+)[._](\d+)(?:[._](\d+))?/u.exec(userAgent)
    || (/\bMacintosh\b/u.test(userAgent) && /Mobile\/\w+/u.test(userAgent) ? /Version\/(\d+)\.(\d+)(?:\.(\d+))?/u.exec(userAgent) : null);
  const safari = /Version\/(\d+)\.(\d+)(?:\.(\d+))?.*Safari/u.exec(userAgent);
  const iosVersion = ios ? [ios[1], ios[2], ios[3]].filter(Boolean).join(".") : undefined;
  const safariVersion = safari ? [safari[1], safari[2], safari[3]].filter(Boolean).join(".") : undefined;
  return {
    ...(iosVersion ? { iosVersion } : {}),
    ...(safariVersion ? { safariVersion } : {}),
  };
}

export function captureRuntimeEnvironment(): RuntimeEnvironmentSnapshot {
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const visual = typeof window === "undefined" ? undefined : window.visualViewport;
  const buildId = typeof document === "undefined"
    ? undefined
    : document.querySelector<HTMLMetaElement>('meta[name="opencraft-build-id"]')?.content?.trim() || undefined;
  const colorScheme = typeof document === "undefined"
    ? "unknown"
    : document.documentElement.dataset.theme
      || (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  return {
    userAgent,
    ...parseAppleVersions(userAgent),
    innerWidth: typeof window === "undefined" ? 0 : window.innerWidth,
    innerHeight: typeof window === "undefined" ? 0 : window.innerHeight,
    ...(visual ? {
      visualViewport: {
        width: visual.width,
        height: visual.height,
        offsetTop: visual.offsetTop,
        offsetLeft: visual.offsetLeft,
        scale: visual.scale,
      },
    } : {}),
    devicePixelRatio: typeof window === "undefined" ? 1 : window.devicePixelRatio,
    safeAreaInsets: {
      top: readSafeAreaInset("top"),
      right: readSafeAreaInset("right"),
      bottom: readSafeAreaInset("bottom"),
      left: readSafeAreaInset("left"),
    },
    touchInteraction: typeof document !== "undefined" && document.documentElement.dataset.touchInteraction === "true",
    colorScheme,
    language: typeof navigator === "undefined" ? "" : navigator.language,
    ...(buildId ? { buildId } : {}),
    ...(typeof document === "undefined"
      ? {}
      : (() => {
          const sourceRevision = document.querySelector<HTMLMetaElement>('meta[name="opencraft-source-revision"]')?.content?.trim();
          return sourceRevision ? { sourceRevision } : {};
        })()),
    path: typeof window === "undefined" ? "/" : window.location.pathname,
  };
}

export const CSS_SUPPORT_PROBES: readonly { readonly id: string; readonly label: string; readonly query: readonly [string] | readonly [string, string] }[] = [
  { id: "has", label: ":has()", query: ["selector(:has(*))"] },
  { id: "container", label: "container queries", query: ["container-type", "inline-size"] },
  { id: "dvh", label: "dvh", query: ["height", "1dvh"] },
  { id: "color-mix", label: "color-mix()", query: ["color", "color-mix(in srgb, red 50%, blue)"] },
  { id: "nesting", label: "CSS nesting", query: ["selector(&)"] },
  { id: "subgrid", label: "subgrid", query: ["grid-template-columns", "subgrid"] },
  { id: "oklch", label: "oklch()", query: ["color", "oklch(0.7 0.1 180)"] },
  { id: "aspect-ratio", label: "aspect-ratio", query: ["aspect-ratio", "1 / 1"] },
  { id: "view-transition", label: "view-transition-name", query: ["view-transition-name", "none"] },
  { id: "safe-area", label: "env(safe-area-inset)", query: ["padding-bottom", "env(safe-area-inset-bottom, 0px)"] },
];

export function probeCssSupports(
  supports: ((property: string, value?: string) => boolean) | null = typeof CSS === "undefined" ? null : CSS.supports.bind(CSS),
): readonly CssSupportProbe[] {
  return CSS_SUPPORT_PROBES.map((probe) => {
    if (!supports) return { id: probe.id, label: probe.label, supported: null };
    try {
      const supported = probe.query.length === 1
        ? supports(probe.query[0]!)
        : supports(probe.query[0]!, probe.query[1]);
      return { id: probe.id, label: probe.label, supported };
    } catch {
      return { id: probe.id, label: probe.label, supported: null };
    }
  });
}

export function formatDiagnosticsCopy(input: {
  readonly environment: RuntimeEnvironmentSnapshot;
  readonly css: readonly CssSupportProbe[];
  readonly errors: readonly RuntimeDiagnosticErrorEntry[];
  readonly network: readonly RuntimeDiagnosticNetworkEntry[];
}): string {
  const lines = [
    "# OpenCraft diagnostics",
    `path: ${input.environment.path}`,
    `ua: ${input.environment.userAgent}`,
    `ios: ${input.environment.iosVersion ?? "-"}`,
    `safari: ${input.environment.safariVersion ?? "-"}`,
    `viewport: ${input.environment.innerWidth}x${input.environment.innerHeight}`,
    `visualViewport: ${input.environment.visualViewport
      ? `${input.environment.visualViewport.width}x${input.environment.visualViewport.height} @${input.environment.visualViewport.scale}`
      : "-"}`,
    `dpr: ${input.environment.devicePixelRatio}`,
    `safe-area: ${input.environment.safeAreaInsets.top} ${input.environment.safeAreaInsets.right} ${input.environment.safeAreaInsets.bottom} ${input.environment.safeAreaInsets.left}`,
    `touch: ${input.environment.touchInteraction ? "yes" : "no"}`,
    `colorScheme: ${input.environment.colorScheme}`,
    `language: ${input.environment.language}`,
    ...(input.environment.buildId ? [`buildId: ${input.environment.buildId}`] : []),
    ...(input.environment.sourceRevision ? [`sourceRevision: ${input.environment.sourceRevision}`] : []),
    "",
    "## CSS.supports",
    ...input.css.map((probe) => `${probe.label}: ${probe.supported === null ? "unknown" : probe.supported ? "yes" : "no"}`),
    "",
    "## Errors",
    ...input.errors.map((entry) => {
      const stack = entry.stack ? `\n${entry.stack}` : "";
      const component = entry.componentStack ? `\ncomponentStack:${entry.componentStack}` : "";
      return `${new Date(entry.at).toISOString()} ${entry.source} ${entry.message}${stack}${component}`;
    }),
    "",
    "## Network",
    ...input.network.map((entry) => {
      const status = entry.status !== undefined ? ` ${entry.status}` : "";
      const duration = entry.durationMs !== undefined ? ` ${entry.durationMs}ms` : "";
      const code = entry.code !== undefined ? ` code=${entry.code}` : "";
      return `${new Date(entry.at).toISOString()} ${entry.channel} ${entry.event} ${entry.path}${status}${duration}${code}`;
    }),
  ];
  return lines.join("\n");
}
