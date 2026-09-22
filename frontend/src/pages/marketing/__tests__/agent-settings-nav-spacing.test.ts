import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
const consoleShell = readFileSync(join(process.cwd(), "src/pages/marketing/agents-console/console-shell.tsx"), "utf8");
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
  it("joins the 68px header to a fixed remaining-height sidebar with only its middle scrolling", () => {
    const sidebar = getBlockBody(styles, "\n  .lv-agents-sidebar-scroll-isolated {");
    const middle = getBlockBody(styles, "\n  .lv-agents-sidebar-middle {");
    const fixedSlots = getBlockBody(styles, "\n  .lv-agents-sidebar-profile,");
    const scrollbar = getBlockBody(styles, "\n  .lv-agents-sidebar-middle::-webkit-scrollbar {");
    expect(sidebar).toContain("position: fixed;");
    expect(sidebar).toContain("left: 0;");
    expect(sidebar).toContain("top: 68px;");
    expect(sidebar).toContain("max-height: calc(100dvh - 68px);");
    expect(sidebar).toContain("overflow: hidden;");
    expect(sidebar).not.toContain("overflow-y: auto;");
    expect(middle).toContain("flex: 1 1 auto;");
    expect(middle).toContain("min-height: 0;");
    expect(middle).toContain("overflow-y: auto;");
    expect(middle).toContain("scrollbar-width: none;");
    expect(scrollbar).toContain("display: none;");
    expect(fixedSlots).toContain("flex-shrink: 0;");
    const header = getBlockBody(styles, "\n  header.lv-agent-sidebar-header {");
    expect(header).toContain("background: #fff !important;");
    expect(sidebar).toContain("background: #fff;");
    expect(header).toContain("border-right: 1px solid #e9ecf1;");
    expect(header).toContain("border-right-color: #e9ecf1 !important;");
    expect(getBlockBody(styles, "\n.lv-agents-sidebar {")).toContain("border-right: 1px solid #e9ecf1;");
  });

  it("gives navigation and session links a clear selected color without weakening their text or icons", () => {
    const item = getBlockBody(styles, "\n\n.agents-ui .lv-agents-nav-item {");
    const active = getBlockBody(styles, "\n.agents-ui .lv-agents-nav-item.is-active {");
    const hover = getBlockBody(styles, "\n.agents-ui .lv-agents-nav-item:not(.is-active):hover {");
    const icon = getBlockBody(styles, "\n.agents-ui .lv-agents-nav-item .lv-agents-nav-icon {");
    expect(item).toContain("color: var(--text-secondary) !important;");
    expect(item).toContain("background: #fff;");
    expect(active).toContain("background: #f2f2ef !important;");
    expect(active).toContain("color: #171717 !important;");
    expect(active).toContain("font-weight: 600;");
    expect(active).not.toContain("opacity:");
    expect(hover).toContain("background: #f7f7f5 !important;");
    expect(icon).toContain("color: inherit;");
    // Desktop-specific overrides must not recolor the same links/icons.
    expect(styles).not.toContain(".lv-agents-sidebar-middle .lv-agents-nav-item.is-active {");
    expect(styles).not.toContain(".lv-agents-sidebar-middle .lv-agents-nav-icon {");
  });

  it("leaves Agents tabs to explicit component variants", () => {
    const track = getBlockBody(styles, '\n.agents-ui [role="tablist"] {');
    const active = getBlockBody(styles, '\n.agents-ui [role="tab"][data-state="active"] {');
    const hover = getBlockBody(styles, '\n.agents-ui [role="tab"][data-state="inactive"]:not(:disabled):hover {');
    expect(track).toBeUndefined();
    expect(active).toBeUndefined();
    expect(hover).toBeUndefined();
    expect(styles).not.toContain('.agents-ui [role="tab"][data-state="active"]');
  });

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

    expect(page).toContain('"lw-app-top-pad lv-agent-settings-main flex-grow bg-white pb-6",');
    expect(page).toContain('activeSection === "chat" && "lg:pb-0"');
    expect(page).toContain('<section className="lw-settings-shell lv-agent-settings-shell">');
    expect(page).toContain('className="lv-agent-sidebar-header"');
    expect(consoleShell.match(/lg:grid-cols-\[248px_minmax\(0,1fr\)\]/g)).toHaveLength(1);
    expect(page).toContain("<AgentConsoleShell");
    expect(agentsPageClient).toContain(
      "className={isWorkbench ? undefined : 'lv-agent-sidebar-header'}",
    );
    expect(agentShell).toContain("width: calc(100% - 40px);");
    expect(agentShell).toContain("margin-left: 16px;");
    expect(agentShell).toContain("margin-right: 24px;");
    expect(agentHeaderShell).toContain("right: auto;");
    expect(agentHeaderShell).toContain("width: 264px;");
    expect(agentHeaderShell).toContain("height: 68px;");
    expect(agentHeaderShell).toContain("border-right: 1px solid #e9ecf1;");
    expect(agentHeaderShell).toContain("border-bottom-color: #e9ecf1 !important;");
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
    expect(consoleShell).toContain('className="lv-agent-settings-content min-w-0 lg:col-start-2"');
    expect(loadingView).toContain('className="lv-agent-settings-content min-w-0 lg:col-start-2"');
    expect(styles).toContain("width: min(1440px, calc(100vw - 160px));");
  });

  it("uses compact desktop spacing and preserves mobile hit areas", () => {
    const desktopSidebar = getBlockBody(styles, "\n.lv-agents-sidebar {");
    const desktopNavigation = getBlockBody(styles, "\n.lv-agents-nav {");
    const desktopItem = getBlockBody(styles, "\n\n.agents-ui .lv-agents-nav-item {");
    const mobileNavigation = getBlockBody(styles, ".agents-ui.lv-agents-navigation-sheet .lv-agents-nav-group-items {");
    const mobileItem = getBlockBody(styles, ".agents-ui.lv-agents-navigation-sheet .lv-agents-nav-item {");

    expect(desktopSidebar).toContain("padding-bottom: 24px;");
    expect(desktopSidebar).toContain("padding-right: 12px;");
    expect(desktopNavigation).toContain("gap: 8px;");
    expect(desktopItem).toContain("min-height: 36px;");
    expect(desktopItem).toContain("overflow-wrap: anywhere;");
    expect(mobileNavigation).toContain("flex-direction: column;");
    expect(mobileItem).toContain("min-height: 40px;");
  });

  it("moves the desktop account menu to the bottom of the Agent sidebar", () => {
    const accountFooter = getBlockBody(styles, "\n.lv-agent-account-footer {");
    const accountMenu = getBlockBody(styles, "\n.lv-agent-account-menu {");
    const accountTrigger = getBlockBody(styles, "\n.lv-agent-account-trigger {");
    const desktopSidebar = getBlockBody(styles, "\n  .lv-agents-sidebar {");

    expect(page).toMatch(/<UserAvatarMenu\b[^>]*\bvariant="sidebar"[^>]*\/>/);
    expect(page).toContain("showDesktopUserMenu={false}");
    expect(agentsPageClient).toContain("showDesktopUserMenu={isWorkbench}");
    expect(accountFooter).toContain("margin-top: auto;");
    expect(accountFooter).toContain("padding-top: 8px;");
    expect(accountFooter).toContain("border-top: 1px solid #e9ecf1;");
    expect(accountMenu).toContain("width: 100%;");
    expect(accountMenu).not.toContain("width: var(--lv-agents-nav-width);");
    expect(accountTrigger).toContain("width: 100%;");
    expect(styles).toContain("height: calc(100dvh - 68px);");
    expect(desktopSidebar).toContain("padding-top: 12px;");
    expect(desktopSidebar).toContain("padding-bottom: max(12px, env(safe-area-inset-bottom));");
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
    expect(loadingView).toContain('className="lv-agent-profile-wrap lv-agents-sidebar-profile"');
    expect(loadingView).toContain('className="lv-agents-sidebar-middle"');
    expect(loadingView).toContain('className="lv-agents-sidebar-footer"');
  });

  it("removes the standalone feedback link while retaining desktop account alignment and separators", () => {
    const profileSeparator = getBlockBody(styles, "\n.lv-agent-profile-wrap {");
    const accountSeparator = getBlockBody(styles, "\n.lv-agent-account-footer {");
    const desktopScrollContainer = getBlockBody(
      styles,
      "\n  .lv-agents-sidebar-scroll-isolated {",
    );

    expect(profileSeparator).toContain("width: calc(100% + 12px);");
    expect(profileSeparator).toContain("padding-bottom: 8px;");
    expect(profileSeparator).not.toContain("border-bottom:");
    expect(page).not.toContain("lv-agent-feedback-link");
    expect(page).not.toContain("有建议？提交反馈");
    expect(page).not.toContain("PRODUCT_FEEDBACK_URL");
    expect(styles).not.toContain("lv-agent-feedback-link");
    expect(page).toContain('<UserAvatarMenu showLanguageSwitcher={isGlobal} variant="sidebar" />');
    expect(accountSeparator).toContain("width: calc(100% + 12px + 16px);");
    expect(accountSeparator).toContain("margin-left: -16px;");
    expect(accountSeparator).toContain("padding-left: 16px;");
    expect(accountSeparator).toContain("border-top: 1px solid #e9ecf1;");
    expect(desktopScrollContainer).toContain("width: 264px;");
    expect(desktopScrollContainer).toContain("left: 0;");
    expect(desktopScrollContainer).toContain("margin-left: 0;");
    expect(desktopScrollContainer).toContain("padding-left: 16px;");
    expect(desktopScrollContainer).toContain("overflow: hidden;");
  });

});
