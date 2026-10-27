import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createClientId } from "@opencraft/composer-core";
import { useIntl } from "@opencraft/i18n/react";
import type { TimelineBlock } from "@opencraft/chat-core";
import { ConversationDocumentContext } from "../components/conversation/document-context";
import { createAppBridge } from "./bridge";
import { boundedJson, record, type McpAppIdentity, type McpAppPort, type McpAppWidgetState } from "./contract";
import { readAppResource, type AppResource } from "./policy";
import { sandboxDocument } from "./sandbox";
import "./app-surface.scss";

type AppBlock = Extract<TimelineBlock, { type: "tool-call" }>;
function resultOf(block: AppBlock): unknown {
  if (block.errorMessage) return { isError: true, content: [{ type: "text", text: block.errorMessage }] };
  if (block.output == null) return null;
  const output = record(block.appToolResult ?? block.output);
  return Array.isArray(output.content) ? output : { content: [{ type: "text", text: typeof block.output === "string" ? block.output : boundedJson(block.output) }] };
}
function LiveApp({ port, identity, block, theme, locale, state, onHeight }: {
  port: McpAppPort; identity: McpAppIdentity; block: AppBlock; theme: string; locale: string;
  state: { current: unknown }; onHeight: (height: number) => void;
}) {
  const [resource, setResource] = useState<AppResource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const token = useMemo(() => createClientId(), []);
  const loads = useRef(0);
  const current = useRef({ block, theme, locale }); current.current = { block, theme, locale };
  const intl = useIntl();
  const context = () => ({ theme: current.current.theme, locale: current.current.locale, displayMode: "inline", availableDisplayModes: ["inline"], platform: "web", containerDimensions: { maxHeight: 1600, maxWidth: iframe.current?.clientWidth } });
  const globals = () => ({ theme: current.current.theme, locale: current.current.locale, displayMode: "inline", maxHeight: 1600,
    toolInput: current.current.block.input, toolOutput: record(current.current.block.appToolResult ?? current.current.block.output).structuredContent ?? current.current.block.output,
    toolResponseMetadata: record(current.current.block.appToolResult ?? current.current.block.output)._meta ?? {}, widgetState: state.current });
  const bridgeRef = useRef<ReturnType<typeof createAppBridge> | null>(null);
  const send = (data: unknown) => iframe.current?.contentWindow?.postMessage(data, "*");
  const sendLegacy = (data: unknown) => send({ ...record(data), __opencraft: token });
  const documentSource = useMemo(() => {
    try { return { html: resource ? sandboxDocument(resource, globals(), token) : undefined, error: null }; }
    catch (reason) { return { html: undefined, error: reason instanceof Error ? reason.message : String(reason) }; }
  }, [resource, token]);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => { active = false; setError("MCP App resource timed out"); }, 15000);
    void port.readResource(identity.server, identity.uri, identity.callId).then(result => {
      if (!active) return;
      port.assertCurrent(); setResource(readAppResource(result, identity.uri, identity.callId));
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => clearTimeout(timer));
    return () => { active = false; clearTimeout(timer); };
  }, [port, identity.server, identity.uri, identity.callId]);
  useLayoutEffect(() => {
    const bridge = createAppBridge({ port, identity, contextId: block.id, hostContext: context,
      input: () => current.current.block.input, output: () => resultOf(current.current.block), status: () => current.current.block.status, onHeight,
      onWidgetState: value => { state.current = value; },
      onLog: (level, message) => console.debug("[mcp-app]", { view: block.id, level, message }),
    });
    bridgeRef.current = bridge;
    const receive = (event: MessageEvent) => {
      if (!iframe.current || event.source !== iframe.current.contentWindow || event.origin !== "null") return;
      const data = record(event.data);
      const legacy = data.__opencraft === token;
      void bridge.receive(data, legacy ? sendLegacy : send, legacy);
    };
    window.addEventListener("message", receive);
    return () => { window.removeEventListener("message", receive); bridge.dispose(); bridgeRef.current = null; };
  }, [port, identity.server, identity.uri, identity.callId, block.id, onHeight, state, token]);
  useLayoutEffect(() => {
    const element = iframe.current;
    if (!element) return;
    let width = element.clientWidth;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame || element.clientWidth === width) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const nextWidth = element.clientWidth;
        if (width === nextWidth) return;
        width = nextWidth;
        bridgeRef.current?.update(send);
      });
    });
    observer.observe(element);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [resource, error, documentSource.error]);
  useEffect(() => {
    sendLegacy({ method: "opencraft/globals", params: globals() });
    bridgeRef.current?.updateTool(send);
  }, [block.input, block.output, block.appToolResult, block.status, block.errorMessage]);
  useEffect(() => {
    sendLegacy({ method: "opencraft/globals", params: globals() });
    bridgeRef.current?.update(send);
  }, [theme, locale]);
  if (error || documentSource.error) return <div className="mcp-app__error" role="alert">{intl.formatMessage({ id: "mcpApp.failed", defaultMessage: "App unavailable" })}: {error ?? documentSource.error}</div>;
  if (!resource) return <div role="status">{intl.formatMessage({ id: "mcpApp.loading", defaultMessage: "Loading app…" })}</div>;
  return <iframe ref={iframe} className="mcp-app__frame" title={identity.name} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer"
    allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" srcDoc={documentSource.html}
    onLoad={() => { if (++loads.current > 1) { bridgeRef.current?.dispose(); setError("App navigation is not allowed"); } }} />;
}

/** No iframe, app timers or subscriptions survive an offscreen/hidden conversation. */
export default function McpAppSurface({ block }: { readonly block: AppBlock }) {
  const doc = useContext(ConversationDocumentContext);
  const element = useRef<HTMLElement>(null);
  const [localWidgetStates] = useState(() => new Map<string, McpAppWidgetState>());
  const [visible, setVisible] = useState(false);
  const [foreground, setForeground] = useState(document.visibilityState !== "hidden");
  const [attempt, setAttempt] = useState(0);
  const [height, setHeight] = useState(260);
  const intl = useIntl();
  const identity = useMemo<McpAppIdentity>(() => ({ server: block.server ?? "", uri: block.appResourceUri ?? "", callId: block.callId,
    name: block.appName ?? block.name }), [block.server, block.appResourceUri, block.callId, block.appName, block.name]);
  const widgetState = useMemo(() => {
    const ownedState = doc.mcpApps?.widgetState?.(block.id, identity);
    if (ownedState) return ownedState;
    const key = JSON.stringify([doc.mcpApps?.key, block.id, identity.server, identity.uri, identity.callId]);
    let state = localWidgetStates.get(key);
    if (!state) {
      state = { current: null };
      localWidgetStates.set(key, state);
    }
    return state;
  }, [doc.mcpApps, block.id, identity, localWidgetStates]);
  const [pauseChoice, setPauseChoice] = useState(() => ({ state: widgetState, paused: widgetState.pausedByUser === true }));
  // A new App identity reads its own intent before an iframe can mount.
  const paused = pauseChoice.state === widgetState ? pauseChoice.paused : widgetState.pausedByUser === true;
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: "160px" });
    if (element.current) observer.observe(element.current);
    const visibility = () => setForeground(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", visibility);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", visibility); };
  }, [doc.mcpApps]);
  const ready = doc.mcpApps && identity.server && identity.uri.startsWith("ui://");
  if (!ready) return null;
  return <section ref={element} className="mcp-app" aria-label={identity.name}>
    <header className="mcp-app__header"><span>{identity.name}</span><button type="button" onClick={() => { widgetState.pausedByUser = !paused; setPauseChoice({ state: widgetState, paused: !paused }); setAttempt(value => value + 1); }}>
      {paused ? intl.formatMessage({ id: "mcpApp.resume", defaultMessage: "Open app" }) : intl.formatMessage({ id: "mcpApp.pause", defaultMessage: "Pause app" })}
    </button></header>
    <div className="mcp-app__body" style={{ height }}>
      {visible && foreground && !paused ? <LiveApp key={JSON.stringify([doc.mcpApps!.key, block.id, identity.server, identity.uri, identity.callId, attempt])} port={doc.mcpApps!} identity={identity} block={block}
        theme={doc.theme} locale={intl.locale} state={widgetState} onHeight={setHeight} /> : null}
    </div>
  </section>;
}
