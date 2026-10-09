import { MobileAgentPanelSurface, MobileAgentPanelToggle } from "./mobile-agent-panels.shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Typography } from "heroui-native";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { LIGHTVELA_REGIONS } from "@opencraft/plugin-lightvela-hermes/account-contract";
import { MOBILE_BOT_EVENT, encodeBotBridgeMessage, parseBotToHostMessage, type AgentsExpoWebOptions, type BotCommand, type HostPanelState, type BotSummary } from "@opencraft/mobile-bot-bridge";
import { MobileAgentNavigation, isAgentSection, type Section, type BotAvatarModel } from "./mobile-agent-navigation.shared";
import { resolveMobileShellLayout } from "../runtime/mobile-shell-layout";
import { mobileVisualTokens } from "../runtime/mobile-visual-tokens";
import { agentDomBootstrap } from "../runtime/agent-dom-bootstrap";
import { MobileShellPanelButton } from "./mobile-shell-panel-button.shared";
import { useBotNavigationPresentation } from "./use-bot-navigation-presentation";

/** One mounted content container; resizing changes geometry, never runtime identity. */
export function AgentsWebShell({ options }: { options: AgentsExpoWebOptions }) {
  const [width, setWidth] = useState(0);
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [html, setHtml] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [section, setSection] = useState<Section>("chat");
  const [botId, setBotId] = useState("");
  const [bots, setBots] = useState<readonly BotSummary[]>([]);
  const catalogRef = useRef<readonly BotSummary[]>([]);
  const [avatars, setAvatars] = useState<Record<string, BotAvatarModel>>({});
  const [catalog, setCatalog] = useState({ loading: true, error: false });
  const [creation, setCreation] = useState({ visible: false, enabled: false });
  const [panelState, setPanelState] = useState<HostPanelState | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const capabilities = useRef(new Set<BotCommand["type"]>());
  const lifetimeId = useRef(crypto.randomUUID()).current;
  const runtimeId = `${lifetimeId}:${generation}`;
  const currentRuntime = useRef(runtimeId); currentRuntime.current = runtimeId;
  const navigation = useBotNavigationPresentation(`${runtimeId}:${options.region}:${options.language}`, botId, ready);
  const selection = useRef({ section, botId }); selection.current = { section, botId };
  const zh = options.language === "zh-CN";
  const site = LIGHTVELA_REGIONS[options.region];
  const layout = resolveMobileShellLayout(width, mobileVisualTokens.shell);
  const docked = layout.navigation === "sidebar";
  const navigationVisible = docked ? !collapsed : open;
  const sendCommand = useCallback((command: BotCommand) => {
    if (!capabilities.current.has(command.type)) return;
    frame.current?.contentWindow?.postMessage({ type: MOBILE_BOT_EVENT, detail: encodeBotBridgeMessage(runtimeId, command) }, window.location.origin);
  }, [runtimeId]);
  const select = useCallback((next: Section, id: string, keepNavigation = false) => {
    if (id !== selection.current.botId) setPanelState(null);
    navigation.select(id);
    selection.current = { section: next, botId: id };
    setSection(next); setBotId(id); if (!keepNavigation) setOpen(false);
    sendCommand({ type: "select", section: next, botId: id });
  }, [sendCommand, navigation.select]);
  useEffect(() => {
    const abort = new AbortController();
    setReady(false); setFailed(false); setPanelState(null); capabilities.current.clear();
    void fetch(options.runtimeHtmlUrl, { signal: abort.signal }).then(response => {
      if (!response.ok) throw new Error("runtime.failed");
      return response.text();
    }).then(setHtml).catch(() => { if (!abort.signal.aborted) { setFailed(true); options.onDiagnostic?.("runtime.failed"); } });
    return () => abort.abort();
  }, [options.runtimeHtmlUrl, generation]);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (runtimeId !== currentRuntime.current || event.source !== frame.current?.contentWindow || event.origin !== window.location.origin || typeof event.data !== "string") return;
      const message = parseBotToHostMessage(event.data, runtimeId);
      if (!message) return;
      if (message.type === "bot-runtime-ready") { capabilities.current = new Set(message.capabilities); setReady(true); sendCommand({ type: "select", ...selection.current }); }
      if (message.type === "chat-panel-state" && catalogRef.current.some(bot => bot.id === selection.current.botId
        && bot.instanceId === message.instanceId && bot.profileId === message.profileId)) setPanelState(message.state);
      if (message.type === "chat-panel-action-failed") options.onDiagnostic?.("panel.failed");
      if (message.type === "bot-catalog") {
        catalogRef.current = message.bots;
        if (!message.loading && !message.error) navigation.prune(message.bots.map(bot => bot.id));
        setBots(message.bots); setCatalog({ loading: message.loading, error: message.error });
        if (message.bots.length && !message.bots.some(bot => bot.id === selection.current.botId)) select(selection.current.section, message.bots[0]!.id);
        if (!message.loading && !message.error && !message.bots.length && selection.current.botId) select("chat", "");
      }
      if (message.type === "bot-avatar") setAvatars(current => ({ ...current, [message.botId]: message }));
      if (message.type === "bot-selection" && isAgentSection(message.section)) {
        if (message.botId !== selection.current.botId) setPanelState(null);
        navigation.select(message.botId);
        selection.current = { section: message.section, botId: message.botId };
        setSection(message.section); setBotId(message.botId);
      }
      if (message.type === "bot-console-state" && catalogRef.current.some(bot => bot.id === message.botId)) navigation.receive(message, selection.current.botId);
      if (message.type === "bot-create-state") setCreation(message);
      if (message.type === "external-navigation") options.onExternalNavigation(message.href);
      if (message.type === "signed-out") options.onSignedOut();
      if (message.type === "bot-section-render-failed") { setFailed(true); options.onDiagnostic?.("section.failed"); }
      if (message.type === "bot-runtime-script-failed" && !capabilities.current.size) { setFailed(true); options.onDiagnostic?.("runtime.failed"); }
      if (message.type === "bot-api-http-failed" || message.type === "bot-api-network-failed") options.onDiagnostic?.("api.failed");
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [runtimeId, options, select, sendCommand, navigation.select, navigation.receive, navigation.prune]);
  useEffect(() => {
    if (!html || ready || failed) return;
    const timer = setTimeout(() => { setFailed(true); options.onDiagnostic?.("runtime.failed"); }, 20_000);
    return () => clearTimeout(timer);
  }, [html, ready, failed, runtimeId]);
  useEffect(() => {
    if (!ready) return;
    const report = () => sendCommand({ type: "visibility", active: window.document.visibilityState !== "hidden" });
    report(); window.document.addEventListener("visibilitychange", report);
    return () => window.document.removeEventListener("visibilitychange", report);
  }, [ready, sendCommand]);
  const document = useMemo(() => {
    if (!html) return undefined;
    const bootstrap = agentDomBootstrap({ runtimeId, region: options.region === "cn" ? "cn" : "global", apiBase: site.apiBase, siteOrigin: site.frontendBase, token: options.token, locale: options.language });
    const adapter = `window.ReactNativeWebView={postMessage:message=>parent.postMessage(message,${JSON.stringify(window.location.origin)})};window.addEventListener('message',event=>{if(event.source===parent&&event.origin===${JSON.stringify(window.location.origin)}&&event.data?.type===${JSON.stringify(MOBILE_BOT_EVENT)})window.dispatchEvent(new CustomEvent(${JSON.stringify(MOBILE_BOT_EVENT)},{detail:event.data.detail}));});`;
    return html.replace("<head>", `<head><base href="${site.frontendBase}/"><script>${(adapter + bootstrap).replaceAll("</script", "<\\/script")}</script>`);
  }, [html, runtimeId, options.token, options.language, options.region, site]);
  const retry = () => { setGeneration(value => value + 1); };
  return <View style={styles.root} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
    <View style={[styles.navigation, { width: layout.navigationWidth, display: navigationVisible ? "flex" : "none", position: docked ? "relative" : "absolute" }]}>
      <MobileAgentNavigation language={zh ? "zh-CN" : "en-US"} bots={bots} botId={botId} section={section} botAvatars={avatars}
        ready={ready} botsLoading={catalog.loading} botsError={catalog.error} botsTimedOut={false} createVisible={creation.visible} createEnabled={creation.enabled}
        navigation={navigation} accountIdentity={options.account} select={select} sendCommand={sendCommand}
        retryBots={() => sendCommand({ type: "refresh" })} onDismiss={() => setOpen(false)} onOpenAccount={options.onOpenAccount} />
    </View>
    {!docked && open ? <Button accessibilityLabel={zh ? "关闭菜单" : "Close menu"} style={styles.scrim} onPress={() => setOpen(false)} /> : null}
    <View style={styles.content}>
      <View style={styles.toolbar}><MobileShellPanelButton side="left" open={navigationVisible}
        label={zh ? "智能体菜单" : "Agent menu"} onPress={() => docked ? setCollapsed(value => !value) : setOpen(value => !value)} />
        <Typography.Heading type="h4" numberOfLines={1} style={{ flex: 1 }}>{bots.find(bot => bot.id === botId)?.name ?? (zh ? "我的智能体" : "My agents")}</Typography.Heading>
        <MobileAgentPanelToggle state={panelState} enabled={ready && section === "chat"} zh={zh} send={sendCommand} /></View>
      <MobileAgentPanelSurface state={panelState} enabled={ready && section === "chat"} zh={zh} send={sendCommand}>
        <View style={{ flex: 1, minHeight: 0 }}>
        {document ? <iframe ref={frame} title={zh ? "智能体工作区" : "Agent workspace"} srcDoc={document} sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" style={{ border: 0, width: "100%", height: "100%", display: "block", position: "absolute", inset: 0 }} onLoad={() => {
          try { if (frame.current?.contentWindow?.location.href !== "about:srcdoc") { setFailed(true); options.onDiagnostic?.("runtime.failed"); } } catch { setFailed(true); options.onDiagnostic?.("runtime.failed"); }
        }} /> : null}
        {!ready && !failed ? <View style={styles.cover}><ActivityIndicator color={mobileVisualTokens.color.accent} /></View> : null}
        {failed ? <View style={styles.cover}><Card><Card.Body><Card.Title>{zh ? "暂时无法打开" : "Could not open"}</Card.Title></Card.Body><Card.Footer><Button onPress={retry}>{zh ? "重新加载" : "Reload"}</Button></Card.Footer></Card></View> : null}
        </View>
      </MobileAgentPanelSurface>
    </View>
  </View>;
}
const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: "row", minHeight: 0, overflow: "hidden", backgroundColor: mobileVisualTokens.color.canvas },
  navigation: { top: 0, bottom: 0, left: 0, zIndex: 3, backgroundColor: mobileVisualTokens.color.sidebar },
  scrim: { ...StyleSheet.absoluteFill, zIndex: 2, backgroundColor: "rgba(0,0,0,0.2)", borderRadius: 0 },
  content: { flex: 1, minWidth: 0, minHeight: 0 },
  toolbar: { height: 54, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, backgroundColor: mobileVisualTokens.color.surface },
  frame: { flex: 1, minHeight: 0 },
  cover: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", backgroundColor: mobileVisualTokens.color.surface },
});
