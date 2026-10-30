import { useIntl } from "@opencraft/i18n/react";
import { useEffect, useRef, useState } from "react";
import type { ChatNodeRendererProps, ChatResourcePolicyService } from "@opencraft/chat-render-react";
import { visualizationDocument } from "./sandbox";
import "./visualization.scss";

const aliases: Record<string, string> = {
  background: "--color-background-surface", foreground: "--color-text",
  card: "--color-background-panel", "card-foreground": "--color-text",
  popover: "--color-background-elevated-primary-opaque", "popover-foreground": "--color-text",
  primary: "--color-background-button-primary", "primary-foreground": "--color-text-button-primary",
  secondary: "--color-background-button-secondary", "secondary-foreground": "--color-text-button-secondary",
  muted: "--color-background-panel", "muted-foreground": "--color-text-secondary",
  accent: "--color-background-navigation-current", "accent-foreground": "--color-text",
  destructive: "--color-text-danger", border: "--color-border-default", input: "--color-background-input",
  ring: "--color-border-focus", blue: "--color-text-accent", orange: "--color-text-warning",
  green: "--color-status-success", red: "--color-text-danger", purple: "--color-text-accent", yellow: "--color-text-warning",
};

export function createVisualizationRenderer(resources: ChatResourcePolicyService) {
  return function Visualization({ node, context }: ChatNodeRendererProps) {
    const intl = useIntl();
    const root = useRef<HTMLElement>(null);
    const frame = useRef<HTMLIFrameElement>(null);
    const [result, setResult] = useState<{ key: string; html?: string; error?: string } | null>(null);
    const [height, setHeight] = useState(260);
    const [attempt, setAttempt] = useState(0);
    const [navigated, setNavigated] = useState(false);
    const loads = useRef(0);
    const path = node.kind === "directive" ? node.attributes.path ?? "" : "";
    const decision = resources.resolve(path, context);
    const target = decision.allowed && decision.kind === "file" ? decision.target : null;
    const key = JSON.stringify([context.hostId, context.conversationId, context.documentId, target, attempt]);
    const loader = context.loadMediaSource;
    const current = useRef(context); current.current = context;
    const unavailable = !loader || !target || !/\.html?$/iu.test(path) || context.dialect === "user-message";
    const colors = () => {
      if (!root.current) return {};
      const style = getComputedStyle(root.current);
      const result = Object.fromEntries(Object.entries(aliases).map(([name, token]) => [name, style.getPropertyValue(token).trim()]));
      result["font-size-base"] = style.fontSize;
      for (let index = 1; index <= 6; index++) result[`viz-series-${index}`] = result[["blue", "orange", "green", "red", "purple", "yellow"][index - 1]!]!;
      return result;
    };
    const updateTheme = () => frame.current?.contentWindow?.postMessage({ type: "opencraft:visualization-theme", theme: current.current.theme, colors: colors() }, "*");
    useEffect(() => { updateTheme(); }, [context.theme]);
    useEffect(() => {
      if (unavailable) return;
      const abort = new AbortController();
      let active = true;
      loads.current = 0; setNavigated(false);
      void (async () => {
        const lease = await loader!({ source: path, resolvedTarget: target!, resourceKind: "file",
          signal: abort.signal, documentId: context.documentId, hostId: context.hostId ?? null,
          conversationId: context.conversationId ?? null, cwd: context.cwd ?? null });
        try {
          if (!lease) throw new Error("Visualization file unavailable");
          // Only read the Host's leased local object. Never fetch an arbitrary URL supplied by HTML.
          if (!/^(?:blob:|data:)/u.test(lease.source)) throw new Error("Inline visualization requires a local file resource");
          const response = await fetch(lease.source, { signal: abort.signal });
          const blob = await response.blob();
          if (blob.size > 1048576) throw new Error("Visualization exceeds 1 MB");
          const html = await blob.text();
          if (active) setResult({ key, html: visualizationDocument(html, current.current.theme, colors()) });
        } finally { lease?.release?.(); }
      })().catch(error => { if (active) setResult({ key, error: error instanceof Error ? error.message : String(error) }); });
      return () => { active = false; abort.abort(); };
    }, [key, unavailable, loader]);
    useEffect(() => {
      const receive = (event: MessageEvent) => {
        if (event.source !== frame.current?.contentWindow || event.origin !== "null"
          || event.data?.type !== "opencraft:visualization-size" || typeof event.data.height !== "number"
          || !Number.isFinite(event.data.height)) return;
        setHeight(Math.max(80, Math.min(1600, event.data.height)));
        current.current.requestMeasurement?.({ reason: "resource-resolve", geometryChanged: true });
      };
      window.addEventListener("message", receive);
      return () => window.removeEventListener("message", receive);
    }, []);
    const loaded = result?.key === key ? result : null;
    const title = node.kind === "directive" && node.attributes.title ? node.attributes.title : intl.formatMessage({ id: "chat.visualization.title", defaultMessage: "Visualization" });
    return <section ref={root} className="chat-visualization" data-wide-block={context.allowWideBlocks && node.kind === "directive" && node.attributes.mode === "wide" ? "true" : undefined} aria-label={title}>
      {unavailable || loaded?.error || navigated ? <div role="status">
        {navigated ? intl.formatMessage({ id: "chat.visualization.navigationBlocked", defaultMessage: "Visualization navigation is not allowed" }) : intl.formatMessage({ id: "chat.visualization.unavailable", defaultMessage: "Inline visualization unavailable" })}
        {!unavailable && <button type="button" onClick={() => setAttempt(value => value + 1)}>{intl.formatMessage({ id: "common.retry", defaultMessage: "Try again" })}</button>}
        {decision.allowed && decision.target && context.openResource && <button type="button" onClick={() => context.openResource?.(decision.target!, decision)}>{intl.formatMessage({ id: "chat.visualization.openFile", defaultMessage: "Open file" })}</button>}
      </div> : loaded?.html ? <iframe ref={frame} title={title} srcDoc={loaded.html} sandbox="allow-scripts" referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
        style={{ height }} onLoad={() => { if (++loads.current > 1) setNavigated(true); else updateTheme(); }} /> : <div role="status">{intl.formatMessage({ id: "chat.visualization.loading", defaultMessage: "Loading visualization…" })}</div>}
    </section>;
  };
}
