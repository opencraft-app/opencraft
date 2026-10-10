import { useMemo, useState } from "react";
import { Image as CachedImage } from "expo-image";
import { Avatar, Button, ListGroup, Separator, Spinner, Tabs, Typography } from "heroui-native";
import { nativeTokens } from "@opencraft/design-system/tokens.native";
import { Activity, Brain, CircleUserRound, Clock3, Cloud, Database, Files, FlaskConical, Globe, LayoutDashboard, MessageCircle, Monitor, Plug, Plus, Radio, Settings2, SlidersHorizontal, Sparkles, Trash2, Trophy, UserRound, type LucideIcon } from "lucide-react-native";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { AVATAR_SHAPES } from "@opencraft/mobile-bot-bridge/avatar-shapes";
import type { BotCommand, BotSummary } from "@opencraft/mobile-bot-bridge";
import type { projectBotNavigation } from "../runtime/mobile-bot-navigation-state";
import { mobileLanguageCopy, type MobileLanguage } from "../runtime/mobile-language";
import { mobileVisualTokens } from "../runtime/mobile-visual-tokens";
import { MobileAgentSessions, MobileAgentSessionPlaceholder } from "./mobile-agent-sessions.shared";
export type Section = "overview" | "channel" | "connectors" | "model" | "skill" | "buddy" | "automations" | "diagnostics" | "settings" | "memory" | "achievement" | "chat" | "files" | "browser" | "terminal" | "deepseek-harness" | "cloud-desktop" | "website" | "workbench";
export type BotAvatarModel = { configured: boolean; shapeId: string; color: string };

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
const sectionIds = new Set<string>(sections.map(section => section.id));
export const isAgentSection = (section: string): section is Section => sectionIds.has(section);
const hiddenDrawerSections: ReadonlySet<Section> = new Set(["browser", "terminal", "workbench"]);
const sectionIcons = new Map(sections.map(section => [section.id, section.icon]));
const styles = StyleSheet.create({
  drawer: { flex: 1, backgroundColor: mobileVisualTokens.color.sidebar },
  drawerScroll: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 28 },
  groupLabel: { color: mobileVisualTokens.color.label, marginHorizontal: 12, marginTop: 20, marginBottom: 10, fontWeight: "600" },
  navigationBody: { flex: 1, minHeight: 0, flexDirection: "row" },
  botRail: { width: 64, flexGrow: 0, flexShrink: 0 },
  railSeparator: { position: "absolute", left: 63, top: 0, bottom: 0, backgroundColor: mobileVisualTokens.color.separator },
  botRailScroll: { alignItems: "center", paddingVertical: 10, gap: 8 },
  railButton: { alignItems: "center", justifyContent: "center", width: 48, height: 48, minWidth: 48, padding: 0, borderRadius: 16, backgroundColor: "transparent", borderWidth: 1, borderColor: "transparent" },
  railSelected: { backgroundColor: mobileVisualTokens.color.selected, borderColor: mobileVisualTokens.color.accent },
  railStatus: { position: "absolute", bottom: -1, right: -1, width: 9, height: 9, borderRadius: 5, borderWidth: 2, borderColor: mobileVisualTokens.color.sidebar },
  railCreate: { backgroundColor: mobileVisualTokens.color.accentSoft },
  groupHeading: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8 },
  botHeading: { flex: 1, minWidth: 0, gap: 3 },
  headingAction: { width: 32, height: 32, minWidth: 32, padding: 0, borderRadius: 11, backgroundColor: "transparent" },
  row: { width: "100%", minHeight: 48, justifyContent: "flex-start", borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: "transparent" },
  botName: { color: mobileVisualTokens.color.rowText, fontSize: 14, fontWeight: "600" },
  botStatusText: { color: mobileVisualTokens.color.label, fontSize: 11 },
  botAvatar: { width: 39, height: 39, borderRadius: 13, overflow: "hidden", alignItems: "center", justifyContent: "center", backgroundColor: mobileVisualTokens.color.accentSoft },
  botAvatarImage: { width: 39, height: 39, borderRadius: 13 },
  selectedRow: { backgroundColor: mobileVisualTokens.color.selected },
  navigationTabs: { flex: 1, minHeight: 0 },
  navigationTabHeader: { flexShrink: 0, paddingHorizontal: 12, paddingTop: 18, paddingBottom: 6 },
  navigationTabList: { width: "100%" },
  navigationTabTrigger: { flex: 1, minHeight: nativeTokens.metrics.toolbar.touchTarget },
  rowText: { color: mobileVisualTokens.color.rowText, fontSize: 15 },
  selectedText: { color: mobileVisualTokens.color.accent, fontWeight: "700" },
  accountFooter: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8 },
  footerSeparator: { position: "absolute", top: 0, left: 0, right: 0, backgroundColor: mobileVisualTokens.color.separator },
  accountButton: { minHeight: 58, width: "100%", justifyContent: "flex-start", borderRadius: 16, backgroundColor: "transparent", paddingHorizontal: 12, paddingVertical: 8 },
  accountSubtitle: { color: mobileVisualTokens.color.label, marginTop: 2 },
  accountAvatar: { width: 38, height: 38, borderRadius: 13 },
  accountAvatarFallback: { width: 38, height: 38, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: mobileVisualTokens.color.accentSoft },
  accountAvatarLetter: { color: mobileVisualTokens.color.accent, fontSize: 17, fontWeight: "700" },
});

function DrawerAccountAvatar({ url, name }: { readonly url: string | null; readonly name: string | null }) {
  const source = useMemo(() => url ? { uri: url } : undefined, [url]);
  return <Avatar alt={name ?? "Account"} size="sm" animation="disable-all" style={styles.accountAvatar}>
    {source ? <Avatar.Image asChild source={source} style={styles.accountAvatar}>
      <CachedImage source={source} cachePolicy="memory-disk" style={styles.accountAvatar} />
    </Avatar.Image> : null}
    <Avatar.Fallback styles={{ container: styles.accountAvatarFallback, text: styles.accountAvatarLetter }}>
      {name ? Array.from(name)[0]?.toUpperCase() : <CircleUserRound size={23} color={mobileVisualTokens.color.accent} />}
    </Avatar.Fallback>
  </Avatar>;
}

function DrawerBotAvatar({ model }: { readonly model?: BotAvatarModel }) {
  const shape = AVATAR_SHAPES.find(item => item.id === model?.shapeId);
  if (!model?.configured || !shape) return <View style={styles.botAvatar}>
    <CachedImage source={require("../../assets/lightvela-icon.png") as number} cachePolicy="memory-disk" style={styles.botAvatarImage} contentFit="contain" />
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


/** Shared navigation presentation. The frontend controller owns permissions and mutations. */
export function MobileAgentNavigation({ language, bots, botId, section, botAvatars,
  ready, botsLoading, botsError, botsTimedOut, createVisible, createEnabled, navigation,
  accountIdentity, select, sendCommand, retryBots, onDismiss, onOpenAccount,
}: {
  language: MobileLanguage; bots: readonly BotSummary[]; botId: string; section: Section;
  botAvatars: Readonly<Record<string, BotAvatarModel>>; ready: boolean; botsLoading: boolean;
  botsError: boolean; botsTimedOut: boolean; createVisible: boolean; createEnabled: boolean;
  navigation: ReturnType<typeof projectBotNavigation>;
  accountIdentity: { displayName: string | null; avatarUrl: string | null } | null;
  select: (section: Section, botId: string, keepNavigation?: boolean) => void; sendCommand: (command: BotCommand) => void;
  retryBots: () => void; onDismiss: () => void; onOpenAccount: () => void;
}) {
  const copy = mobileLanguageCopy(language);
  const [navigationTab, setNavigationTab] = useState<"daily" | "explore">("daily");
  const selectedBot = bots.find(bot => bot.id === botId);
  const zh = language === "zh-CN";
  const { consoleState } = navigation;
  return <View style={styles.drawer}>
    <View style={styles.navigationBody}>
      <ScrollView style={styles.botRail} contentContainerStyle={styles.botRailScroll} accessibilityLabel={zh ? "切换智能体" : "Switch agent"}>
        {bots.map(bot => <Button key={bot.id} variant="ghost" isIconOnly style={[styles.railButton, botId === bot.id && styles.railSelected]}
          accessibilityLabel={`${zh ? "切换到" : "Switch to"} ${bot.name}, ${botStatus(bot.status, language).label}`}
          aria-selected={botId === bot.id} accessibilityState={{ selected: botId === bot.id }} onPress={() => select("chat", bot.id, true)}>
          <View><DrawerBotAvatar model={botAvatars[bot.id]} />
            <View style={[styles.railStatus, { backgroundColor: botStatus(bot.status, language).color }]} />
          </View>
        </Button>)}
        {createVisible ? <Button variant="ghost" isIconOnly style={[styles.railButton, styles.railCreate]} isDisabled={!ready || !createEnabled}
          accessibilityLabel={zh ? "新建智能体" : "Create bot"} onPress={() => { onDismiss(); sendCommand({ type: "create" }); }}>
          <Plus size={22} color={mobileVisualTokens.color.accent} />
        </Button> : null}
        {botsLoading && bots.length === 0 && !botsTimedOut && !botsError ? <Spinner size="sm" color={mobileVisualTokens.color.accentBright} /> : null}
      </ScrollView>
      <Separator orientation="vertical" thickness={StyleSheet.hairlineWidth} style={styles.railSeparator} />
      <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        <View style={styles.groupHeading}>
          <View style={styles.botHeading}>
            <Text numberOfLines={1} style={styles.botName}>{selectedBot?.name ?? copy.agents}</Text>
            {selectedBot ? <Text style={styles.botStatusText}>{botStatus(selectedBot.status, language).label}</Text> : null}
          </View>
          {selectedBot ? <Button variant="ghost" isIconOnly style={styles.headingAction}
            isDisabled={!ready || selectedBot.status === "provisioning" || selectedBot.status === "deleting"}
            accessibilityLabel={zh ? `删除 ${selectedBot.name}` : `Delete ${selectedBot.name}`} onPress={() => {
              onDismiss(); sendCommand({ type: "delete", botId: selectedBot.id });
            }}><Trash2 size={16} color={mobileVisualTokens.color.destructiveIcon} /></Button> : null}
        </View>
        <Tabs value={navigationTab} onValueChange={value => {
          if (value === "daily" || value === "explore") setNavigationTab(value);
        }} variant="primary" style={styles.navigationTabs}>
          <View style={styles.navigationTabHeader}>
          <Tabs.List style={styles.navigationTabList} accessibilityLabel={zh ? "导航分类" : "Navigation groups"}>
            <Tabs.Indicator />
            {(["daily", "explore"] as const).map(tab => <Tabs.Trigger key={tab} value={tab} style={styles.navigationTabTrigger}>
              <Tabs.Label>{tab === "daily" ? zh ? "日常" : "Daily" : zh ? "探索" : "Explore"}</Tabs.Label>
            </Tabs.Trigger>)}
          </Tabs.List>
          </View>
          <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={styles.drawerScroll}
            accessibilityLabel={zh ? "功能和会话列表" : "Features and conversations"}>
          {(botsTimedOut || botsError) && bots.length === 0 ? <Button variant="ghost" style={styles.row} onPress={retryBots}><Button.Label style={styles.selectedText}>{copy.siteRetry}</Button.Label></Button> : null}
          {(["daily", "explore"] as const).map(tab => <Tabs.Content key={tab} value={tab}>
            {navigation.groups.filter(group => tab === "daily" ? group.id === "daily" : group.id !== "daily").map(group => <ListGroup key={group.id} variant="transparent">
              {group.id !== "daily" ? <Typography type="body-xs" style={styles.groupLabel}>{group.label}</Typography> : null}
              {group.sections.filter(item => sectionIds.has(item.id as Section) && !hiddenDrawerSections.has(item.id as Section)).map(item => {
                const Icon = sectionIcons.get(item.id as Section) ?? SlidersHorizontal;
                return <ListGroup.Item key={item.id} accessibilityRole="button" accessibilityLabel={item.label}
                  disabled={!navigation.interactive}
                  accessibilityState={{ selected: section === item.id, disabled: !navigation.interactive }}
                  style={({ pressed }) => [styles.row, section === item.id && styles.selectedRow,
                    pressed && { opacity: nativeTokens.metrics.interaction.pressedOpacity }]}
                  onPress={() => { if (navigation.interactive) select(item.id as Section, botId); }}>
                  <ListGroup.ItemPrefix><Icon size={19} color={section === item.id ? mobileVisualTokens.color.accent : mobileVisualTokens.color.icon} /></ListGroup.ItemPrefix>
                  <ListGroup.ItemContent style={{ minWidth: 0 }}>
                    <ListGroup.ItemTitle numberOfLines={1} style={[styles.rowText, section === item.id && styles.selectedText]}>{item.label}</ListGroup.ItemTitle>
                  </ListGroup.ItemContent>
                </ListGroup.Item>;
              })}
            </ListGroup>)}
            {tab === "daily" && consoleState?.botId === botId ? <MobileAgentSessions key={botId} state={consoleState} zh={language === "zh-CN"} onCommand={command => {
              if (command.action === "select" || command.action === "create") onDismiss();
              sendCommand(command);
            }} /> : null}
            {tab === "daily" && botId && !consoleState ? <MobileAgentSessionPlaceholder rows={navigation.placeholderRows} /> : null}
          </Tabs.Content>)}
          </ScrollView>
        </Tabs>
      </View>
    </View>
      <View style={styles.accountFooter}>
        <Separator thickness={StyleSheet.hairlineWidth} style={styles.footerSeparator} />
        <ListGroup variant="transparent">
          <ListGroup.Item accessibilityRole="button" style={({ pressed }) => [styles.accountButton,
              pressed && { opacity: nativeTokens.metrics.interaction.pressedOpacity }]}
            accessibilityLabel={accountIdentity?.displayName ? `${accountIdentity.displayName}，${zh ? "个人与设置" : "Account and settings"}` : zh ? "个人与设置" : "Account and settings"} onPress={onOpenAccount}>
            <ListGroup.ItemPrefix><DrawerAccountAvatar url={accountIdentity?.avatarUrl ?? null} name={accountIdentity?.displayName ?? null} /></ListGroup.ItemPrefix>
            <ListGroup.ItemContent style={{ minWidth: 0 }}>
              <ListGroup.ItemTitle numberOfLines={1} style={styles.rowText}>{accountIdentity?.displayName ?? (zh ? "我的账号" : "My account")}</ListGroup.ItemTitle>
              <ListGroup.ItemDescription style={styles.accountSubtitle}>{zh ? "个人与设置" : "Account and settings"}</ListGroup.ItemDescription>
            </ListGroup.ItemContent>
            <ListGroup.ItemSuffix><Settings2 size={18} color={mobileVisualTokens.color.label} /></ListGroup.ItemSuffix>
          </ListGroup.Item>
        </ListGroup>
      </View>
  </View>;
}
