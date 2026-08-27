import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 侧边栏「对话/设置」双 tab 改造守卫测试。
 *
 * 背景：对话入口从「使用」菜单组移到侧边栏顶部 tab；「对话」tab 渲染最近会话列表，
 * 数据来自 SDK 1.4.0-beta.0 的 multiSession 受控桥接。本测试做源码级守卫，
 * 防止后续改动悄悄回退这些结构性约定。
 */

const readPageSource = () =>
  readFileSync(join(process.cwd(), "src/pages/marketing/agent-settings-page.tsx"), "utf8");

const readChatPanelSource = () =>
  readFileSync(join(process.cwd(), "src/pages/marketing/agent-chat-panel.tsx"), "utf8");

describe("agent settings sidebar chat/settings tabs", () => {
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
    expect(page).toContain('aria-selected={sidebarTab === "chat"}');
    expect(page).toContain('aria-selected={sidebarTab === "settings"}');
  });

  it("navigates the main area on tab click (settings → last menu, chat → first session)", () => {
    const page = readPageSource();

    // 点「设置」：在对话页时回到前一个设置菜单（模块级记忆，跨 /agents/[section] 重挂载存活）。
    expect(page).toContain("handleSidebarSettingsTabClick");
    expect(page).toContain("let lastSettingsSection");
    expect(page).toContain("AGENT_SECTION_PATH_BY_ID[lastSettingsSection]");

    // 点「对话」：非对话页时进入 chat 页，并默认选中第一个会话。
    expect(page).toContain("handleSidebarChatTabClick");
    expect(page).toContain("setSelectedChatId(chatSessions[0]?.chatId)");
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
