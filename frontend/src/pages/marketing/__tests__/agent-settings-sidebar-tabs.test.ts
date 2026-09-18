import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 侧边栏「探索/对话」双 tab 改造守卫测试。
 *
 * 背景：对话入口从「使用」菜单组移到侧边栏顶部 tab；「对话」tab 渲染最近会话列表，
 * 数据来自 SDK 1.4.0-beta.0 的 multiSession 受控桥接。本测试做源码级守卫，
 * 防止后续改动悄悄回退这些结构性约定。
 */

const readPageSource = () =>
  readFileSync(join(process.cwd(), "src/pages/marketing/agent-settings-page.tsx"), "utf8");

const readStylesSource = () =>
  readFileSync(join(process.cwd(), "src/styles.css"), "utf8");

const readChatPanelSource = () =>
  readFileSync(join(process.cwd(), "src/pages/marketing/agent-chat-panel.tsx"), "utf8");

/**
 * 「正在创建」咖啡杯动效原先内联在 agent-settings-page.tsx，
 * 因新手引导面板需复用已抽到独立文件，守卫随之指向新位置。
 */
const readCreatingLoadingSource = () =>
  readFileSync(join(process.cwd(), "src/pages/marketing/agent-creating-loading.tsx"), "utf8");

const readGeneratedDictionary = (locale: string): Record<string, string> =>
  JSON.parse(
    readFileSync(join(process.cwd(), `src/i18n/generated/${locale}.json`), "utf8"),
  ) as Record<string, string>;

describe("agent settings sidebar chat/settings tabs", () => {
  /*
   * 这里采纳 master 的彻底版：showCreateBotEntry 整个删掉，条件直接写
   * {multiBotEnabled && (。
   *
   * 本分支曾把它硬编码成 `= true` 来放开入口 —— 目的一样，但留下一个恒真
   * 变量就是死代码。两道真正的闸门（multiBotEnabled 后端开关 /
   * canCreateAdditionalBot 套餐额度）在 master 版里都还在，下面逐条守住。
   */
  it("shows additional Bot creation without console reveal while preserving feature and quota gates", () => {
    const page = readPageSource();
    expect(page).toContain("const [showHiddenAgentTools, setShowHiddenAgentTools] = useState(false);");
    expect(page).not.toContain("showCreateBotEntry");
    expect(page).toContain("{multiBotEnabled && (");
    expect(page).toContain('content={createLimitMessage || t("新建 Bot")}');
    expect(page).toContain("disabled={!canCreateAdditionalBot}");
    expect(page).toContain("!isCreating && !botsLoading && visibleBots.length === 0");
    expect(page).toContain("disabled={!canCreateInitialAgent || directCreating}");
    expect(page).not.toContain("const canCreateBot = multiBotEnabled");
    // showHiddenAgentTools 仍用于其它隐藏工具，不应被顺手删掉
    expect(page).toContain("const [showHiddenAgentTools, setShowHiddenAgentTools] = useState(false);");
  });

  it("opens a name-only dialog before creating the first Bot as blank", () => {
    const page = readPageSource();
    const initialCreation = page.slice(
      page.indexOf("const handleCreateNew"),
      page.indexOf("const handleConfirmCreate"),
    );
    const noActiveBotBranch = initialCreation.slice(
      initialCreation.indexOf("if (!activeBot)"),
      initialCreation.indexOf('setCreateBotMode("clone-current")'),
    );

    expect(noActiveBotBranch).toContain('setCreateBotMode("blank")');
    expect(noActiveBotBranch).toContain("setShowCreateConfirm(true)");
    expect(noActiveBotBranch).not.toContain("createInitialBot");

    expect(page).toContain("const isFirstBotCreation = !activeBot");
    expect(page).toContain("const cloneIntent = resolveBotCloneIntent({");
    expect(page).toContain("isInitialCreation: isFirstBotCreation");
    expect(page).toContain("currentBotId: activeBot?.id");
    expect(page).toContain("mainBotId: defaultBot?.id");
    expect(page).toContain("if (!cloneIntent.ok)");
    expect(page).not.toContain("createBotSoul");
    expect(page).not.toContain("initialSoul:");
    expect(page).toContain("{!isFirstBotCreation && (");
    expect(page).toContain("createMode: cloneIntent.intent.mode");
    expect(page).toContain('sourceBotId: cloneIntent.intent.mode === "clone" ? cloneIntent.intent.sourceBotId : undefined');
  });

  it("refreshes the shared Bot list before leaving the creation page", () => {
    const page = readPageSource();
    const polling = page.slice(
      page.indexOf("const pollCreationStatus"),
      page.indexOf("const createBotAndNavigate"),
    );
    const activeBranch = polling.slice(
      polling.indexOf('if (targetBot.status === "active")'),
      polling.indexOf('if (targetBot.status === "failed")'),
    );

    expect(activeBranch.indexOf("await refreshBots()")).toBeGreaterThan(-1);
    expect(activeBranch.indexOf("await refreshBots()")).toBeLessThan(activeBranch.indexOf("navigate("));
  });

  it("uses the LightVela Bot loading copy while keeping the ellipsis dynamic", () => {
    const loadingView = readCreatingLoadingSource();
    const enUS = readGeneratedDictionary("en-US");

    expect(enUS.k_831919bc).toBe("Getting your LightVela Bot ready");
    expect(loadingView).toContain("{dots}");
    expect(enUS.k_831919bc).not.toContain("...");
  });

  it("keeps the English expiry badge on one line", () => {
    const styles = readStylesSource();
    const badgeRule = styles.slice(
      styles.indexOf(".lv-agent-renewal-badge {"),
      styles.indexOf(".lv-agent-renewal-badge.is-warning"),
    );

    expect(readGeneratedDictionary("en-US").k_1f5f486e).toBe("Expires soon");
    expect(readGeneratedDictionary("en-US").k_1c97a7ce).toBe("Expires soon");
    expect(badgeRule).toContain("white-space: nowrap;");
  });

  it("removes the legacy SHOW_AGENTCHAT_ENTRY gate", () => {
    expect(readPageSource()).not.toContain("SHOW_AGENTCHAT_ENTRY");
  });

  it("renders the sidebar tabs segmented control above the settings nav", () => {
    const page = readPageSource();
    const tabsStart = page.indexOf("lv-agents-sidebar-tabs");
    const navStart = page.indexOf('aria-label={t("实例配置导航")}');

    expect(tabsStart).toBeGreaterThanOrEqual(0);
    expect(navStart).toBeGreaterThan(tabsStart);
    expect(page).toContain('role="tablist"');
    expect(page).toContain('aria-selected={sidebarTab === "chat" && isActiveBotDefault}');
    expect(page).toContain('aria-selected={sidebarTab === "settings"}');
  });

  it("labels the top-level modes as explore and chat", () => {
    const page = readPageSource();
    const tabs = page.slice(
      page.indexOf("lv-agents-sidebar-tabs"),
      page.indexOf('{sidebarTab === "chat" ? ('),
    );

    expect(tabs).toContain('t("探索")');
    expect(tabs).toContain('t("对话")');
    expect(tabs).not.toContain('t("设置")');
  });

  it("removes the legacy full-width create button while retaining pill-shaped tabs", () => {
    const styles = readStylesSource();
    const sidebarTabsStyles = styles.slice(
      styles.indexOf(".lv-agents-sidebar-tabs {"),
      styles.indexOf(".lv-agents-sidebar-tab:hover"),
    );

    expect(styles).not.toContain(".lv-agent-create-button");
    expect(sidebarTabsStyles.match(/border-radius: 999px;/g)).toHaveLength(2);
  });

  it("translates the explore and chat tabs in every supported locale", () => {
    const exploreKey = readGeneratedDictionary("zh-to-key")["探索"];
    const chatKey = readGeneratedDictionary("zh-to-key")["对话"];
    const expectedByLocale = {
      "zh-CN": { explore: "探索", chat: "对话" },
      "zh-Hant": { explore: "探索", chat: "對話" },
      "en-US": { explore: "Explore", chat: "Chat" },
      "id-ID": { explore: "Jelajahi", chat: "Obrolan" },
      es: { explore: "Explorar", chat: "Conversación" },
      "ja-JP": { explore: "探索", chat: "チャット" },
      "ko-KR": { explore: "탐색", chat: "채팅" },
    } as const;

    expect(exploreKey).toBeDefined();
    expect(chatKey).toBeDefined();
    for (const [locale, expected] of Object.entries(expectedByLocale)) {
      const dictionary = readGeneratedDictionary(locale);
      expect(dictionary[exploreKey!]).toBe(expected.explore);
      expect(dictionary[chatKey!]).toBe(expected.chat);
    }
  });

  it("places skills under use before automations; workbench lives in labs", () => {
    const page = readPageSource();
    const setupGroupStart = page.indexOf('id: "setup"');
    const useGroupStart = page.indexOf('id: "use"');
    const growthGroupStart = page.indexOf('id: "growth"');
    const setupGroup = page.slice(setupGroupStart, useGroupStart);
    const useGroup = page.slice(useGroupStart, growthGroupStart);

    expect(setupGroup).not.toContain('id: "skill"');
    expect(useGroup).toContain('id: "skill"');
    expect(useGroup.indexOf('id: "skill"')).toBeLessThan(
      useGroup.indexOf('id: "automations"'),
    );
    expect(useGroup).not.toContain('id: "website"');
    expect(useGroup).not.toContain("isGlobal && showHiddenAgentTools");
  });

  it("navigates the main area on tab click (settings → last menu, chat → first session)", () => {
    const page = readPageSource();

    // 点「探索」：在对话页时回到前一个设置菜单（模块级记忆，跨 /agents/[section] 重挂载存活）。
    expect(page).toContain("handleSidebarSettingsTabClick");
    expect(page).toContain("let lastSettingsSection");
    expect(page).toContain("AGENT_SECTION_PATH_BY_ID[lastSettingsSection]");

    // 点「对话」：非对话页时进入 chat 页，并默认选中第一个会话。
    expect(page).toContain("handleSidebarChatTabClick");
    expect(page).toContain("setSelectedChatId(chatSessions[0]?.chatId)");
  });

  it("restricts AgentChat to the main Bot", () => {
    const page = readPageSource();
    const styles = readStylesSource();

    expect(page).toContain("if (!isActiveBotDefault) return;");
    expect(page).toContain('disabled={!isActiveBotDefault}');
    expect(page).toContain('t("对话功能目前仅支持主 Bot")');
    expect(page).not.toContain('title={isActiveBotDefault ? undefined');
    expect(page).toContain('id={chatAvailabilityTooltipId} role="tooltip" className="lv-agent-action-tooltip"');
    expect(page).toContain('activeSection !== "chat" || !isActiveBotDefault');
    expect(page).toContain('activeSection === "chat" && isActiveBotDefault &&');
    expect(page).toContain('activeSection === "chat" && !selectedBot?.isDefault ? "channel" : activeSection');
    expect(styles).toContain(".lv-agents-sidebar-tab:disabled");
  });

  it("derives the initial tab from the current route", () => {
    expect(readPageSource()).toContain(
      'activeSection === "chat" ? "chat" : "settings"',
    );
  });

  it("renders the recent sessions list under the chat tab", () => {
    const page = readPageSource();

    expect(page).toContain('t("最近会话")');
    expect(page).toContain("chatSessions.map");
    expect(page).toContain('lv-agents-session-item');
  });

  it("places the create icon before restart and the multi-Bot chevron after delete", () => {
    const page = readPageSource();
    const profile = page.slice(
      page.indexOf('className="lv-agent-actions"'),
      page.indexOf("{visibleBots.length > 1 &&", page.indexOf('className="lv-agent-actions"')),
    );

    expect(profile).toContain("setShowRestartConfirm(true)");
    expect(profile).toContain("setShowDeleteConfirm(true)");
    expect(profile).toContain("<RefreshCw");
    expect(profile).toContain("<Trash2");
    expect(profile).toContain('aria-label={t("新建 Bot")}');
    expect(profile).toContain('<Plus className="h-4 w-4" aria-hidden="true" />');
    expect(profile.indexOf('aria-label={t("新建 Bot")}')).toBeLessThan(profile.indexOf("<RestartIcon"));
    expect(profile.indexOf("<RestartIcon")).toBeLessThan(profile.indexOf("<Trash2"));
    expect(profile).not.toContain("<MoreHorizontal");
    expect(page).toContain('{visibleBots.length > 1 && (\n                              <ChevronDown');
    expect(page.indexOf("<Trash2")).toBeLessThan(page.indexOf('<ChevronDown\n                                aria-hidden="true"'));
  });

  it("renders the Bot switcher as an overlay popover instead of in sidebar flow", () => {
    const page = readPageSource();

    expect(page).toContain("<Popover");
    expect(page).toContain("<PopoverTrigger asChild>");
    expect(page).toContain("<PopoverContent");
    expect(page).toContain("w-[var(--radix-popover-trigger-width)]");
    const switcherStart = page.indexOf("<PopoverContent");
    const menu = page.slice(switcherStart, page.indexOf("</PopoverContent>", switcherStart));
    expect(menu).toContain("border-black/10 bg-white p-1.5 shadow-xl");
    expect(menu).not.toContain("backdrop-");
    expect(menu).not.toContain("<img");
    expect(menu).not.toContain("bg-white/");
    expect(menu).not.toContain("shadow-sm");
    expect(menu).toContain('isActive ? "text-black/90"');
    expect(menu).toContain("{isActive && <Check");
    expect(page).not.toContain("visibleBots.length > 1 && isAgentMenuOpen &&");
    expect(page).toContain("{visibleBots.map((bot) => {");
    expect(page).not.toContain("botSearch");
    expect(page).not.toContain('t("搜索 Bot")');
  });

  it("keeps the current Bot header background unchanged on hover", () => {
    const page = readPageSource();
    const trigger = page.slice(page.indexOf("<PopoverTrigger asChild>"), page.indexOf("</PopoverTrigger>"));
    expect(trigger).toContain('"lv-agent-profile"');
    expect(trigger).not.toContain("hover:bg-");
    expect(trigger).toContain("onKeyDown");
  });

  it("keeps header actions compact without shrinking their hit areas", () => {
    const styles = readStylesSource();
    const actions = styles.slice(styles.indexOf(".lv-agent-actions {"), styles.indexOf(".lv-agent-action-item {"));
    const button = styles.slice(styles.indexOf(".lv-agent-action-button {"), styles.indexOf(".lv-agent-action-button:hover"));
    expect(actions).toContain("gap: 4px;");
    expect(button).toContain("width: 24px;");
    expect(button).toContain("height: 24px;");
    expect(readPageSource()).toContain('"-ml-2 h-4 w-4 flex-shrink-0 text-black/35 transition-transform"');
  });

  it("creates another Bot inside an existing instance without requiring a new subscription", () => {
    const page = readPageSource();

    expect(page).toContain("if (!activeBot)");
    expect(page).toContain("setShowCreateConfirm(true)");
    expect(page).toContain('navigate("/subscribe")');
    expect(page).toContain("max-w-[42rem]");
    expect(page).not.toContain('t("用途说明")');
    expect(page).not.toContain("isCreateAdvancedOpen");
    expect(page).not.toContain('aria-controls="create-bot-advanced-settings"');
    expect(page).not.toContain('t("初始人设（可选）")');
    expect(page).toContain('className="mt-5 flex justify-end gap-2"');
    expect(page).toContain("const isActiveBotDefault = Boolean(activeBot && defaultBot && activeBot.id === defaultBot.id)");
    expect(page).toContain('isActiveBotDefault ? "grid-cols-2" : "grid-cols-3"');
    expect(page).toContain('isActiveBotDefault ? t("复制当前（主 Bot）") : t("复制当前")');
    expect(page).toContain('...(!isActiveBotDefault ? [["clone-main", t("复制主 Bot")] as const] : [])');
    expect(page).toContain('>{t("创建 Bot")}</h3>');
    expect(page).toContain(': t("确认创建")}');
    expect(page).toContain("const MAX_BOT_NAME_LENGTH = 60");
    /*
     * 这条原本硬编码 `toHaveLength(2)`，但 setCreateBotName("") 的调用点数量
     * 会随创建入口增减而变（master 合入订阅回跳后就变成 3 处），数量本身
     * 不是它要守的东西。真正要守的是「打开弹窗时不预填默认名，让用户自己取」，
     * 所以改成断言至少存在清空调用 + 不存在预填写法。
     */
    expect(page.match(/setCreateBotName\(""\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(page).not.toContain('setCreateBotName(t("新 Bot"))');
    expect(page).toContain('placeholder={t("请输入 Bot 名称")}');
    expect(page).toContain("maxLength={MAX_BOT_NAME_LENGTH}");
    expect(page).toContain("{Array.from(createBotName).length}/{MAX_BOT_NAME_LENGTH}");
    expect(page).toContain('className="block space-y-2 text-sm font-medium text-black/70"');
    expect(page).toContain("Array.from(normalizedName).length > MAX_BOT_NAME_LENGTH");
    expect(page).toContain('t("最大不能超过 {{max}} 字符。", { max: MAX_BOT_NAME_LENGTH })');
    expect(page).toContain('aria-label={t("新建 Bot")}');
    expect(page).not.toContain('className="lv-agent-create-button"');
    expect(page).toContain("handleCreateNew();");
    expect(page).not.toContain('t("立即创建")');
    expect(page).not.toContain('t("创建智能体")');
    expect(page).toContain('<dt className="w-12 shrink-0 font-medium text-black/70">{t("继承")}</dt>');
    expect(page).toContain('t("模型、人设、技能、用户偏好和长期记忆")');
    expect(page).toContain('<dt className="w-12 shrink-0 font-medium text-black/70">{t("不继承")}</dt>');
    expect(page).toContain('t("当前对话、历史会话、定时任务、运行状态或通道连接")');
    expect(page).toContain('t("主 Bot 当前主模型及其 Provider 凭据")');
    expect(page).toContain('<dt className="w-12 shrink-0 font-medium text-black/70">Skills</dt>');
    expect(page).toContain('t("系统预置")');
    expect(page).toContain('t("备用模型、其他已配置模型、人设、记忆、主 Bot 后续安装的 Skills、通道和定时任务")');
    expect(page).not.toContain('t("使用 LightVela 默认配置创建一个独立 Bot。")');
    expect(page).not.toContain('t("使用 Hermes 默认配置创建独立 Bot。")');
    expect(page).not.toContain("Memory、User Profile");
    expect(page).not.toContain("Channel 凭证或 Home Channel");
  });

  it("normalizes backend and SDK default copy before rendering the sidebar", () => {
    const page = readPageSource();

    expect(page).toContain("resolveAgentDisplayName(activeBot.name, t)");
    expect(page).toMatch(
      /resolveAgentSessionTitle\(\s*session\.title,\s*i18n\.language,\s*t\("默认会话"\),?\s*\)/,
    );
    expect(page).toContain("{sessionDisplayTitle}");
  });

  it("shows a default-chat entry when the SDK has no sessions yet", () => {
    const page = readPageSource();

    // 空态：列表里渲染「默认对话」可点入口（行为对齐之前的对话菜单项），
    // 让用户无论 SDK 是否已加载都至少有一个进入对话主区的入口。
    expect(page).toContain('chatSessions.length === 0 ?');
    expect(page).toContain('AGENT_SECTION_PATH_BY_ID.chat');
  });

  it("wires the SDK multiSession controlled bridge into AgentChatPanel", () => {
    const page = readPageSource();
    const chatPanel = readChatPanelSource();

    // 宿主构造受控桥并下传。
    expect(page).toContain("chatMultiSessionBridge");
    expect(page).toContain("multiSession={chatMultiSessionBridge}");
    // AgentChatPanel 透传给 LightVelaPanel。
    expect(chatPanel).toContain("multiSession?: LightVelaMultiSessionOptions");
    expect(chatPanel).toContain("multiSession={multiSession}");
  });

  it("fills the available desktop layout while preserving the compact panel height", () => {
    const chatPanel = readChatPanelSource();

    expect(chatPanel).toContain(
      "h-[clamp(516px,calc(100vh-220px),960px)]",
    );
    expect(chatPanel).toContain("lg:h-full");
  });

  it("marks the active chat route and removes its desktop page padding", () => {
    const page = readPageSource();

    expect(page).toContain('activeSection === "chat" && "lv-agent-chat-page"');
    expect(page).toContain('"lw-app-top-pad flex-grow bg-white pb-6"');
    expect(page).toContain('activeSection === "chat" && "lg:pb-0"');
    /*
     * lv-agent-settings-main / -shell / 栅格列这三处本分支按
     * hasSidebarLayout || shouldShowDataLoading 条件化了（引导态没有侧边栏，
     * 骨架屏则要跟最终页面保持同一套几何），所以不再是 master 那种
     * 写死在字符串里的形式。这里断言「类名仍在 + 条件仍在」，
     * 具体几何由 agent-settings-nav-spacing 那条守。
     */
    expect(page).toContain('(hasSidebarLayout || shouldShowDataLoading) && "lv-agent-settings-main"');
    expect(page).toContain("lv-agent-settings-grid grid items-start gap-6");
    expect(page).toContain('hasSidebarLayout && "lg:grid-cols-[248px_minmax(0,1fr)]"');
  });

  it("exposes rename and delete in the session menu (delete needs confirmation)", () => {
    const page = readPageSource();

    expect(page).toContain('role="menuitem"');
    expect(page).toContain('t("重命名")');
    expect(page).toContain('t("删除")');
    // SDK 1.4.1 提供 renameSession / deleteSession。
    expect(page).toContain("renameSession");
    expect(page).toContain("deleteSession");
    // 删除需二次确认弹窗。
    expect(page).toContain("sessionToDelete");
    expect(page).toContain('t("删除会话")');
    expect(page).toContain("confirmSessionDelete");
  });

  it("keeps the agent header action icons aligned with automation card icon buttons", () => {
    const page = readPageSource();
    const styles = readStylesSource();
    const actionButtonStyles = styles.slice(
      styles.indexOf(".lv-agent-action-button {"),
      styles.indexOf(".lv-agents-nav {"),
    );
    const restartAction = page.slice(
      page.indexOf('aria-label={restartTooltip}'),
      page.indexOf('aria-label={deleteTooltip}'),
    );

    expect(page).toContain('const restartTooltip = activeBot.status === "failed" ? t("修复 Bot") : t("重启")');
    expect(page).toContain("activeBot.isDefault && remainingInstanceBotCount > 0");
    expect(page).toContain('t("请先删除其他 Bot，再删除主 Bot")');
    expect(page).toContain('activeBot.isDefault ? t("删除整个 Agent") : t("删除 Bot")');
    expect(restartAction).toContain('isActiveBotRestarting || isRepairingBot ? (');
    expect(restartAction).toContain('<Loader2 className="h-3.5 w-3.5 animate-spin"');
    expect(restartAction).toContain('activeBot.status === "failed" ? (');
    expect(restartAction).toContain('<RefreshCw className="h-3.5 w-3.5"');
    expect(restartAction).toContain('<RestartIcon className="h-4 w-4"');
    expect(page).toContain('<WorkspaceActionTooltip content={restartTooltip} side="bottom" compact focusable={false}>');
    expect(page).toContain('<WorkspaceActionTooltip content={deleteTooltip} side="bottom" compact focusable={false}>');
    expect(restartAction).not.toContain('className="lv-agent-action-tooltip"');
    expect(page).toContain('className="h-3.5 w-3.5"');
    expect(actionButtonStyles).toContain("cursor: pointer;");
    expect(actionButtonStyles).toContain("background: transparent;");
    expect(actionButtonStyles).toContain("background: rgb(0 0 0 / 4%);");
    expect(actionButtonStyles).toContain("box-shadow: 0 0 0 2px rgb(0 0 0 / 15%);");
  });

  it("keeps the Bot delete confirmation explicit about data loss", () => {
    const page = readPageSource();
    const multiBotDeleteDialog = page.slice(page.indexOf("{showDeleteConfirm && activeBot"));

    expect(page).toContain('t("风险提示：")');
    expect(page).toContain('className="block font-semibold"');
    expect(page).toContain("max-w-[28rem]");
    expect(page).toContain('t("删除后，整个 Agent 的会话、配置、已安装技能和记忆等数据将无法恢复。请谨慎操作！")');
    expect(page).toContain('t("删除后，当前 Bot 的会话、配置、已安装技能和记忆等数据将无法恢复。请谨慎操作！")');
    expect(page).toContain("rounded-xl border border-red-100 bg-red-50/70");
    expect(multiBotDeleteDialog).not.toContain('t("已购买的套餐不受影响，不会因删除智能体而失效。")');
    expect(page).toContain('t("确认删除 Agent")');
    expect(page).toContain('t("确认删除 Bot")');
  });

  it("keeps the chat panel rendering decoupled from the sidebar tab", () => {
    const page = readPageSource();

    // 主区渲染条件仍只看 activeSection（路由），与 sidebarTab 无关。
    expect(page).toContain('activeSection === "chat" &&');
    expect(page).not.toContain('sidebarTab === "chat" && activeSection');
  });

  it("resets session state when the agent instance switches", () => {
    const page = readPageSource();

    // SDK 对接注意事项 3：实例切换时重置会话受控状态，防旧实例数据闪现。
    expect(page).toContain("[sdkInstance?.InstanceId]");
    expect(page).toMatch(/setChatSessions\(\[\]\);\s*\n\s*setChatSessionsLoading\(false\);\s*\n\s*setSelectedChatId\(undefined\);\s*\n\s*setChatSessionActions\(null\);/);
  });

  it("never uses truthiness to test chatId validity (empty string is a legal default session)", () => {
    const page = readPageSource();

    // SDK 对接注意事项 1：chatId === "" 是合法默认会话，判定只能用 == null / ===。
    expect(page).not.toMatch(/if \(chatId\)/);
    expect(page).not.toMatch(/if \(selectedChatId\)/);
    expect(page).toContain("if (chatId == null) return;");

    // 同一条约定必须覆盖菜单开合状态：用 truthiness 会让默认会话的菜单
    // 打开后无法通过点击外部 / Esc 关闭。
    expect(page).not.toMatch(/if \(!openSessionMenuChatId\)/);
    expect(page).toContain("if (openSessionMenuChatId == null) return undefined;");
  });

  // 产品决策：默认会话（chatId === ""）是列表兜底项，不可删除——「新增」按钮在
  // SDK 面板右上角，若删空列表用户会失去唯一的新增入口。宿主需显式守门，不能
  // 依赖 SDK 恰好用 truthiness 拦掉空串这一实现细节。
  it("keeps the default session non-deletable as the list fallback", () => {
    const page = readPageSource();

    expect(page).toContain('const canDeleteSession = (session: LightVelaSession) => session.chatId !== "";');
    // 菜单项禁用 + 说明原因，而不是让用户点了没反应。
    expect(page).toContain("const isDeletable = canDeleteSession(session);");
    expect(page).toContain("disabled={!chatSessionActions || !isDeletable}");
    expect(page).toContain('title={isDeletable ? undefined : t("默认会话不支持删除")}');
  });

  // 注意事项 2 的隐含要求：SDK 的 actions effect 依赖 onSessionActionsChange 的
  // **引用**，cleanup 会 onSessionActionsChange(null)。回调内联在 useMemo 里会让
  // 每次切换会话都把 chatSessionActions 置 null 再恢复，此刻点删除会静默失效。
  it("keeps multi-session callback identities stable across selectedChatId changes", () => {
    const page = readPageSource();

    expect(page).toContain("const handleChatSessionStateChange = useCallback<");
    expect(page).toContain("const handleChatSelectedChatIdChange = useCallback<");
    expect(page).toContain("const handleChatSessionActionsChange = useCallback<");

    // bridge 只能引用稳定回调，不能内联箭头函数。
    expect(page).toContain("onSessionStateChange: handleChatSessionStateChange,");
    expect(page).toContain("onSelectedChatIdChange: handleChatSelectedChatIdChange,");
    expect(page).toContain("onSessionActionsChange: handleChatSessionActionsChange,");

    const bridge = page.slice(
      page.indexOf("const chatMultiSessionBridge = useMemo<"),
      page.indexOf("const startSessionRename"),
    );
    expect(bridge).not.toMatch(/onSessionActionsChange: \(actions\) =>/);
    expect(bridge).not.toMatch(/onSessionStateChange: \(\{/);
  });

  // 空列表是正常状态（桥接未建立 / 实例单会话形态 / 尚无会话），三者对用户
  // 表现一致，都必须留有进聊天页的入口——消息收发不依赖会话协议。
  // 也不要在此渲染面向开发者的诊断文案：用户无从理解，也无权处置。
  it("keeps a usable chat entry on an empty session list without leaking diagnostics", () => {
    const page = readPageSource();

    const emptyBranch = page.slice(
      page.indexOf(") : chatSessions.length === 0 ? ("),
      page.indexOf("chatSessions.map((session) => {"),
    );

    expect(emptyBranch).toContain('title={t("默认对话")}');
    expect(emptyBranch).not.toContain("Hermes");
    expect(emptyBranch).not.toContain("chatSessionActions");
  });

  it("guards both the confirm-open and confirm-commit paths of session delete", () => {
    const page = readPageSource();

    // 入口守门：不可删时不弹确认框。
    expect(page).toMatch(/openSessionDeleteConfirm = \(session: LightVelaSession\) => \{\s*\n\s*if \(!canDeleteSession\(session\)\) return;/);
    // 提交守门：避免关掉弹窗却没真正删除的假成功。
    expect(page).toMatch(/if \(!canDeleteSession\(sessionToDelete\)\) \{[\s\S]*?setSessionToDelete\(null\);[\s\S]*?return;/);
    expect(page).toContain("chatSessionActions?.deleteSession(sessionToDelete.chatId);");
  });
});
