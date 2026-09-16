import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { ChannelCardView } from "../agent-channel-views";
afterEach(cleanup);

const channelPanelSource = readFileSync(
  join(process.cwd(), "src/pages/marketing/agent-channel-panel.tsx"),
  "utf8",
);
const globalStyles = readFileSync(join(process.cwd(), "src/app/global.css"), "utf8");
const configStyleImports = readFileSync(join(process.cwd(), "src/pages/marketing/agent-config/styles-index.css"), "utf8");
const standardPanelStyles = readFileSync(
  join(process.cwd(), "src/pages/marketing/agent-config/standard-panel.css"),
  "utf8",
);

function normalizeCss(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function getRuleBody(styles: string, selector: string): string | undefined {
  for (const match of styles
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const ruleSelector = match[1];
    const ruleBody = match[2];
    if (
      ruleSelector !== undefined &&
      ruleBody !== undefined &&
      normalizeCss(ruleSelector) === normalizeCss(selector)
    ) {
      return ruleBody;
    }
  }

  return undefined;
}

describe("international connected channel card actions", () => {
  it("adds an international-only modifier to the rendered channel panel", () => {
    expect(channelPanelSource).toContain(
      "ops.productConfig.isI18n ? `${CLS}--i18n` : ''",
    );
  });

  it("keeps long localized actions inside the connected card", () => {
    const scope =
      ".lh-std-channel-panel--i18n .lh-std-channel-panel__card--bound";
    const connectedActionRule = getRuleBody(
      standardPanelStyles,
      `${scope} .lh-std-channel-panel__card-action`,
    );
    const connectedGuideRule = getRuleBody(
      standardPanelStyles,
      `${scope} .lh-std-channel-panel__guide-btn`,
    );
    const connectedActionGroupRule = getRuleBody(
      standardPanelStyles,
      `${scope} .lh-std-channel-panel__card-action-right`,
    );
    const connectedButtonRule = getRuleBody(
      standardPanelStyles,
      `${scope} :is(.lh-std-channel-panel__card-unbind, .lh-std-channel-panel__connect-btn)`,
    );

    expect(connectedActionRule).toContain("flex-wrap: wrap;");
    expect(connectedActionRule).toContain("min-width: 0;");
    expect(connectedGuideRule).toContain("flex: 0 0 auto;");
    expect(connectedGuideRule).toContain("min-width: 0;");
    expect(connectedGuideRule).toContain("text-align: center;");
    expect(connectedActionGroupRule).toContain("flex: 0 1 100%;");
    expect(connectedActionGroupRule).toContain("min-width: 0;");
    expect(connectedActionGroupRule).toContain("justify-content: flex-end;");
    expect(connectedActionGroupRule).toContain("margin-left: auto;");
    expect(connectedButtonRule).toContain("flex: 0 0 auto;");
    expect(connectedButtonRule).toContain("min-width: 0;");
  });
});

describe("channel card action placement", () => {
  it("keeps actions at the card bottom and groups guide with connect on the right", () => {
    const actionRule = getRuleBody(
      standardPanelStyles,
      ".lh-std-channel-panel__card-action",
    );
    const actionGroupRule = getRuleBody(
      standardPanelStyles,
      ".lh-std-channel-panel__card-action-right",
    );

    expect(actionRule).toContain("justify-content: flex-end;");
    expect(actionRule).toContain("margin-top: auto;");
    expect(actionGroupRule).toContain("justify-content: flex-end;");
    expect(actionGroupRule).toContain("flex-wrap: wrap;");
    render(createElement(ChannelCardView, {
      name: "Slack", description: "Credentials", icon: null, connected: true, connectedLabel: "Connected",
      guideUrl: "https://lightvela.ai/docs/configuration/channel-slack", guideLabel: "Guide",
      disconnectLabel: "Disconnect", connectLabel: "Reconnect", disconnectDisabled: false,
      onConnect: () => undefined, onDisconnect: () => undefined,
    }));
    const guide = screen.getByRole("link", { name: "Guide" });
    const connect = screen.getByRole("button", { name: "Reconnect" });
    expect(guide.closest(".lh-std-channel-panel__card-action-right")).toContainElement(connect);
    expect(guide.compareDocumentPosition(connect) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("channel card action button radius", () => {
  it("uses the explicit Agents radius for the card and its actions", () => {
    // The app stylesheet is layered. Overrides must share the unlayered channel
    // stylesheet, otherwise the legacy 16px/999px radii win regardless of specificity.
    expect(globalStyles).toMatch(/@import ['"]\.\.\/styles\.css['"] layer\(app\);/);
    expect(configStyleImports).toMatch(/@import ['"]\.\/standard-panel\.css['"];/);
    expect(getRuleBody(standardPanelStyles, ".agents-ui.lh-std-channel-panel .lh-std-channel-panel__card")).toContain("border-radius: 6px;");
    const actionRule = getRuleBody(standardPanelStyles, ".agents-ui.lh-std-channel-panel :is(.lh-std-channel-panel__guide-btn, .lh-std-channel-panel__card-unbind, .lh-std-channel-panel__connect-btn)");
    expect(actionRule).toContain("border-radius: 6px;");
    expect(actionRule).toContain("min-height: 36px;");
    expect(actionRule).toContain("white-space: normal;");
    expect(actionRule).toContain("overflow-wrap: anywhere;");
  });
});
