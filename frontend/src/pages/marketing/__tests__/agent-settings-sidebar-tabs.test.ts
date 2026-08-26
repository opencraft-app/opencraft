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

  it("only exposes rename in the session menu (SDK has no delete API yet)", () => {
    const page = readPageSource();

    expect(page).toContain('role="menuitem"');
    expect(page).toContain('t("重命名")');
    // SDK 1.4.0-beta.0 仅提供 renameSession。
    expect(page).toContain("renameSession");
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
  });
});
