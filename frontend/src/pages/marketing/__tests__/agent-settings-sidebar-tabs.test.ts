import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 侧边栏「日常/探索」双 tab 守卫测试。
 *
 * 背景：对话入口与最近会话列表位于「日常」tab，
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
  it("shows additional Bot creation without show() while preserving feature and quota gates", () => {
    const page = readPageSource();
    expect(page).toContain("const [showHiddenAgentTools, setShowHiddenAgentTools] = useState(false);");
    expect(page).toContain("{multiBotEnabled && !isSidebarCollapsed && (");
    expect(page).toContain('content={createLimitMessage || t("新建 Bot")}');
    expect(page).toContain("disabled={!canCreateAdditionalBot}");
    expect(page).toContain("!isCreating && !botsLoading");
    expect(page).toContain("!showMultiBotOnboarding && visibleBots.length === 0");
    expect(page).toContain("disabled={!canCreateInitialAgent || directCreating}");
    expect(page).not.toContain("const canCreateBot = multiBotEnabled");
    // showHiddenAgentTools 仍用于其它隐藏工具，不应被顺手删掉
    expect(page).toContain("const [showHiddenAgentTools, setShowHiddenAgentTools] = useState(false);");
  });

  it("routes the first Bot through the onboarding panel, not the legacy dialog", () => {
    const page = readPageSource();
    const initialCreation = page.slice(
      page.indexOf("const handleCreateNew"),
      page.indexOf("const handleOnboardingCreateBot"),
    );
    const noActiveBotBranch = initialCreation.slice(
      initialCreation.indexOf("if (!activeBot)"),
    );

    /*
     * 首个 bot 曾经走「只问名字」的旧弹窗 —— 新用户第一次建 bot 恰好落在
     * 这条分支，于是看到的还是老交互。现在统一进创建引导（可选头像、填
     * 描述、挑模板）。
     *
     * 双站引导上线后，旧弹窗仍作为开关关闭时的回落保留，所以不能再
     * 断言「源码里不存在 setShowCreateConfirm」。改为守住真正的约束：
     * 引导必须由 IS_BUDDY_ONBOARDING_ENABLED 把关，旧弹窗只能在 else 分支里。
     * 这样启用引导后如果被改回旧弹窗，这条仍然会红。
     */
    expect(noActiveBotBranch).toContain("setShowMultiBotOnboarding(true)");
    expect(noActiveBotBranch).toContain("if (IS_BUDDY_ONBOARDING_ENABLED) {");
    const legacyIndex = noActiveBotBranch.indexOf("setShowCreateConfirm(true)");
    const onboardingIndex = noActiveBotBranch.indexOf("setShowMultiBotOnboarding(true)");
    // 旧弹窗必须出现在引导之后（即 else 分支），不能抢在引导路径前面
    expect(legacyIndex).toBeGreaterThan(onboardingIndex);
    // 未订阅仍先去订阅页，这个前置不能被绕过
    expect(noActiveBotBranch).toContain('navigate("/subscribe")');

    /*
     * 订阅回跳（?create=1）同样进引导，那是新用户订阅后的第一屏。
     * 双站启用引导，只有显式关闭开关才回落旧弹窗。
     */
    expect(page).toContain("if (IS_BUDDY_ONBOARDING_ENABLED) {\n      setShowMultiBotOnboarding(true);");

    /*
     * 首个 bot 的引导必须渲染在 `!isCreating && activeBot && sdkInstance`
     * 之外 —— 那时 activeBot 为 null，放里面永远渲染不到。
     *
     * 且挂载条件不含 activeBot：创建过程中新 bot 进入 visibleBots 会让它从空
     * 变真，若作为条件就会切换渲染分支、重挂载面板，用户得填第二遍表单。
     */
    expect(page).toContain("{showMultiBotOnboarding && !isModifying && (");
    expect(page).not.toContain("{showMultiBotOnboarding && activeBot ? (");
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

  it("conditionally explains how renewal can restore a paused Agent", () => {
    const page = readPageSource();
    const statusRow = page.slice(
      page.indexOf('className="lv-agent-status-row"'),
      page.indexOf("{passExpiryReminder", page.indexOf('className="lv-agent-status-row"')),
    );

    expect(page).toContain('const pausedStatusTooltip = activeBot.status === "paused"');
    expect(page).toContain('t("Agent 已暂停运行。如因套餐到期，续费后即可恢复使用。")');
    expect(statusRow).toContain(
      '<WorkspaceActionTooltip content={pausedStatusTooltip} side="bottom">',
    );
    expect(statusRow).toContain('className="lv-agent-status"');
  });

  it("uses the avatar status indicator on both sites without an online subtitle", () => {
    const page = readPageSource();
    const profile = page.slice(
      page.indexOf('className="lv-agent-avatar lv-agent-avatar--status"'),
      page.indexOf('className="lv-agents-sidebar-controls"'),
    );
    const avatar = profile.slice(
      profile.indexOf('className="lv-agent-avatar lv-agent-avatar--status"'),
      profile.indexOf('className="lv-agent-profile-text"'),
    );
    const statusRowCondition = profile.slice(
      profile.indexOf('className="lv-agent-profile-name"'),
      profile.indexOf('className="lv-agent-status-row"'),
    );

    expect(avatar).toContain('"lv-agent-avatar-status"');
    expect(avatar).not.toContain("!isGlobal");
    expect(statusRowCondition).toContain('activeBot.status !== "running"');
    expect(statusRowCondition).not.toContain("isGlobal ||");
  });

  it("removes the legacy SHOW_AGENTCHAT_ENTRY gate", () => {
    expect(readPageSource()).not.toContain("SHOW_AGENTCHAT_ENTRY");
  });

  it("renders the daily and explore tabs above navigation", () => {
    const page = readPageSource();
    const tabsStart = page.indexOf("lv-agents-sidebar-tabs");
    const navStart = page.indexOf('className="lv-agents-sidebar-middle"');

    expect(tabsStart).toBeGreaterThanOrEqual(0);
    expect(navStart).toBeGreaterThan(tabsStart);
    expect(page).toContain('role="tablist"');
    expect(page).toContain('aria-selected={sidebarTab === "daily"}');
    expect(page).toContain('aria-selected={sidebarTab === "explore"}');
  });

  it("labels the top-level modes as daily and explore", () => {
    const page = readPageSource();
    const tabs = page.slice(
      page.indexOf("lv-agents-sidebar-tabs"),
      page.indexOf('className="lv-agents-sidebar-middle"'),
    );

    expect(tabs).toContain('t("日常")');
    expect(tabs).toContain('t("探索")');
    expect(tabs).not.toContain('role="tab"\n                              aria-selected={sidebarTab === "chat"}');
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

  it("translates the daily and explore tabs in every supported locale", () => {
    const exploreKey = readGeneratedDictionary("zh-to-key")["探索"];
    const dailyKey = readGeneratedDictionary("zh-to-key")["日常"];
    const expectedByLocale = {
      "zh-CN": { explore: "探索", daily: "日常" },
      "zh-Hant": { explore: "探索", daily: "日常" },
      "en-US": { explore: "Explore", daily: "Daily" },
      "id-ID": { explore: "Jelajahi", daily: "Sehari-hari" },
      es: { explore: "Explorar", daily: "Uso diario" },
      "ja-JP": { explore: "探索", daily: "日常" },
      "ko-KR": { explore: "탐색", daily: "일상" },
    } as const;

    expect(exploreKey).toBeDefined();
    expect(dailyKey).toBeDefined();
    for (const [locale, expected] of Object.entries(expectedByLocale)) {
      const dictionary = readGeneratedDictionary(locale);
      expect(dictionary[exploreKey!]).toBe(expected.explore);
      expect(dictionary[dailyKey!]).toBe(expected.daily);
    }
  });

  it("places skills under daily before automations; workbench lives in labs", () => {
    const page = readPageSource();
    const dailyGroupStart = page.indexOf('id: "daily"');
    const growthGroupStart = page.indexOf('id: "growth"');
    const dailyGroup = page.slice(dailyGroupStart, growthGroupStart);

    expect(dailyGroup).toContain('id: "skill"');
    expect(dailyGroup.indexOf('id: "skill"')).toBeLessThan(
      dailyGroup.indexOf('id: "automations"'),
    );
    expect(dailyGroup).not.toContain('id: "website"');
    expect(dailyGroup).not.toContain('id: "model"');
  });

  it("restores the last page of each tab", () => {
    const page = readPageSource();

    expect(page).toContain("handleSidebarExploreTabClick");
    expect(page).toContain("handleSidebarDailyTabClick");
    expect(page).toContain("AGENT_SECTION_PATH_BY_ID[lastExploreSection]");
    expect(page).toContain("AGENT_SECTION_PATH_BY_ID[target]");
  });

  it("shows OpenCraft Chat by default on both sites", () => {
    const page = readPageSource();
    const styles = readStylesSource();

    expect(page).toContain("const openCraftChatEnabled = true;");
    expect(page).toContain("locale={locale}");
    expect(page).toContain("const isActiveBotChatAvailable = openCraftChatEnabled;");
    expect(page).toContain("const sidebarSessionBotKey = openCraftChatEnabled && activeBot && accountId");
    expect(page).toContain('{openCraftChatEnabled && <div className="lv-agents-nav-group lv-agents-chat-group"');
    expect(page).toContain('lastDailySection === "chat" && !isActiveBotChatAvailable ? "channel" : lastDailySection');
    expect(page).toContain("const isChatTabDisabled = !isActiveBotChatAvailable || showBuddyOnboarding;");
    expect(page).toContain('aria-disabled="true" tabIndex={0}');
    expect(page).not.toContain('t("对话功能目前仅支持主 Bot")');
    expect(page).toContain('side="bottom"');
    expect(styles).not.toContain(".lv-agent-action-tooltip {");
    expect(page).toContain('!consoleShowStateReady || activeSection !== "chat" || !activeBot || isActiveBotChatAvailable');
    expect(page).toContain('{isActiveBotChatAvailable && (');
    expect(page).toContain('&& !openCraftChatEnabled');
    expect(page).toContain('enabled={openCraftChatEnabled}');
    expect(page).toContain('profileId={activeBot.profileId ?? (isActiveBotDefault ? "main" : "")}');
    expect(page).toContain("setConsoleShowStateReady(true);");
    expect(page).toContain("enableShowCommand: true");
    expect(styles).toContain(".lv-agents-sidebar-tab:disabled");
  });

  it("derives the initial tab from the current route", () => {
    expect(readPageSource()).toContain(
      'EXPLORE_SECTION_IDS.has(activeSection) ? "explore" : DAILY_SECTION_IDS.has(activeSection) ? "daily" : lastSidebarTab',
    );
  });

  it("renders an expandable chat header with a create action and session icons under daily", () => {
    const page = readPageSource();

    expect(page).toContain('sidebarTab === "daily"');
    expect(page).toContain('className="lv-agents-chat-header"');
    expect(page).toContain('const [chatSessionsExpanded, setChatSessionsExpanded] = useState(true)');
    expect(page).toContain('aria-expanded={chatSessionsExpanded}');
    expect(page).toContain('className="lv-agents-chat-create"');
    expect(page).toContain('<WorkspaceActionTooltip content={t("新建对话")} compact focusable={false} className="shrink-0">');
    expect(page).toContain('aria-label={t("新建对话")}');
    expect(page).not.toContain('title={t("新会话")}');
    expect(page).toContain('pendingNewChatSessionBotId = activeBot.id');
    expect(page).toContain('chatSessionCommands.createSession()');
    expect(page).toContain("chatSessionPagination.visibleSessions.map");
    expect(page).toContain('<span className="lv-agents-nav-icon"><MessageSquare className="h-4 w-4" aria-hidden="true" /></span>');
    expect(page).toContain('!isChatTabDisabled && chatSessionsExpanded && !isSidebarCollapsed');
  });

  it("places the create action beside the Bot card and the switcher after delete", () => {
    const page = readPageSource();
    const profileRow = page.slice(page.indexOf('className="lv-agent-profile-row"'), page.indexOf('className="lv-agents-sidebar-controls"'));
    const profile = profileRow.slice(0, profileRow.indexOf('className="lv-agent-create-bot-action"'));
    const createAction = profileRow.slice(profileRow.indexOf('className="lv-agent-create-bot-action"'));

    expect(profile).toContain("setShowRestartConfirm(true)");
    expect(profile).toContain("setShowDeleteConfirm(true)");
    expect(profile).toContain("<RefreshCw");
    expect(profile).toContain("<Trash2");
    expect(profile).not.toContain('aria-label={t("新建 Bot")}');
    expect(createAction).toContain('aria-label={t("新建 Bot")}');
    expect(createAction).toContain('<Plus className="h-4 w-4" aria-hidden="true" />');
    expect(profileRow.indexOf("</Popover>")).toBeLessThan(profileRow.indexOf('className="lv-agent-create-bot-action"'));
    expect(profile.indexOf("<RestartIcon")).toBeLessThan(profile.indexOf("<Trash2"));
    expect(profile).not.toContain("<MoreHorizontal");
    expect(page).toMatch(/\{visibleBots.length > 1 && \(\s*<ChevronDown/);
    const switcherChevron = page.search(/<ChevronDown\s+aria-hidden="true"/);
    expect(switcherChevron).toBeGreaterThan(page.indexOf("<Trash2"));
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
    expect(readPageSource()).toContain('"h-4 w-4 flex-shrink-0 text-black/35 transition-transform"');
    expect(readPageSource()).not.toContain('"-ml-2 h-4 w-4 flex-shrink-0 text-black/35 transition-transform"');
  });

  it("creates another Bot inside an existing instance without requiring a new subscription", () => {
    const page = readPageSource();

    expect(page).toContain("if (!activeBot)");
    // 已有 bot 时走引导，不再经旧弹窗
    expect(page).toContain("setShowMultiBotOnboarding(true)");
    /*
     * 旧弹窗不再是「无任何触发点」—— 它仍是引导开关关闭时的回落。
     * 但它的每一个触发点都必须被 IS_BUDDY_ONBOARDING_ENABLED 的 else 分支
     * 包住，数量上与引导触发点一一对应；否则说明有入口绕过了开关。
     */
    const onboardingCalls = page.match(/setShowMultiBotOnboarding\(true\)/g)?.length ?? 0;
    const legacyCalls = page.match(/setShowCreateConfirm\(true\)/g)?.length ?? 0;
    expect(onboardingCalls).toBeGreaterThanOrEqual(3);
    expect(legacyCalls).toBe(onboardingCalls);
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
    expect(readGeneratedDictionary("en-US").k_43ea9a84).toBe("Basic setup");
    expect(page.match(/grid-cols-\[max-content_minmax\(0,1fr\)\]/g)).toHaveLength(2);
    expect(page).toContain('<dt className="whitespace-nowrap font-medium text-black/70">{t("继承")}</dt>');
    expect(page).toContain('t("模型、人设、技能、用户偏好和长期记忆")');
    expect(page).toContain('<dt className="whitespace-nowrap font-medium text-black/70">{t("不继承")}</dt>');
    expect(page).toContain('t("当前对话、历史会话、定时任务、运行状态或通道连接")');
    expect(page).toContain('t("主 Bot 当前主模型及其 Provider 凭据")');
    expect(page).toContain('<dt className="whitespace-nowrap font-medium text-black/70">Skills</dt>');
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

  it("shows a default-chat entry after a running Bot confirms an empty list", () => {
    const page = readPageSource();

    // 运行中确认空列表后仍可进入聊天；暂停时则不显示无效的空态入口。
    expect(page).toContain('emptyChatSessionState === "default" ? (');
    expect(page).toContain('AGENT_SECTION_PATH_BY_ID.chat');
  });

  it("wires the OpenCraft multiSession controlled bridge", () => {
    const page = readPageSource();

    expect(page).toContain("openCraftChatMultiSessionBridge");
    expect(page).toContain("multiSession={openCraftChatMultiSessionBridge}");
    expect(page).toContain("legacy={null}");
    expect(page).not.toContain("<AgentChatPanel");
    expect(page).not.toContain("agentchat/launch-token");
  });

  it("fills the available desktop layout while preserving the compact panel height", () => {
    const chatPanel = readChatPanelSource();

    expect(chatPanel).toContain(
      "h-[clamp(516px,calc(100vh-220px),960px)]",
    );
    expect(chatPanel).toContain("lg:h-full");
  });

  it("marks the active chat route and removes its page padding", () => {
    const page = readPageSource();

    expect(page).toContain('activeSection === "chat" && "lv-agent-chat-page"');
    expect(page).toContain('useMobileChatLayout ? "pb-0" : "pb-6"');
    expect(page).toContain('activeSection === "chat" && "lg:pb-0"');
    /*
     * lv-agent-settings-main / -shell / 栅格列这三处本分支按
     * hasSidebarLayout || shouldShowDataLoading 条件化了（引导态没有侧边栏，
     * 骨架屏则要跟最终页面保持同一套几何），所以不再是 master 那种
     * 写死在字符串里的形式。这里断言「类名仍在 + 条件仍在」，
     * 具体几何由 agent-settings-nav-spacing 那条守。
     */
    expect(page).toContain('(hasSidebarLayout || shouldShowDataLoading) && "lv-agent-settings-main"');
    expect(page).toContain("lv-agent-settings-grid grid items-start");
    expect(page).toContain('activeSection === "chat" && openCraftChatEnabled ? "gap-y-0 lg:gap-y-6" : "gap-6"');
    expect(page).toContain('hasSidebarLayout && !embedded && (isSidebarCollapsed ? "lg:grid-cols-[56px_minmax(0,1fr)]" : "lg:grid-cols-[248px_minmax(0,1fr)]")');
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

  it("shows activity only for a session reported as running", () => {
    const page = readPageSource();
    const styles = readStylesSource();
    const sessions = page.slice(page.indexOf("chatSessionPagination.visibleSessions.map((session) => {"), page.indexOf("chatSessionMutationState !== null"));

    expect(sessions).toContain('const isRunning = "running" in session && session.running === true;');
    expect(sessions).toContain('isRunning ? <span className="lv-agents-session-running" role="img" aria-label={t("执行中")} /> : null');
    expect(styles).toContain("@media (prefers-reduced-motion: reduce) {\n  .lv-agents-session-running { animation: none; }");
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

  it("isolates the visible list by Bot and resets session actions when the instance switches", () => {
    const page = readPageSource();

    // 列表按账号、实例和 Profile 隔离；操作句柄仍须在实例切换时失效。
    expect(page).toContain("const sidebarSessionBotKey = openCraftChatEnabled && activeBot && accountId");
    expect(page).toContain("useAgentSidebarSessionList(sidebarSessionBotKey)");
    expect(page).toContain("[sdkInstance?.InstanceId, sdkInstance?.ProfileId, chatSessionPagination.reset]");
    expect(page).toMatch(/setChatSessionsHasMore\(false\);\s*\n\s*setChatSessionMutationState\(null\);\s*\n\s*setSelectedChatId\(undefined\);\s*\n\s*setChatSessionActions\(null\);/);
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
    expect(page).toContain("disabled={!chatSessionActions || chatSessionMutationState?.pending === true || !isDeletable}");
    expect(page).toContain('title={isDeletable ? undefined : t("默认会话不支持删除")}');
  });

  // actions effect 依赖 onSessionActionsChange 的引用。回调内联在 useMemo 里会让
  // 每次切换会话都把 chatSessionActions 置 null 再恢复，此刻点删除会静默失效。
  it("keeps multi-session callback identities stable across selectedChatId changes", () => {
    const page = readPageSource();

    expect(page).toContain("onSessionStateChange: applyChatSessionState,");
    expect(page).toContain("const applyChatSelectedChatId = useCallback<");
    expect(page).toContain("const applyChatSessionActions = useCallback<");

    // bridge 只能引用稳定回调，不能内联箭头函数。
    expect(page).toContain("onSessionStateChange: applyChatSessionState,");
    expect(page).toContain("onSelectedChatIdChange: applyChatSelectedChatId,");
    expect(page).toContain("onSessionActionsChange: applyChatSessionActions,");

    const bridge = page.slice(
      page.indexOf("const openCraftChatMultiSessionBridge = useMemo<"),
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
      page.indexOf(') : emptyChatSessionState === "default" ? ('),
      page.indexOf("chatSessionPagination.visibleSessions.map((session) => {"),
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
