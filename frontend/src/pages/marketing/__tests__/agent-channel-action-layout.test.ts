import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const channelPanelSource = readFileSync(
  join(process.cwd(), "src/pages/marketing/agent-channel-panel.tsx"),
  "utf8",
);
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
    expect(connectedGuideRule).toContain("flex: 1 1 112px;");
    expect(connectedGuideRule).toContain("min-width: 112px;");
    expect(connectedGuideRule).toContain("text-align: center;");
    expect(connectedActionGroupRule).toContain("flex: 1 0 220px;");
    expect(connectedActionGroupRule).toContain(
      "min-width: min(220px, 100%);",
    );
    expect(connectedActionGroupRule).toContain("margin-left: 0;");
    expect(connectedButtonRule).toContain("flex: 1 1 0;");
    expect(connectedButtonRule).toContain("min-width: 0;");
  });
});
