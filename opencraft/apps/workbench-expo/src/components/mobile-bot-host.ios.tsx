import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image as CachedImage } from "expo-image";
import { Button, Card, Typography } from "heroui-native";
import { useQuery } from "@tanstack/react-query";
import { Activity, Bot, Brain, ChevronRight, CircleUserRound, Clock3, Cloud, Database, Files, FlaskConical, Globe, LayoutDashboard, Menu, MessageCircle, Monitor, Plug, Plus, Radio, Settings2, SlidersHorizontal, Sparkles, Trash2, Trophy, UserRound, X, type LucideIcon } from "lucide-react-native";
import { ActivityIndicator, Keyboard, Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { interpolate, useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import WebView from "react-native-webview";
import Svg, { Path, Rect } from "react-native-svg";
import { LIGHTVELA_REGIONS, type LightVelaRegion } from "@opencraft/plugin-lightvela-hermes/account-contract";
import { nativeTokens } from "@opencraft/design-system/tokens.native";
import { MOBILE_BOT_BRIDGE_VERSION, botCommandScript, parseBotToHostMessage, type BotCommand, type BotSummary } from "@opencraft/mobile-bot-bridge";
import { AVATAR_SHAPES } from "@opencraft/mobile-bot-bridge/avatar-shapes";
import { projectAccountOverview, type AccountOverviewModel } from "@opencraft/mobile-account-sdk";
import { projectAccountDisplay, type AccountDisplaySnapshot } from "@opencraft/mobile-account-sdk/display-cache";

import { mobileAccount } from "../runtime/mobile-account-instance";
import { mobileAccountDisplayCache } from "../runtime/mobile-account-display-cache.native";
import { fetchMobileAccountProfile, mobileAccountQueryClient } from "../runtime/mobile-account-query.native";
import { mobileDeveloperLog } from "../runtime/mobile-developer-log.ios";
import { mobileLanguageCopy, siteLocaleForMobileLanguage, type MobileLanguage } from "../runtime/mobile-language";
import { mobileVisualTokens } from "../runtime/mobile-visual-tokens";
import { loadMobileBotRuntimeHtml } from "../runtime/mobile-bot-runtime-asset.ios";
import { classifyBotDocumentNavigation } from "../runtime/mobile-bot-document-policy";
import { MobileOpenCraftChat } from "./mobile-opencraft-chat.ios";
import { InterruptibleMobileDrawer, type MobileDrawerHandle } from "./interruptible-mobile-drawer.ios";

type Section = "overview" | "channel" | "connectors" | "model" | "skill" | "buddy" | "automations" | "diagnostics" | "settings" | "memory" | "achievement" | "chat" | "files" | "browser" | "terminal" | "deepseek-harness" | "cloud-desktop" | "website" | "workbench";
type BotItem = BotSummary;
type BotAvatarModel = { configured: boolean; shapeId: string; color: string };

const sections: readonly { id: Section; zh: string; en: string; icon: LucideIcon }[] = [
  { id: "overview", zh: "总览", en: "Overview", icon: LayoutDashboard },
  { id: "chat", zh: "对话", en: "Chat", icon: MessageCircle },
  { id: "channel", zh: "通道", en: "Channels", icon: Radio },
  { id: "connectors", zh: "连接", en: "Connectors", icon: Plug },
  { id: "model", zh: "模型", en: "Models", icon: Brain },
  { id: "skill", zh: "技能", en: "Skills", icon: Sparkles },
  { id: "buddy", zh: "人设", en: "Persona", icon: UserRound },
  { id: "automations", zh: "定时任务", en: "Automations", icon: Clock3 },
  { id: "memory", zh: "记忆", en: "Memory", icon: Database },
  { id: "files", zh: "文件", en: "Files", icon: Files },
  { id: "browser", zh: "浏览器", en: "Browser", icon: Globe },
  { id: "terminal", zh: "终端", en: "Terminal", icon: Monitor },
  { id: "achievement", zh: "成就", en: "Achievements", icon: Trophy },
  { id: "diagnostics", zh: "诊断中心", en: "Diagnostics", icon: Activity },
  { id: "settings", zh: "高级设置", en: "Advanced settings", icon: Settings2 },
  { id: "website", zh: "我的工作台", en: "My workspaces", icon: Globe },
  { id: "deepseek-harness", zh: "DeepSeek Harness", en: "DeepSeek Harness", icon: FlaskConical },
  { id: "cloud-desktop", zh: "云桌面", en: "Cloud desktop", icon: Cloud },
  { id: "workbench", zh: "工作台", en: "Workbench", icon: SlidersHorizontal },
];
const sectionIds = new Set<Section>(sections.map(section => section.id));
const hiddenDrawerSections: ReadonlySet<Section> = new Set(["browser", "terminal", "workbench"]);
const drawerSections = sections.filter(section => !hiddenDrawerSections.has(section.id));
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
  menuButton: { width: 42, height: 42, minWidth: 42, borderRadius: 14, backgroundColor: mobileVisualTokens.color.accentSoft },
  toolbarTitle: { color: mobileVisualTokens.color.text, flex: 1 },
  content: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  drawer: { flex: 1, backgroundColor: mobileVisualTokens.color.sidebar },
  drawerScroll: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 28 },
  groupLabel: { color: mobileVisualTokens.color.label, marginHorizontal: 12, marginTop: 20, marginBottom: 10, fontWeight: "600" },
  botGroupLabel: { color: mobileVisualTokens.color.label, marginHorizontal: 12, fontWeight: "600" },
  groupHeading: { minHeight: 48, flexDirection: "row", alignItems: "center", paddingRight: 4 },
  groupCount: { color: mobileVisualTokens.color.label, fontSize: 12, fontWeight: "600" },
  drawerClose: { width: 34, height: 34, minWidth: 34, borderRadius: 11, marginLeft: 7, backgroundColor: "transparent" },
  row: { width: "100%", minHeight: 48, justifyContent: "flex-start", borderRadius: 14, paddingHorizontal: 14, backgroundColor: "transparent" },
  botRow: { minHeight: 68, marginHorizontal: 4, marginBottom: 6, flexDirection: "row", alignItems: "center", borderRadius: 18, borderWidth: 1, borderColor: "transparent" },
  botSelectedRow: { backgroundColor: mobileVisualTokens.color.selected, borderColor: mobileVisualTokens.color.separator },
  botSelect: { flex: 1, minWidth: 0, minHeight: 66, justifyContent: "flex-start", paddingHorizontal: 9, backgroundColor: "transparent" },
  botSelectContent: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 9 },
  botAvatar: { width: 39, height: 39, borderRadius: 13, overflow: "hidden", alignItems: "center", justifyContent: "center", backgroundColor: mobileVisualTokens.color.accentSoft },
  botAvatarImage: { width: 39, height: 39, borderRadius: 13 },
  botName: { color: mobileVisualTokens.color.rowText, fontSize: 14, fontWeight: "600" },
  botStatusLine: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 },
  botStatusDot: { width: 6, height: 6, borderRadius: 3 },
  botStatusText: { color: mobileVisualTokens.color.label, fontSize: 11 },
  botDelete: { width: 35, minWidth: 35, height: 38, borderRadius: 12, marginRight: 5, backgroundColor: "transparent" },
  createButton: { marginHorizontal: 4, marginTop: 3, marginBottom: 5, minHeight: 66, borderRadius: 18, justifyContent: "flex-start", paddingHorizontal: 10, backgroundColor: mobileVisualTokens.color.accentSoft, borderWidth: 1, borderColor: mobileVisualTokens.color.separator },
  createIcon: { width: 39, height: 39, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: mobileVisualTokens.color.surface },
  createTitle: { color: mobileVisualTokens.color.accent, fontSize: 14, fontWeight: "700" },
  createSubtitle: { color: mobileVisualTokens.color.label, fontSize: 11, marginTop: 2 },
  selectedRow: { backgroundColor: mobileVisualTokens.color.selected },
  rowText: { color: mobileVisualTokens.color.rowText, fontSize: 15 },
  selectedText: { color: mobileVisualTokens.color.accent, fontWeight: "700" },
  accountFooter: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: mobileVisualTokens.color.separator, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8 },
  accountButton: { minHeight: 58, width: "100%", justifyContent: "flex-start", borderRadius: 16, backgroundColor: "transparent", paddingHorizontal: 12 },
  accountSubtitle: { color: mobileVisualTokens.color.label, marginTop: 2 },
  accountAvatar: { width: 38, height: 38, borderRadius: 13 },
  accountAvatarFallback: { width: 38, height: 38, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: mobileVisualTokens.color.accentSoft },
  accountAvatarLetter: { color: mobileVisualTokens.color.accent, fontSize: 17, fontWeight: "700" },
});

function DrawerAccountAvatar({ url, name }: { readonly url: string | null; readonly name: string | null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return url && !failed
    ? <CachedImage source={{ uri: url }} cachePolicy="memory-disk" style={styles.accountAvatar} onError={() => setFailed(true)} />
    : <View style={styles.accountAvatarFallback}>
      {name ? <Text style={styles.accountAvatarLetter}>{Array.from(name)[0]?.toUpperCase()}</Text>
        : <CircleUserRound size={23} color={mobileVisualTokens.color.accent} />}
    </View>;
}

function DrawerBotAvatar({ model, fallbackUrl }: { readonly model?: BotAvatarModel; readonly fallbackUrl: string }) {
  const shape = AVATAR_SHAPES.find(item => item.id === model?.shapeId);
  if (!model?.configured || !shape) return <View style={styles.botAvatar}>
    <CachedImage source={{ uri: fallbackUrl }} cachePolicy="memory-disk" style={styles.botAvatarImage} contentFit="contain" />
  </View>;
  const leftEyeX = 50 - shape.eyeDx - 3;
  const rightEyeX = 50 + shape.eyeDx - 3;
  return <View style={styles.botAvatar}><Svg width={39} height={39} viewBox="0 0 100 100">
    <Path d={shape.path} fill={model.color} />
    <Rect x={leftEyeX} y={shape.eyeY - 6} width={6} height={12} rx={3} fill="#fff" />
    <Rect x={rightEyeX} y={shape.eyeY - 6} width={6} height={12} rx={3} fill="#fff" />
  </Svg></View>;
}

function botStatus(status: string, language: MobileLanguage): { label: string; color: string } {
  const zh = language === "zh-CN";
  switch (status) {
    case "running": return { label: zh ? "运行中" : "Running", color: mobileVisualTokens.color.statusRunning };
    case "paused": return { label: zh ? "已暂停" : "Paused", color: mobileVisualTokens.color.statusPending };
    case "provisioning": return { label: zh ? "创建中" : "Creating", color: mobileVisualTokens.color.statusPending };
    case "deleting": return { label: zh ? "删除中" : "Deleting", color: mobileVisualTokens.color.iconSoft };
    case "failed": return { label: zh ? "需要处理" : "Needs attention", color: mobileVisualTokens.color.statusFailed };
    default: return { label: zh ? "草稿" : "Draft", color: mobileVisualTokens.color.iconSoft };
  }
}

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
  const [bots, setBots] = useState<readonly BotItem[]>([]);
  const [botAvatars, setBotAvatars] = useState<Record<string, BotAvatarModel>>({});
  const [botsLoading, setBotsLoading] = useState(true);
  const [botsError, setBotsError] = useState(false);
  const [botsTimedOut, setBotsTimedOut] = useState(false);
  const [createVisible, setCreateVisible] = useState(false);
  const [createEnabled, setCreateEnabled] = useState(false);
  const [section, setSection] = useState<Section>("overview");
  const [chatMounted, setChatMounted] = useState(false);
  const [botId, setBotId] = useState("");
  const runtimeId = useRef(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).current;
  const webView = useRef<WebView>(null);
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

  const reloadBundledDocument = useCallback(() => {
    initialDocumentPending.current = true;
    setReady(false);
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

  const select = useCallback((nextSection: Section, nextBotId: string) => {
    if (failedSection === nextSection && nextSection !== "chat") {
      reloadBundledDocument();
    }
    if (nextSection !== "chat") setFailedSection(null);
    if (nextSection === "chat") setChatMounted(true);
    else Keyboard.dismiss();
    setSection(nextSection);
    setBotId(nextBotId);
    drawer.current?.dismissDrawer();
    if (nextSection !== "chat") sendCommand({ type: "select", section: nextSection, botId: nextBotId });
  }, [failedSection, reloadBundledDocument, sendCommand]);

  const retryBots = useCallback(() => {
    setBotsError(false);
    setBotsTimedOut(false);
    setBotsLoading(true);
    sendCommand({ type: "refresh" });
  }, [sendCommand]);

  const onMessage = useCallback((raw: string) => {
    const message = parseBotToHostMessage(raw, runtimeId);
    if (!message) return;
    if (message.type === "bot-runtime-ready") {
      capabilities.current = new Set(message.capabilities);
      setReady(true);
      mobileDeveloperLog.log(message.originMatches === true ? "bot.runtime.origin.matched" : "bot.runtime.origin.missing");
      const current = selection.current;
      if (current.section !== "chat") sendCommand({ type: "select", ...current });
    }
    if (message.type === "bot-auth-state") {
      mobileDeveloperLog.log(message.ready !== true ? "bot.auth.pending" : message.authenticated === true ? "bot.auth.ready" : "bot.auth.missing");
    }
    if (message.type === "bot-catalog") {
      const next = message.bots.slice(0, 100);
      setBots(next);
      setBotsLoading(message.loading === true);
      setBotsError(message.error === true && message.loading !== true);
      if (message.loading !== true || next.length > 0) setBotsTimedOut(false);
      mobileDeveloperLog.log("bot.catalog.updated", { visibleChars: next.length });
      if (next.length && !next.some(bot => bot.id === selection.current.botId)) select(selection.current.section, next[0]!.id);
      if (!next.length && message.loading !== true && selection.current.botId) select(selection.current.section, "");
    }
    if (message.type === "bot-avatar") {
      setBotAvatars(current => ({ ...current, [message.botId]: { configured: message.configured, shapeId: message.shapeId, color: message.color } }));
    }
    if (message.type === "bot-selection" && sectionIds.has(message.section as Section)) {
      if (message.section === "chat") setChatMounted(true);
      if (message.section !== "chat" && message.section !== failedSection) setFailedSection(null);
      setSection(message.section as Section);
      setBotId(message.botId);
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
      const failed = message.section && sectionIds.has(message.section as Section)
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
  }, [failedSection, onExternalNavigation, onSignOut, ready, runtimeId, select, sendCommand]);

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
  const bootstrap = `(() => {
    window.__LIGHTVELA_BOT_RUNTIME_ID__ = ${JSON.stringify(runtimeId)};
    window.__LIGHTVELA_BOT_POST__ = payload => window.ReactNativeWebView?.postMessage(JSON.stringify({ protocol: ${MOBILE_BOT_BRIDGE_VERSION}, runtimeId: ${JSON.stringify(runtimeId)}, payload }));
    window.__LIGHTVELA_EMBEDDED_REGION__ = ${JSON.stringify(region === "cn" ? "cn" : "global")};
    window.__LIGHTVELA_EMBEDDED_API_BASE__ = ${JSON.stringify(LIGHTVELA_REGIONS[region].apiBase)};
    window.__LIGHTVELA_EMBEDDED_SITE_BASE__ = ${JSON.stringify(siteOrigin)};
    window.__LIGHTVELA_EMBEDDED_TOKEN__ = ${JSON.stringify(token)};
    const apiBase = ${JSON.stringify(LIGHTVELA_REGIONS[region].apiBase)};
    const originalFetch = window.fetch.bind(window);
    const endpointKind = url => {
      try {
        const path = new URL(url).pathname;
        if (path.endsWith('/debug/exec')) return 1;
        if (path.startsWith('/v1/instances/')) return 2;
        if (path.includes('/subscription') || path.includes('/passes') || path.includes('/plans')) return 3;
        if (path.startsWith('/auth/')) return 4;
      } catch {}
      return 0;
    };
    window.fetch = (input, init) => {
      const requestUrl = typeof input === 'string' ? input : input?.url;
      const isApi = typeof requestUrl === 'string' && requestUrl.startsWith(apiBase + '/');
      return originalFetch(input, init).then(response => {
        if (isApi && !response.ok) window.__LIGHTVELA_BOT_POST__({ type: 'bot-api-http-failed', status: response.status, endpoint: endpointKind(requestUrl) });
        return response;
      }, error => {
        if (isApi) window.__LIGHTVELA_BOT_POST__({ type: 'bot-api-network-failed' });
        throw error;
      });
    };
    let reportedRuntimeFailure = false;
    const reportRuntimeFailure = event => {
      if (reportedRuntimeFailure) return;
      reportedRuntimeFailure = true;
      const name = event?.error?.name ?? event?.reason?.name;
      const kind = name === 'ReferenceError' ? 1 : name === 'TypeError' ? 2 : name === 'SyntaxError' ? 3 : name === 'RangeError' ? 4 : 0;
      window.__LIGHTVELA_BOT_POST__({
        type: 'bot-runtime-script-failed', kind,
        line: Number.isSafeInteger(event?.lineno) ? event.lineno : 0,
        column: Number.isSafeInteger(event?.colno) ? event.colno : 0,
      });
    };
    window.addEventListener('error', reportRuntimeFailure);
    window.addEventListener('unhandledrejection', reportRuntimeFailure);
    try { localStorage.setItem('lightclaw-auth-token-v1', ${JSON.stringify(token)}); localStorage.setItem('lw-locale', ${JSON.stringify(locale)}); localStorage.setItem('lw-locale-explicit', '1'); } catch {}
  })(); true;`;
  const selectedBot = bots.find(bot => bot.id === botId);
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
    renderNavigationView={() => <View style={[styles.drawer, { paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left }]}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.drawerScroll}>
        <View style={styles.groupHeading}>
          <Typography type="body-xs" style={[styles.botGroupLabel, { flex: 1 }]}>{copy.agents}</Typography>
          {bots.length > 0 ? <Text style={styles.groupCount}>{bots.length}</Text> : null}
          <Button variant="ghost" style={styles.drawerClose} onPress={() => drawer.current?.closeDrawer()} accessibilityLabel={copy.close}>
            <X size={19} color={mobileVisualTokens.color.iconClose} />
          </Button>
        </View>
        {createVisible ? <Button variant="secondary" style={styles.createButton} isDisabled={!ready || !createEnabled} onPress={() => {
          drawer.current?.dismissDrawer();
          sendCommand({ type: "create" });
        }} accessibilityLabel={language === "zh-CN" ? "新建智能体" : "Create bot"}>
          <View style={styles.botSelectContent}>
            <View style={styles.createIcon}><Plus size={22} color={mobileVisualTokens.color.accent} /></View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Button.Label style={styles.createTitle}>{language === "zh-CN" ? "新建智能体" : "Create bot"}</Button.Label>
              <Text style={styles.createSubtitle}>{language === "zh-CN" ? "开始一段新协作" : "Start something new"}</Text>
            </View>
            <ChevronRight size={16} color={mobileVisualTokens.color.accent} />
          </View>
        </Button> : null}
        {botsLoading && !botsTimedOut && !botsError ? <ActivityIndicator style={{ margin: 16 }} color={mobileVisualTokens.color.accentBright} /> : null}
        {(botsTimedOut || botsError) && bots.length === 0 ? <Button variant="ghost" style={styles.row} onPress={retryBots}><Button.Label style={styles.selectedText}>{copy.siteRetry}</Button.Label></Button> : null}
        {bots.map(bot => <View key={bot.id} style={[styles.botRow, botId === bot.id && styles.botSelectedRow]}>
          <Button variant="ghost" style={styles.botSelect} onPress={() => select(section, bot.id)}>
            <View style={styles.botSelectContent}>
              <DrawerBotAvatar model={botAvatars[bot.id]} fallbackUrl={`${siteOrigin}/hermes_logo.png`} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Button.Label numberOfLines={1} style={[styles.botName, botId === bot.id && styles.selectedText]}>{bot.name}</Button.Label>
                <View style={styles.botStatusLine}>
                  <View style={[styles.botStatusDot, { backgroundColor: botStatus(bot.status, language).color }]} />
                  <Text numberOfLines={1} style={styles.botStatusText}>{botStatus(bot.status, language).label}</Text>
                </View>
              </View>
            </View>
          </Button>
          <Button variant="ghost" style={styles.botDelete} isDisabled={!ready || bot.status === "provisioning" || bot.status === "deleting"} accessibilityLabel={language === "zh-CN" ? `删除 ${bot.name}` : `Delete ${bot.name}`} onPress={() => {
            drawer.current?.dismissDrawer();
            sendCommand({ type: "delete", botId: bot.id });
          }}>
            <Trash2 size={17} color={mobileVisualTokens.color.destructiveIcon} />
          </Button>
        </View>)}
        <Typography type="body-xs" style={styles.groupLabel}>{language === "zh-CN" ? "功能" : "Features"}</Typography>
        {drawerSections.map(item => <Button key={item.id} variant="ghost" style={[styles.row, section === item.id && styles.selectedRow]} onPress={() => select(item.id, botId)}>
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 11 }}>
            <item.icon size={19} color={section === item.id ? mobileVisualTokens.color.accent : mobileVisualTokens.color.icon} />
            <Button.Label numberOfLines={1} style={[styles.rowText, section === item.id && styles.selectedText, { flex: 1 }]}>{language === "zh-CN" ? item.zh : item.en}</Button.Label>
            <ChevronRight size={17} color={section === item.id ? mobileVisualTokens.color.accent : mobileVisualTokens.color.iconSoft} />
          </View>
        </Button>)}
      </ScrollView>
      <View style={styles.accountFooter}>
        <Button variant="ghost" style={styles.accountButton} accessibilityLabel={accountIdentity?.displayName ? `${accountIdentity.displayName}，${language === "zh-CN" ? "个人与设置" : "Account and settings"}` : language === "zh-CN" ? "个人与设置" : "Account and settings"} onPress={onOpenAccount}>
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 11 }}>
            <DrawerAccountAvatar url={accountIdentity?.avatarUrl ?? null} name={accountIdentity?.displayName ?? null} />
            <View style={{ flex: 1 }}>
              <Button.Label numberOfLines={1} style={styles.rowText}>{accountIdentity?.displayName ?? (language === "zh-CN" ? "我的账号" : "My account")}</Button.Label>
              <Typography type="body-xs" style={styles.accountSubtitle}>{language === "zh-CN" ? "个人与设置" : "Account and settings"}</Typography>
            </View>
            <Settings2 size={18} color={mobileVisualTokens.color.label} />
          </View>
        </Button>
      </View>
    </View>}
  >
  {(progress, { docked }) => <FloatingDrawerScene progress={progress}><View style={[styles.host, { paddingTop: insets.top, paddingBottom: section === "chat" ? 0 : insets.bottom, paddingLeft: docked ? 0 : insets.left, paddingRight: insets.right }]}>
    <View style={styles.toolbar}>
      <Button variant="ghost" style={styles.menuButton} onPress={() => drawer.current?.toggleNavigation()} accessibilityLabel={docked ? language === "zh-CN" ? "收起侧栏" : "Hide sidebar" : language === "zh-CN" ? "打开智能体菜单" : "Open agent menu"}>
        <Menu size={23} color={mobileVisualTokens.color.accentBright} />
      </Button>
      <Typography.Heading type="h4" numberOfLines={1} style={styles.toolbarTitle}>{title}</Typography.Heading>
      <Bot size={20} color={mobileVisualTokens.color.iconBrandMuted} />
    </View>
    <View style={styles.content}>
      {html ? <GestureDetector gesture={webGesture}><WebView
        ref={webView}
        key={`${region}:${webViewGeneration}`}
        source={{ html, baseUrl: siteOrigin }}
        style={{ flex: 1, opacity: section === "chat" ? 0 : 1, backgroundColor: mobileVisualTokens.color.contentCanvas }}
        pointerEvents={section === "chat" ? "none" : "auto"}
        originWhitelist={["*"]}
        setSupportMultipleWindows={false}
        javaScriptEnabled
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
      /></GestureDetector> : null}
      {chatMounted ? <View pointerEvents={section === "chat" ? "auto" : "none"} style={[StyleSheet.absoluteFill, { opacity: section === "chat" ? 1 : 0 }]}>
        {selectedBot && selectedBot.status === "running" ? <MobileOpenCraftChat
          key={`${selectedBot.instanceId}:${selectedBot.profileId}`}
          bot={selectedBot}
          credentialScope={credentialScope}
          language={language === "zh-CN" ? "zh-CN" : "en"}
          active={active && section === "chat"}
        /> : <View style={styles.center}>
          <Typography>{selectedBot
            ? language === "zh-CN" ? "智能体启动后即可对话" : "Chat is available when this agent is running"
            : language === "zh-CN" ? "选择一个智能体开始对话" : "Select an agent to start chatting"}</Typography>
        </View>}
      </View> : null}
      {section !== "chat" && !ready && !loadFailed ? <View style={[styles.center, StyleSheet.absoluteFill]} pointerEvents="none"><ActivityIndicator color={mobileVisualTokens.color.accentBright} /></View> : null}
      {section !== "chat" && (loadFailed || failedSection === section) ? <View style={[styles.center, StyleSheet.absoluteFill]}>
        <Card variant="secondary"><Card.Body><Card.Title>{copy.siteOpenError}</Card.Title></Card.Body><Card.Footer>
          <Button onPress={retryRuntime}>{copy.siteRetry}</Button>
        </Card.Footer></Card>
      </View> : null}
      {section !== "chat" && ready && (botsError || botsTimedOut) && bots.length === 0 ? <View style={[styles.center, StyleSheet.absoluteFill]}>
        <Card variant="secondary"><Card.Body><Card.Title>{copy.siteOpenError}</Card.Title></Card.Body><Card.Footer>
          <Button onPress={retryBots}>{copy.siteRetry}</Button>
        </Card.Footer></Card>
      </View> : null}
    </View>
  </View></FloatingDrawerScene>}
  </InterruptibleMobileDrawer>;
}
