import { AppState } from "react-native";
import { MobileNativeAudio } from "../runtime/mobile-native-audio.ios";
import { MobileAgentPanelSurface, MobileAgentPanelToggle } from "./mobile-agent-panels.shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Typography } from "heroui-native";
import { useQuery } from "@tanstack/react-query";
import { Bot } from "lucide-react-native";
import { ActivityIndicator, Keyboard, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { interpolate, useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import WebView from "react-native-webview";
import { LIGHTVELA_REGIONS, type LightVelaRegion } from "@opencraft/plugin-lightvela-hermes/account-contract";
import { nativeTokens } from "@opencraft/design-system/tokens.native";
import { MOBILE_BOT_BRIDGE_VERSION, botCommandScript, parseBotToHostMessage, type BotCommand, type HostPanelGesture, type HostPanelState, type BotSummary } from "@opencraft/mobile-bot-bridge";
import { projectAccountOverview, type AccountOverviewModel } from "@opencraft/mobile-account-sdk";
import { projectAccountDisplay, type AccountDisplaySnapshot } from "@opencraft/mobile-account-sdk/display-cache";

import { agentDomBootstrap } from "../runtime/agent-dom-bootstrap";
import { mobileAccount } from "../runtime/mobile-account-instance";
import { mobileAccountDisplayCache } from "../runtime/mobile-account-display-cache.native";
import { fetchMobileAccountProfile, mobileAccountQueryClient } from "../runtime/mobile-account-query.native";
import { mobileDeveloperLog } from "../runtime/mobile-developer-log.ios";
import { mobileLanguageCopy, siteLocaleForMobileLanguage, type MobileLanguage } from "../runtime/mobile-language";
import { mobileVisualTokens } from "../runtime/mobile-visual-tokens";
import { loadMobileBotRuntimeHtml } from "../runtime/mobile-bot-runtime-asset.ios";
import { classifyBotDocumentNavigation } from "../runtime/mobile-bot-document-policy";
import { MobileAgentNavigation, isAgentSection, type Section, type BotAvatarModel } from "./mobile-agent-navigation.shared";
import { InterruptibleMobileDrawer, type MobileDrawerHandle } from "./interruptible-mobile-drawer.ios";
import { MobileShellPanelButton } from "./mobile-shell-panel-button.shared";
import { useBotNavigationPresentation } from "./use-bot-navigation-presentation";

const styles = StyleSheet.create({
  host: { flex: 1, backgroundColor: nativeTokens.material.content },
  floatingScene: {
    flex: 1, backgroundColor: nativeTokens.material.content,
    shadowColor: nativeTokens.shadow.prominent.color,
    shadowOffset: { width: -8, height: nativeTokens.shadow.prominent.offsetY },
    shadowRadius: nativeTokens.shadow.prominent.radius,
  },
  floatingClip: { flex: 1, overflow: "hidden", backgroundColor: nativeTokens.material.content },
  toolbar: { height: 54, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, gap: 8, backgroundColor: mobileVisualTokens.color.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: mobileVisualTokens.color.separator },
  toolbarTitle: { color: mobileVisualTokens.color.text, flex: 1 },
  content: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
});

function FloatingDrawerScene({ progress, children }: { readonly progress?: SharedValue<number>; readonly children: React.ReactNode }) {
  const surfaceStyle = useAnimatedStyle(() => {
    const amount = progress?.value ?? 0;
    return {
      borderRadius: interpolate(amount, [0, 1], [0, mobileVisualTokens.drawer.floatingRadius]),
      shadowOpacity: interpolate(amount, [0, 1], [0, nativeTokens.shadow.prominent.opacity * 1.5]),
      elevation: interpolate(amount, [0, 1], [0, nativeTokens.shadow.prominent.elevation]),
      transform: [{ scale: interpolate(amount, [0, 1], [1, mobileVisualTokens.drawer.floatingScale]) }],
    };
  });
  const clipStyle = useAnimatedStyle(() => ({ borderRadius: interpolate(progress?.value ?? 0, [0, 1], [0, mobileVisualTokens.drawer.floatingRadius]) }));
  return <Animated.View style={[styles.floatingScene, surfaceStyle]}>
    <Animated.View style={[styles.floatingClip, clipStyle]}>{children}</Animated.View>
  </Animated.View>;
}

export function MobileBotHost({ region, language, token, credentialScope, active = true, onExternalNavigation, onSignOut, onOpenAccount }: {
  readonly region: LightVelaRegion;
  readonly language: MobileLanguage;
  readonly token: string;
  readonly credentialScope: string;
  readonly active?: boolean;
  readonly onExternalNavigation: (href: string) => void;
  readonly onSignOut: () => void;
  readonly onOpenAccount: () => void;
}) {
  const copy = mobileLanguageCopy(language);
  const insets = useSafeAreaInsets();
  const siteOrigin = LIGHTVELA_REGIONS[region].frontendBase;
  const [cachedAccountDisplay, setCachedAccountDisplay] = useState<AccountDisplaySnapshot | null>(() => {
    const cached = mobileAccountQueryClient.getQueryData<AccountOverviewModel>(["account", "overview", credentialScope]);
    return cached ? projectAccountDisplay(cached, region, Date.now()) : null;
  });
  const { data: accountProfile } = useQuery({
    queryKey: ["account", "profile", credentialScope],
    queryFn: async () => {
      try { return await fetchMobileAccountProfile(region, token); }
      catch (cause) {
        if ((cause as { status?: unknown }).status === 401
          && mobileAccount.getSnapshot().region === region
          && await mobileAccount.webSessionToken() === token) {
          await mobileAccount.signOut();
        }
        throw cause;
      }
    },
    staleTime: 30_000,
  });
  const accountIdentity = accountProfile
    ? projectAccountOverview(accountProfile, region, region === "cn") : cachedAccountDisplay;
  useEffect(() => {
    let active = true;
    void mobileAccountDisplayCache.read(region, token).then(display => {
      if (active && display) setCachedAccountDisplay(current => current ?? display);
    });
    return () => { active = false; };
  }, [region, token]);
  useEffect(() => {
    if (!accountProfile) return;
    const model = projectAccountOverview(accountProfile, region, region === "cn");
    setCachedAccountDisplay(projectAccountDisplay(model, region, Date.now()));
    void mobileAccountDisplayCache.write(region, token, model).catch(() => undefined);
  }, [accountProfile, region, token]);
  const [html, setHtml] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [failedSection, setFailedSection] = useState<Section | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [webViewGeneration, setWebViewGeneration] = useState(0);
  const [ready, setReady] = useState(false);
  const [bots, setBots] = useState<readonly BotSummary[]>([]);
  const catalogRef = useRef<readonly BotSummary[]>([]);
  const [botAvatars, setBotAvatars] = useState<Record<string, BotAvatarModel>>({});
  const [botsLoading, setBotsLoading] = useState(true);
  const [botsError, setBotsError] = useState(false);
  const [botsTimedOut, setBotsTimedOut] = useState(false);
  const [createVisible, setCreateVisible] = useState(false);
  const [createEnabled, setCreateEnabled] = useState(false);
  const [section, setSection] = useState<Section>("chat");
  const [panelState, setPanelState] = useState<HostPanelState | null>(null);
  const [panelPresentation, setPanelPresentation] = useState<{ ownerId: string; active: boolean } | null>(null);
  const [botId, setBotId] = useState("");
  const lifetimeId = useRef(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).current;
  const runtimeId = `${lifetimeId}:${webViewGeneration}`;
  const currentRuntimeId = useRef(runtimeId);
  currentRuntimeId.current = runtimeId;
  const navigation = useBotNavigationPresentation(`${runtimeId}:${credentialScope}:${language}`, botId, ready);
  const webView = useRef<WebView>(null);
  const nativeAudio = useMemo(() => new MobileNativeAudio(event => {
    if (currentRuntimeId.current === runtimeId) webView.current?.injectJavaScript(botCommandScript(runtimeId, event));
  }), [runtimeId]);
  useEffect(() => {
    const listener = AppState.addEventListener("change", state => { if (state === "background") nativeAudio.cancel(); });
    return () => { listener.remove(); nativeAudio.cancel(); };
  }, [nativeAudio]);
  useEffect(() => { if (!active || section !== "chat") nativeAudio.cancel(); }, [active, section, nativeAudio]);
  const initialDocumentPending = useRef(true);
  const processRecoveryAt = useRef<number[]>([]);
  const capabilities = useRef<ReadonlySet<BotCommand["type"]>>(new Set());
  const drawer = useRef<MobileDrawerHandle>(null);
  const webGesture = useMemo(() => Gesture.Native(), []);
  const selection = useRef({ section, botId });
  selection.current = { section, botId };

  const sendCommand = useCallback((command: BotCommand) => {
    if (!capabilities.current.has(command.type)) return;
    webView.current?.injectJavaScript(botCommandScript(runtimeId, command));
  }, [runtimeId]);
  const selectedBot = bots.find(bot => bot.id === botId);

  const panelSwipeState = useRef({ state: panelState, enabled: ready && active && section === "chat" });
  panelSwipeState.current = { state: panelState, enabled: ready && active && section === "chat" };
  const pendingPanelMove = useRef<{ ownerId: string; gesture: HostPanelGesture } | null>(null);
  const panelMoveFrame = useRef<number | null>(null);
  useEffect(() => () => {
    if (panelMoveFrame.current !== null) cancelAnimationFrame(panelMoveFrame.current);
    panelMoveFrame.current = null; pendingPanelMove.current = null;
  }, [runtimeId]);
  const sendPanelGesture = useCallback((ownerId: string, gesture: HostPanelGesture) => {
    const current = panelSwipeState.current;
    if (!current.enabled || !current.state?.available || current.state.ownerId !== ownerId) return;
    sendCommand({ type: "chat-panel-gesture", ownerId, gesture });
  }, [sendCommand]);
  const changePanelFromSwipe = useCallback((ownerId: string, gesture: HostPanelGesture) => {
    // Coalesce move samples; terminal events contain the complete translation
    // and cancel the queued sample so it cannot arrive after release/cancel.
    if (gesture.phase === "move") {
      pendingPanelMove.current = { ownerId, gesture };
      if (panelMoveFrame.current === null) panelMoveFrame.current = requestAnimationFrame(() => {
        panelMoveFrame.current = null;
        const sample = pendingPanelMove.current; pendingPanelMove.current = null;
        if (sample) sendPanelGesture(sample.ownerId, sample.gesture);
      });
      return;
    }
    if (panelMoveFrame.current !== null) cancelAnimationFrame(panelMoveFrame.current);
    panelMoveFrame.current = null; pendingPanelMove.current = null;
    sendPanelGesture(ownerId, gesture);
  }, [sendPanelGesture]);

  useEffect(() => { if (ready) sendCommand({ type: "visibility", active }); }, [ready, active, sendCommand]);

  const reloadBundledDocument = useCallback(() => {
    drawer.current?.setContentTouchOwned(false);
    initialDocumentPending.current = true;
    setReady(false);
    setPanelState(null);
    setPanelPresentation(null);
    capabilities.current = new Set();
    setWebViewGeneration(generation => generation + 1);
  }, []);

  useEffect(() => {
    let live = true;
    setHtml(null);
    setLoadFailed(false);
    setReady(false);
    const load = async () => {
      try {
        const next = await loadMobileBotRuntimeHtml();
        if (live) setHtml(next);
        mobileDeveloperLog.log("bot.runtime.asset.loaded", { bytes: next.length });
      } catch {
        if (live) setLoadFailed(true);
        mobileDeveloperLog.log("bot.runtime.asset.failed");
      }
    };
    void load();
    return () => { live = false; };
  }, [loadAttempt]);

  useEffect(() => {
    if (!html || ready || loadFailed) return;
    const timer = setTimeout(() => { setLoadFailed(true); mobileDeveloperLog.log("bot.runtime.timeout"); }, 20000);
    return () => clearTimeout(timer);
  }, [html, ready, loadFailed]);

  useEffect(() => {
    if (!ready || !botsLoading || bots.length > 0) return;
    const timer = setTimeout(() => { setBotsTimedOut(true); mobileDeveloperLog.log("bot.catalog.timeout"); }, 20000);
    return () => clearTimeout(timer);
  }, [ready, botsLoading, bots.length]);

  const select = useCallback((nextSection: Section, nextBotId: string, keepNavigation = false) => {
    if (failedSection === nextSection) {
      reloadBundledDocument();
    }
    setFailedSection(null);
    Keyboard.dismiss();
    if (nextBotId !== selection.current.botId) setPanelState(null);
    navigation.select(nextBotId);
    setSection(nextSection);
    setBotId(nextBotId);
    selection.current = { section: nextSection, botId: nextBotId };
    if (!keepNavigation) drawer.current?.dismissDrawer();
    sendCommand({ type: "select", section: nextSection, botId: nextBotId });
  }, [failedSection, reloadBundledDocument, sendCommand, navigation.select]);

  const retryBots = useCallback(() => {
    setBotsError(false);
    setBotsTimedOut(false);
    setBotsLoading(true);
    sendCommand({ type: "refresh" });
  }, [sendCommand]);

  const onMessage = useCallback((raw: string) => {
    if (runtimeId !== currentRuntimeId.current) return;
    const message = parseBotToHostMessage(raw, runtimeId);
    if (!message) return;
    if (message.type === "native-audio-request") {
      if (message.action !== "start" || (active && ready && selection.current.section === "chat")) nativeAudio.handle(message);
      return;
    }
    if (message.type === "bot-runtime-ready") {
      capabilities.current = new Set(message.capabilities);
      setReady(true);
      mobileDeveloperLog.log(message.originMatches === true ? "bot.runtime.origin.matched" : "bot.runtime.origin.missing");
      const current = selection.current;
      sendCommand({ type: "select", ...current });
    }
    if (message.type === "chat-panel-state" && catalogRef.current.some(bot => bot.id === selection.current.botId
      && bot.instanceId === message.instanceId && bot.profileId === message.profileId)) setPanelState(message.state);
    if (message.type === "chat-panel-action-failed") mobileDeveloperLog.log("chat.panel.action.failed");
    if (message.type === "bot-auth-state") {
      mobileDeveloperLog.log(message.ready !== true ? "bot.auth.pending" : message.authenticated === true ? "bot.auth.ready" : "bot.auth.missing");
    }
    if (message.type === "bot-catalog") {
      const next = message.bots.slice(0, 100);
      catalogRef.current = next;
      if (!message.loading && !message.error) navigation.prune(next.map(bot => bot.id));
      setBots(next);
      setBotsLoading(message.loading === true);
      setBotsError(message.error === true && message.loading !== true);
      if (message.loading !== true || next.length > 0) setBotsTimedOut(false);
      mobileDeveloperLog.log("bot.catalog.updated", { visibleChars: next.length });
      if (next.length && !next.some(bot => bot.id === selection.current.botId)) select(selection.current.section, next[0]!.id);
      if (!next.length && !message.loading && !message.error && selection.current.botId) select(selection.current.section, "");
    }
    if (message.type === "bot-avatar") {
      setBotAvatars(current => ({ ...current, [message.botId]: { configured: message.configured, shapeId: message.shapeId, color: message.color } }));
    }
    if (message.type === "chat-panel-presentation") setPanelPresentation({ ownerId: message.ownerId, active: message.active });
    if (message.type === "bot-touch-ownership") drawer.current?.setContentTouchOwned(message.owned);
    if (message.type === "bot-selection" && isAgentSection(message.section as Section)) {
      if (message.section !== failedSection) setFailedSection(null);
      if (message.botId !== selection.current.botId) setPanelState(null);
      navigation.select(message.botId);
      selection.current = { section: message.section as Section, botId: message.botId };
      setSection(message.section as Section);
      setBotId(message.botId);
    }
    if (message.type === "bot-console-state" && catalogRef.current.some(bot => bot.id === message.botId)) {
      navigation.receive(message, selection.current.botId);
      if (message.error && message.botId === selection.current.botId) mobileDeveloperLog.log("bot.session.operation.failed");
    }
    if (message.type === "bot-create-state") {
      setCreateVisible(message.visible === true);
      setCreateEnabled(message.enabled === true);
    }
    if (message.type === "external-navigation") onExternalNavigation(message.href);
    if (message.type === "signed-out") onSignOut();
    if (message.type === "bot-runtime-script-failed") {
      if (!ready) setLoadFailed(true);
      mobileDeveloperLog.log("bot.runtime.script.failed", {
        kind: message.kind, line: message.line, column: message.column,
      });
    }
    if (message.type === "bot-section-render-failed") {
      const failed = message.section && isAgentSection(message.section as Section)
        ? message.section as Section : selection.current.section;
      setFailedSection(failed);
      mobileDeveloperLog.log("bot.section.render.failed");
    }
    if (message.type === "bot-api-network-failed") mobileDeveloperLog.log("bot.api.network.failed");
    if (message.type === "bot-api-http-failed") {
      mobileDeveloperLog.log("bot.api.http.failed", { status: message.status, endpoint: message.endpoint });
    }
    if (message.type === "bot-model-load-failed") {
      mobileDeveloperLog.log("bot.model.load.failed", { kind: message.kind });
    }
  }, [active, nativeAudio, failedSection, onExternalNavigation, onSignOut, ready, runtimeId, select, sendCommand, navigation.select, navigation.receive, navigation.prune]);

  const onRequest = useCallback((url: string, isTopFrame: boolean) => {
    const decision = classifyBotDocumentNavigation(url, siteOrigin, initialDocumentPending.current, isTopFrame);
    if (decision === "initial-document") {
      initialDocumentPending.current = false;
      return true;
    }
    if (decision === "bot-route") sendCommand({ type: "link", href: url });
    if (decision === "external") onExternalNavigation(url);
    if (decision === "blocked") mobileDeveloperLog.log("bot.runtime.navigation.blocked");
    return false;
  }, [onExternalNavigation, sendCommand, siteOrigin]);

  const locale = siteLocaleForMobileLanguage(language, region);
  const bootstrap = agentDomBootstrap({ runtimeId, region: region === "cn" ? "cn" : "global", apiBase: LIGHTVELA_REGIONS[region].apiBase, siteOrigin, token, locale, nativeAudio: true });
  const title = selectedBot?.name || copy.agents;
  const retryRuntime = () => {
    processRecoveryAt.current = [];
    setLoadFailed(false);
    setFailedSection(null);
    setReady(false);
    if (html) reloadBundledDocument();
    else setLoadAttempt(attempt => attempt + 1);
  };

  return <InterruptibleMobileDrawer
    ref={drawer}
    webGesture={webGesture}
    panelSwipe={{ available: ready && active && section === "chat" && panelState?.available === true,
      open: panelState?.open === true || (panelPresentation?.ownerId === panelState?.ownerId && panelPresentation?.active === true), ownerId: panelState?.ownerId ?? "", onGesture: changePanelFromSwipe }}
    renderNavigationView={() => <View style={[{ flex: 1, backgroundColor: mobileVisualTokens.color.sidebar }, { paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left }]}>
      <MobileAgentNavigation language={language} bots={bots} botId={botId} section={section}
        botAvatars={botAvatars} ready={ready} botsLoading={botsLoading} botsError={botsError} botsTimedOut={botsTimedOut}
        createVisible={createVisible} createEnabled={createEnabled} navigation={navigation}
        accountIdentity={accountIdentity ?? null} select={select} sendCommand={sendCommand} retryBots={retryBots}
        onDismiss={() => drawer.current?.dismissDrawer()} onOpenAccount={onOpenAccount} />
    </View>}
  >
  {(progress, { docked, navigationOpen }) => <FloatingDrawerScene progress={progress}><View style={[styles.host, { paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: docked ? 0 : insets.left, paddingRight: insets.right }]}>
    <View style={styles.toolbar}>
      <MobileShellPanelButton side="left" open={navigationOpen} onPress={() => drawer.current?.toggleNavigation()}
        label={navigationOpen ? language === "zh-CN" ? "收起侧栏" : "Hide sidebar" : language === "zh-CN" ? "打开智能体菜单" : "Open agent menu"} />
      <Typography.Heading type="h4" numberOfLines={1} style={styles.toolbarTitle}>{title}</Typography.Heading>
      <MobileAgentPanelToggle state={panelState} enabled={ready && active && section === "chat"} zh={language === "zh-CN"} send={sendCommand} />
    </View>
    <MobileAgentPanelSurface state={panelState} enabled={ready && active && section === "chat"} zh={language === "zh-CN"} send={sendCommand}>
      <View style={{ flex: 1, minHeight: 0 }}>
      {html ? <View style={StyleSheet.absoluteFill}>
        <GestureDetector gesture={webGesture}><WebView
        ref={webView}
        key={`${region}:${webViewGeneration}`}
        source={{ html, baseUrl: siteOrigin }}
        style={{ flex: 1, backgroundColor: mobileVisualTokens.color.contentCanvas }}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        originWhitelist={["*"]}
        setSupportMultipleWindows={false}
        javaScriptEnabled
        mediaCapturePermissionGrantType="deny"
        domStorageEnabled
        cacheEnabled
        injectedJavaScriptBeforeContentLoaded={bootstrap}
        onLoadStart={() => { initialDocumentPending.current = false; setReady(false); capabilities.current = new Set(); }}
        onMessage={({ nativeEvent }) => onMessage(nativeEvent.data)}
        onShouldStartLoadWithRequest={({ url, isTopFrame }) => onRequest(url, isTopFrame !== false)}
        onError={() => { setReady(false); setLoadFailed(true); mobileDeveloperLog.log("bot.runtime.load.failed"); }}
        onContentProcessDidTerminate={() => {
          setReady(false);
          mobileDeveloperLog.log("bot.runtime.process.terminated");
          const now = Date.now();
          processRecoveryAt.current = processRecoveryAt.current.filter(at => now - at < 60_000);
          if (processRecoveryAt.current.length < 2) {
            processRecoveryAt.current.push(now);
            reloadBundledDocument();
          } else setLoadFailed(true);
        }}
        onHttpError={({ nativeEvent }) => mobileDeveloperLog.log("bot.runtime.http.failed", { status: nativeEvent.statusCode })}
      /></GestureDetector></View> : null}
      {!ready && !loadFailed ? <View style={[styles.center, StyleSheet.absoluteFill]} pointerEvents="none"><ActivityIndicator color={mobileVisualTokens.color.accentBright} /></View> : null}
      {(loadFailed || failedSection === section) ? <View style={[styles.center, StyleSheet.absoluteFill]}>
        <Card variant="secondary"><Card.Body><Card.Title>{copy.siteOpenError}</Card.Title></Card.Body><Card.Footer>
          <Button onPress={retryRuntime}>{copy.siteRetry}</Button>
        </Card.Footer></Card>
      </View> : null}
      {ready && (botsError || botsTimedOut) && bots.length === 0 ? <View style={[styles.center, StyleSheet.absoluteFill]}>
        <Card variant="secondary"><Card.Body><Card.Title>{copy.siteOpenError}</Card.Title></Card.Body><Card.Footer>
          <Button onPress={retryBots}>{copy.siteRetry}</Button>
        </Card.Footer></Card>
      </View> : null}
      </View>
    </MobileAgentPanelSurface>
  </View></FloatingDrawerScene>}
  </InterruptibleMobileDrawer>;
}
