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

    expect(page).toContain('"lw-app-top-pad lv-agent-settings-main flex-grow bg-white pb-6",');
    expect(page).toContain('activeSection === "chat" && "lg:pb-0"');
    expect(page).toContain('<section className="lw-settings-shell lv-agent-settings-shell">');
    expect(page).toContain('className="lv-agent-sidebar-header"');
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
    expect(page).toContain('className="lv-agent-settings-content min-w-0 lg:col-start-2"');
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
