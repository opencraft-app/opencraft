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
const sidebar = readFileSync(join(process.cwd(), "src/components/site/agent-sidebar.tsx"), "utf8");

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
    expect(page).toContain('"lw-app-top-pad flex-grow bg-white"');
    expect(page).toContain('useMobileChatLayout ? "pb-0" : "pb-6"');
    expect(page).toContain('(hasSidebarLayout || shouldShowDataLoading) && "lv-agent-settings-main"');
    expect(page).toContain('"lw-settings-shell"');
    expect(page).toContain('(hasSidebarLayout || shouldShowDataLoading) && "lv-agent-settings-shell"');
    /*
     * header 的 className 从三元式换成了 cn()：除了「是否套侧边栏表头」，
     * 还要叠加引导态的 --borderless 标记，两个条件互不相干。
     */
    expect(page).toContain('(hasSidebarLayout || shouldShowDataLoading) && "lv-agent-sidebar-header"');
    // 聊天页铺满到底（来自 master），与上面的条件化并存
    expect(page).toContain('activeSection === "chat" && "lg:pb-0"');
    // 页面级骨架屏必须跟路由级加载壳用同一套几何，否则两段加载之间会跳
    expect(appRouteShell).toContain('className="lw-app-top-pad lv-agent-settings-main flex-grow bg-white pb-6"');
    expect(appRouteShell).toContain('className="lw-settings-shell lv-agent-settings-shell"');
    expect(page.match(/lg:grid-cols-\[248px_minmax\(0,1fr\)\]/g)).toHaveLength(1);
    expect(agentsPageClient).toContain("<AgentSidebarToggle collapsed={collapsed} onToggle={toggle} />");
    expect(agentsPageClient).toContain("sidebarCollapsed={collapsed}");
    expect(agentsPageClient).toContain("lv-agent-sidebar-header--motion-pending");
    expect(agentShell).toContain("width: calc(100% - 40px);");
    expect(agentShell).toContain("margin-left: 16px;");
    expect(agentShell).toContain("margin-right: 24px;");
    expect(agentHeaderShell).toContain("right: auto;");
    expect(agentHeaderShell).toContain("width: 264px;");
    expect(agentHeaderShell).toContain("height: 68px;");
    /*
     * 常规 agent 页的 header 要画边框 —— 它和侧边栏的分隔线是连着的，
     * 去掉会让 logo 那一格和下方侧边栏断开。
     *
     * 只有创建 / 引导态是例外：那时右侧没有侧边栏，这两条边会把 logo
     * 框成一个孤立的小方块。用根节点 class 把例外圈出来，而不是把常规态
     * 的边框一起砍了（之前就是这么改过头的）。
     *
     * 关键：这条路由的 header 由 next-site/agents-page-client.tsx 渲染，
     * 传给 AgentSettingsPage 的是 showHeader={false} —— 页面内那个 header
     * 在这条路由上根本不渲染。所以只改页面内的 className 是无效的，必须
     * 走 <html class="lv-agent-onboarding"> 才能作用到真正生效的那个
     * header 上。上一轮就是漏了这一层，改完线框依旧在。
     */
    expect(agentHeaderShell).toContain("border-right: 1px solid #e9ecf1;");
    expect(agentHeaderShell).toContain("border-bottom-color: #e9ecf1 !important;");
    expect(agentsPageClient).toContain("showHeader={false}");
    expect(styles).toContain(".lv-agent-onboarding header.lv-agent-sidebar-header,");
    // 三个引导标记都要算进去，漏一个那条路径下 logo 还是会被框住
    expect(page).toContain("const isOnboardingVisible = showEarlyOnboarding");
    expect(page).toContain("|| showBuddyOnboarding");
    expect(page).toContain("|| showMultiBotOnboarding;");
    expect(page).toContain('root.classList.toggle("lv-agent-onboarding", isOnboardingVisible);');
    expect(page).toContain(
      '(showBuddyOnboarding || showMultiBotOnboarding) && "lv-agent-sidebar-header--borderless"',
    );
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
    expect(page).toContain('hasSidebarLayout && !embedded ? "lg:col-start-2" : "mx-auto w-full max-w-[860px]"');
    // 创建 Loading 视图没有侧边栏问题，仍是固定写法
    expect(loadingView).toContain('className="lv-agent-settings-content min-w-0 lg:col-start-2"');
    expect(styles).toContain("width: min(1440px, calc(100vw - 160px));");
  });

  it("uses compact desktop spacing and preserves mobile hit areas", () => {
    const desktopSidebar = getBlockBody(styles, "\n.lv-agents-sidebar {");
    const desktopNavigation = getBlockBody(styles, "\n.lv-agents-nav {");
    const desktopItem = getBlockBody(styles, "\n.lv-agents-nav-item {");
    const profileName = getBlockBody(styles, "\n.lv-agent-profile-name {");
    const desktopMediaStart = styles.lastIndexOf("@media (min-width: 1024px) {");
    const desktopStyles = desktopMediaStart < 0
      ? undefined
      : getBlockBody(styles.slice(desktopMediaStart), "@media (min-width: 1024px) {");
    const desktopMiddleNavigation = getBlockBody(
      desktopStyles ?? "",
      "\n  .lv-agents-sidebar-middle .lv-agents-nav {",
    );
    const desktopMiddle = getBlockBody(
      desktopStyles ?? "",
      "\n  .lv-agents-sidebar-middle {",
    );
    const desktopMiddleGroupItems = getBlockBody(
      desktopStyles ?? "",
      "\n  .lv-agents-sidebar-middle .lv-agents-nav-group-items {",
    );
    const desktopMiddleItem = getBlockBody(
      desktopStyles ?? "",
      "\n  .lv-agents-sidebar-middle .lv-agents-nav-item {",
    );
    const desktopProfile = getBlockBody(desktopStyles ?? "", "\n  .lv-agents-sidebar-profile .lv-agent-profile {");
    const desktopProfileName = getBlockBody(desktopStyles ?? "", "\n  .lv-agents-sidebar-profile .lv-agent-profile-name {");
    const responsiveStyles = getBlockBody(styles, "@media (max-width: 1023px) {\n  .lv-agents-sidebar {");
    const mobileNavigation = getBlockBody(responsiveStyles ?? "", "\n  .lv-agents-nav {\n    gap:");
    const mobileItem = getBlockBody(responsiveStyles ?? "", "\n  .lv-agents-nav-item {");

    expect(desktopSidebar).toContain("padding-bottom: 24px;");
    expect(desktopSidebar).toContain("padding-right: 12px;");
    expect(desktopNavigation).toContain("gap: 8px;");
    expect(desktopSidebar).toContain("--lv-agents-nav-item-height: 30px;");
    expect(desktopItem).toContain("height: var(--lv-agents-nav-item-height);");
    expect(profileName).toContain("font-size: 14px;");
    expect(profileName).toContain("line-height: 20px;");
    expect(desktopProfile).toContain("min-height: 40px;");
    expect(desktopProfileName).toContain("font-size: 13px;");
    expect(desktopProfileName).toContain("line-height: 18px;");
    expect(desktopMiddle).toContain("--lv-agents-nav-group-gap: 2px;");
    expect(desktopMiddle).toContain("--lv-agents-nav-item-gap: 0;");
    expect(desktopMiddleNavigation).toContain("gap: var(--lv-agents-nav-group-gap);");
    expect(desktopMiddleGroupItems).toContain("gap: var(--lv-agents-nav-item-gap);");
    expect(desktopMiddleItem).toContain("font-size: 13px;");
    expect(mobileNavigation).toContain("gap: 12px;");
    expect(mobileItem).toContain("height: 36px;");
    expect(styles).toContain("@media (min-width: 1024px) and (max-height: 860px)");
    expect(styles).toContain("--lv-agents-nav-item-height: 30px;");
    expect(styles).toContain("min-height: 48px;");
  });

  it("keeps overview spacing symmetric and matches the other desktop navigation text", () => {
    const desktopStyles = styles.slice(styles.lastIndexOf("@media (min-width: 1024px) {"));
    const sidebar = getBlockBody(desktopStyles, "\n  .lv-agents-sidebar {");
    const overviewSidebar = getBlockBody(desktopStyles, "\n  .lv-agents-sidebar:has(.lv-agent-overview-nav) {");
    const overview = getBlockBody(desktopStyles, "\n  .lv-agent-overview-nav {");
    const overviewItem = getBlockBody(desktopStyles, "\n  .lv-agent-overview-nav .lv-agents-nav-item {");
    const middleItem = getBlockBody(desktopStyles, "\n  .lv-agents-sidebar-middle .lv-agents-nav-item {");

    expect(sidebar).toContain("padding-top: 12px;");
    expect(overviewSidebar).toContain("padding-top: 0;");
    expect(overview).toContain("padding-block: 8px;");
    expect(page).toContain('className="lv-agent-overview-nav mb-2 pb-2 lg:mb-0 lg:pb-0"');
    expect(overviewItem).toContain("font-size: 13px;");
    expect(middleItem).toContain("font-size: 13px;");
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
    expect(desktopSidebar).toContain("padding-top: 12px;");
  });

  it("keeps auth and data loading states on the final Agent shell geometry", () => {
    expect(appRouteShell).toContain('className="lv-agent-sidebar-header"');
    expect(appRouteShell).toContain('className="lw-app-top-pad lv-agent-settings-main flex-grow bg-white pb-6"');
    expect(appRouteShell).toContain('className="lw-settings-shell lv-agent-settings-shell"');
    expect(appRouteShell).toContain("<AgentSettingsLoadingContent />");
    expect(page).toContain("return <AgentSettingsLoadingContent />;");
    expect(loadingView).toContain('lg:grid-cols-[248px_minmax(0,1fr)]');
    expect(loadingView).toContain('<AgentSidebar>');
    expect(page).toMatch(/<AgentSidebar\b/);
    expect(sidebar).toContain('className="lv-agents-sidebar lv-agents-sidebar-scroll-isolated"');
    for (const source of [loadingView, page]) {
      expect(source).toContain('className="lv-agents-sidebar-controls"');
      expect(source).toContain('className="lv-agents-sidebar-middle"');
      expect(source).toContain('className="lv-agents-sidebar-footer"');
    }
    expect(loadingView).toContain('className="lv-agent-account-footer hidden lg:flex"');
    expect(loadingView).not.toContain('lg:top-[84px]');
  });

  it("keeps the requested desktop sidebar separators and bottom actions aligned", () => {
    const profileSeparator = getBlockBody(styles, "\n.lv-agent-profile-wrap {");
    const desktopProfile = getBlockBody(styles, "\n  .lv-agents-sidebar-profile .lv-agent-profile-wrap {");
    const controls = getBlockBody(styles, "\n  .lv-agents-sidebar-controls {");
    const middle = getBlockBody(styles, "\n  .lv-agents-sidebar-middle {");
    const accountSeparator = getBlockBody(styles, "\n.lv-agent-account-footer {");
    const desktopScrollContainer = getBlockBody(
      styles,
      "\n  .lv-agents-sidebar-scroll-isolated {",
    );

    expect(profileSeparator).toContain("width: auto;");
    expect(profileSeparator).toContain("padding-bottom: 8px;");
    expect(profileSeparator).not.toContain("border-bottom:");
    expect(desktopProfile).toContain("padding: 3px 8px;");
    expect(controls).toContain("padding-top: 16px;");
    expect(middle).toContain("padding-top: var(--lv-agents-sidebar-middle-padding-block);");
    expect(styles).toContain('.lv-agents-sidebar[data-scroll-above="true"] .lv-agents-sidebar-controls::after');
    for (const source of [page, loadingView, styles]) {
      expect(source).not.toContain("lv-agent-feedback-link");
    }
    expect(accountSeparator).toContain("width: calc(100% + 12px + 16px);");
    expect(accountSeparator).toContain("margin-left: -16px;");
    expect(accountSeparator).toContain("padding-left: 16px;");
    expect(accountSeparator).toContain("border-top: 1px solid #e9ecf1;");
    expect(desktopScrollContainer).toContain("width: 264px;");
    expect(desktopScrollContainer).toContain("margin-left: 0;");
    expect(desktopScrollContainer).toContain("left: 0;");
    expect(desktopScrollContainer).toContain("overflow-y: hidden;");
    expect(getBlockBody(styles, "\n  .lv-agents-sidebar-middle {")).toContain("overflow-y: auto;");
    expect(getBlockBody(styles, "\n.lv-agent-account-menu {")).toContain("width: 100%;");
    expect(getBlockBody(styles, "\n.lv-agent-account-trigger {")).toContain("width: 100%;");
    expect(desktopScrollContainer).toContain("padding-left: 16px;");
    expect(desktopScrollContainer).toContain("overflow-x: hidden;");
  });

});
