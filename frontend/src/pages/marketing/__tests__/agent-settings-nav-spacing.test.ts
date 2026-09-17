import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
const page = readFileSync(
  join(process.cwd(), "src/pages/marketing/agent-settings-page.tsx"),
  "utf8",
);
const agentsPageClient = readFileSync(
  join(process.cwd(), "next-site/agents-page-client.tsx"),
  "utf8",
);
const appRouteShell = readFileSync(
  join(process.cwd(), "next-site/app-route-shell.tsx"),
  "utf8",
);
const loadingView = readFileSync(
  join(process.cwd(), "src/pages/marketing/agent-settings-loading-view.tsx"),
  "utf8",
);

function getBlockBody(source: string, marker: string): string | undefined {
  const markerStart = source.indexOf(marker);
  if (markerStart < 0) return undefined;

  const blockStart = source.indexOf("{", markerStart);
  if (blockStart < 0) return undefined;

  let depth = 1;
  for (let index = blockStart + 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(blockStart + 1, index);
  }

  return undefined;
}

describe("Agent settings navigation spacing", () => {
  it("keeps the desktop chat height chain within the viewport", () => {
    const chatPage = getBlockBody(styles, "\n  .lv-agent-chat-page {");
    const chatMain = getBlockBody(
      styles,
      "\n  .lv-agent-chat-page .lv-agent-settings-main {",
    );
    const chatShell = getBlockBody(
      styles,
      "\n  .lv-agent-chat-page .lv-agent-settings-shell {",
    );
    const chatContentChain = getBlockBody(
      styles,
      "\n  .lv-agent-chat-page .lv-agent-settings-grid,",
    );
    const chatContentChainStart = styles.indexOf(
      "\n  .lv-agent-chat-page .lv-agent-settings-grid,",
    );
    const chatContentChainSelectors = styles.slice(
      chatContentChainStart,
      styles.indexOf("{", chatContentChainStart),
    );
    const chatContentChainSelectorSet = chatContentChainSelectors
      .trim()
      .split(",")
      .map((selector) => selector.trim());

    expect(chatPage).toContain("height: 100dvh;");
    expect(chatPage).toContain("overflow: hidden;");
    expect(chatMain).toContain("display: flex;");
    expect(chatMain).toContain("min-height: 0;");
    expect(chatMain).toContain("overflow: hidden;");
    expect(chatShell).toContain("min-height: 0;");
    expect(chatShell).toContain("flex: 1;");
    expect(chatContentChainSelectorSet).toEqual([
      ".lv-agent-chat-page .lv-agent-settings-grid",
      ".lv-agent-chat-page .lv-agent-settings-content",
      ".lv-agent-chat-page ._lh-claw-bot-panel",
      ".lv-agent-chat-page ._lh-claw-bot-panel__cards",
    ]);
    expect(chatContentChain).toContain("height: 100%;");
    expect(chatContentChain).toContain("min-height: 0;");
  });

  it("keeps the scroll-locked desktop sidebar within the viewport", () => {
    const lockedSidebar = getBlockBody(
      styles,
      "body[data-scroll-locked] .lv-agents-sidebar-scroll-isolated",
    );
    const chatSidebar = getBlockBody(
      styles,
      "\n  .lv-agent-chat-page .lv-agents-sidebar {",
    );
    const desktopSidebar = getBlockBody(styles, "\n  .lv-agents-sidebar {");

    expect(lockedSidebar).toContain("position: fixed;");
    expect(desktopSidebar).toContain("height: calc(100dvh - 68px);");
    expect(chatSidebar ?? "").not.toContain("height: 100%;");
  });

  it("keeps the desktop Agent shell close to the viewport edge without widening shared settings pages", () => {
    const agentShell = getBlockBody(styles, "\n  .lw-settings-shell.lv-agent-settings-shell {");
    const agentMain = getBlockBody(styles, "\n  .lw-app-top-pad.lv-agent-settings-main {");
    const agentContent = getBlockBody(styles, "\n  .lv-agent-settings-content {");
    const agentHeaderShell = getBlockBody(styles, "\n  header.lv-agent-sidebar-header {");
    const agentHeader = getBlockBody(styles, "\n  header.lv-agent-sidebar-header > div {");

    /*
     * 这三个 class 在常规态必须生效，但创建期引导没有侧边栏，
     * 沿用会留下一块 264px 的空白竖条，所以按 hasSidebarLayout 条件化。
     * 断言「基类 + 条件类 + 条件本身」三者都在，避免例外被悄悄扩大。
     *
     * shouldShowDataLoading 是刻意放进条件里的第二个分支：页面级骨架屏画的
     * 就是侧边栏两列，而它渲染时 bot 还没加载完（hasSidebarLayout 仍为
     * false）。少了它，骨架屏会按居中窄容器 + 96px 顶距排版，而它前后的
     * 路由级加载壳（app-route-shell）与最终页面都是左对齐宽容器 + 68px，
     * 中间就会横竖双向跳一下。
     */
    expect(page).toContain('"lw-app-top-pad flex-grow bg-white pb-6"');
    expect(page).toContain('(hasSidebarLayout || shouldShowDataLoading) && "lv-agent-settings-main"');
    expect(page).toContain('"lw-settings-shell"');
    expect(page).toContain('(hasSidebarLayout || shouldShowDataLoading) && "lv-agent-settings-shell"');
    expect(page).toContain('className={hasSidebarLayout || shouldShowDataLoading ? "lv-agent-sidebar-header" : undefined}');
    // 聊天页铺满到底（来自 master），与上面的条件化并存
    expect(page).toContain('activeSection === "chat" && "lg:pb-0"');
    // 页面级骨架屏必须跟路由级加载壳用同一套几何，否则两段加载之间会跳
    expect(appRouteShell).toContain('className="lw-app-top-pad lv-agent-settings-main flex-grow bg-white pb-6"');
    expect(appRouteShell).toContain('className="lw-settings-shell lv-agent-settings-shell"');
    expect(page.match(/lg:grid-cols-\[248px_minmax\(0,1fr\)\]/g)).toHaveLength(1);
    expect(agentsPageClient).toContain(
      "className={isWorkbench ? undefined : 'lv-agent-sidebar-header'}",
    );
    expect(agentShell).toContain("width: min(1760px, calc(100vw - 32px));");
    expect(agentShell).toContain("margin-left: 16px;");
    expect(agentShell).toContain("margin-right: auto;");
    expect(agentHeaderShell).toContain("right: auto;");
    expect(agentHeaderShell).toContain("width: 264px;");
    expect(agentHeaderShell).toContain("height: 68px;");
    /*
     * header 刻意不画边框：border-right / border-bottom 会把 logo 框成一个
     * 孤立的小方块（侧边栏尚未加载或引导态下尤其明显）。跟侧边栏对齐靠
     * width:264px 就够了，不需要靠描边。
     */
    expect(agentHeaderShell).not.toContain("border-right:");
    expect(agentHeaderShell).toContain("border-bottom-color: transparent !important;");
    expect(agentHeader).toContain("height: 68px !important;");
    expect(agentHeader).toContain("max-width: none;");
    expect(agentHeader).toContain("padding-left: 16px !important;");
    expect(agentHeader).toContain("padding-right: 16px !important;");
    expect(agentMain).toContain("padding-top: 68px;");
    expect(agentContent).toContain("width: 100%;");
    expect(agentContent).toContain("max-width: 1280px;");
    expect(agentContent).toContain("margin-top: -24px;");
    expect(agentContent).toContain("margin-left: auto;");
    expect(agentContent).toContain("margin-right: auto;");
    /*
     * 内容区原本恒定 `lg:col-start-2`（给 248px 侧边栏让位）。引导态没有
     * 侧边栏，需要自己居中，所以改成条件类。这里断言「两个分支都在」，
     * 而不是放宽成只检查基类 —— 漏掉任一分支都会布局错位。
     */
    expect(page).toContain('"lv-agent-settings-content min-w-0"');
    expect(page).toContain('hasSidebarLayout ? "lg:col-start-2" : "mx-auto w-full max-w-[860px]"');
    // 创建 Loading 视图没有侧边栏问题，仍是固定写法
    expect(loadingView).toContain('className="lv-agent-settings-content min-w-0 lg:col-start-2"');
    expect(styles).toContain("width: min(1440px, calc(100vw - 160px));");
  });

  it("uses compact desktop spacing and preserves mobile hit areas", () => {
    const desktopSidebar = getBlockBody(styles, "\n.lv-agents-sidebar {");
    const desktopNavigation = getBlockBody(styles, "\n.lv-agents-nav {");
    const desktopItem = getBlockBody(styles, "\n.lv-agents-nav-item {");
    const profileName = getBlockBody(styles, "\n.lv-agent-profile-name {");
    const responsiveStyles = getBlockBody(styles, "@media (max-width: 1023px) {");
    const mobileNavigation = getBlockBody(responsiveStyles ?? "", "\n  .lv-agents-nav {");
    const mobileItem = getBlockBody(responsiveStyles ?? "", "\n  .lv-agents-nav-item {");

    expect(desktopSidebar).toContain("padding-bottom: 24px;");
    expect(desktopSidebar).toContain("padding-right: 12px;");
    expect(desktopNavigation).toContain("gap: 8px;");
    expect(desktopItem).toContain("height: 32px;");
    expect(profileName).toContain("font-size: 14px;");
    expect(profileName).toContain("line-height: 20px;");
    expect(mobileNavigation).toContain("gap: 12px;");
    expect(mobileItem).toContain("height: 36px;");
  });

  it("moves the desktop account menu to the bottom of the Agent sidebar", () => {
    const accountFooter = getBlockBody(styles, "\n.lv-agent-account-footer {");
    const desktopSidebar = getBlockBody(styles, "\n  .lv-agents-sidebar {");

    expect(page).toMatch(/<UserAvatarMenu\b[^>]*\bvariant="sidebar"[^>]*\/>/);
    expect(page).toContain("showDesktopUserMenu={false}");
    expect(agentsPageClient).toContain("showDesktopUserMenu={isWorkbench}");
    expect(accountFooter).toContain("margin-top: auto;");
    expect(accountFooter).toContain("padding-top: 8px;");
    expect(accountFooter).toContain("border-top: 1px solid #e9ecf1;");
    expect(styles).toContain("height: calc(100dvh - 68px);");
    expect(desktopSidebar).toContain("padding-top: 20px;");
  });

  it("keeps auth and data loading states on the final Agent shell geometry", () => {
    expect(appRouteShell).toContain('className="lv-agent-sidebar-header"');
    expect(appRouteShell).toContain('className="lw-app-top-pad lv-agent-settings-main flex-grow bg-white pb-6"');
    expect(appRouteShell).toContain('className="lw-settings-shell lv-agent-settings-shell"');
    expect(appRouteShell).toContain("<AgentSettingsLoadingContent />");
    expect(page).toContain("return <AgentSettingsLoadingContent />;");
    expect(loadingView).toContain('lg:grid-cols-[248px_minmax(0,1fr)]');
    expect(loadingView).toContain('className="lv-agents-sidebar lv-agents-sidebar-scroll-isolated"');
    expect(loadingView).toContain('className="lv-agent-account-footer hidden lg:flex"');
    expect(loadingView).not.toContain('lg:top-[84px]');
  });

  it("keeps the requested desktop sidebar separators and bottom actions aligned", () => {
    const profileSeparator = getBlockBody(styles, "\n.lv-agent-profile-wrap {");
    const feedbackLink = getBlockBody(styles, "\n.lv-agent-feedback-link {");
    const desktopFeedbackLink = getBlockBody(styles, "\n  .lv-agent-feedback-link {");
    const adjacentAccountFooter = getBlockBody(
      styles,
      "\n  .lv-agent-feedback-link + .lv-agent-account-footer {",
    );
    const accountSeparator = getBlockBody(styles, "\n.lv-agent-account-footer {");
    const desktopScrollContainer = getBlockBody(
      styles,
      "\n  .lv-agents-sidebar-scroll-isolated {",
    );

    expect(profileSeparator).toContain("width: calc(100% + 12px);");
    expect(profileSeparator).toContain("padding-bottom: 8px;");
    expect(profileSeparator).not.toContain("border-bottom:");
    expect(feedbackLink).toContain("width: calc(100% + 12px);");
    expect(feedbackLink).not.toContain("border-top:");
    expect(desktopFeedbackLink).toContain("margin-top: auto;");
    expect(adjacentAccountFooter).toContain("margin-top: 8px;");
    expect(accountSeparator).toContain("width: calc(100% + 12px + 16px);");
    expect(accountSeparator).toContain("margin-left: -16px;");
    expect(accountSeparator).toContain("padding-left: 16px;");
    expect(accountSeparator).toContain("border-top: 1px solid #e9ecf1;");
    expect(desktopScrollContainer).toContain("width: 264px;");
    expect(desktopScrollContainer).toContain("margin-left: -16px;");
    expect(desktopScrollContainer).toContain("padding-left: 16px;");
    expect(desktopScrollContainer).toContain("overflow-x: hidden;");
  });

});
