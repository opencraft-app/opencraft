import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const standardPanelStyles = readFileSync(
  join(process.cwd(), "src/pages/marketing/agent-config/standard-panel.css"),
  "utf8",
);
const channelPanelSource = readFileSync(
  join(process.cwd(), "src/pages/marketing/agent-channel-panel.tsx"),
  "utf8",
);

function getRuleBody(styles: string, requiredSelectors: string[]): string | undefined {
  const styleRules = styles
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .matchAll(/([^{}]+)\{([^{}]*)\}/g);

  for (const match of styleRules) {
    const selectorList = match[1];
    const ruleBody = match[2];
    if (selectorList === undefined || ruleBody === undefined) continue;

    const selectors = selectorList.split(",").map((selector) => selector.trim());
    if (
      selectors.length === requiredSelectors.length &&
      requiredSelectors.every((selector) => selectors.includes(selector))
    ) {
      return ruleBody;
    }
  }

  return undefined;
}

describe("Channel panel hint", () => {
  it("finds a shared rule regardless of selector order and formatting", () => {
    const reorderedStyles = `
      .lh-std-skill-panel__hint-bar,
      .lh-std-channel-panel__hint-bar { color: red; }
    `;

    expect(
      getRuleBody(reorderedStyles, [
        ".lh-std-channel-panel__hint-bar",
        ".lh-std-skill-panel__hint-bar",
      ]),
    ).toContain("color: red;");
    expect(
      getRuleBody(
        ".lh-std-channel-panel__hint-bar { color: red; } .lh-std-skill-panel__hint-bar { color: red; }",
        [
          ".lh-std-channel-panel__hint-bar",
          ".lh-std-skill-panel__hint-bar",
        ],
      ),
    ).toBeUndefined();
  });

  it("uses the explicit 18px channel heading specification", () => {
    const titleRule = getRuleBody(standardPanelStyles, [
      ".lh-std-channel-panel__title",
    ]);

    expect(channelPanelSource).toMatch(
      /<h2 className=\{`\$\{CLS\}__title`\}>\{t\('通道'\)\}<\/h2>/,
    );
    expect(titleRule).toBeDefined();
    expect(titleRule).toContain("margin: 0 0 4px;");
    expect(titleRule).toContain("color: rgba(0, 0, 0, 0.95);");
    expect(titleRule).toContain("font-size: 18px;");
    expect(titleRule).toContain("font-weight: 600;");
    expect(titleRule).toContain("line-height: 24px;");
  });

  it("uses the explicit lightweight channel hint specification", () => {
    const hintRule = getRuleBody(standardPanelStyles, [
      ".lh-std-channel-panel__hint-bar",
      ".lh-std-skill-panel__hint-bar",
    ]);
    const iconRule = getRuleBody(standardPanelStyles, [
      ".lh-std-channel-panel__hint-icon",
      ".lh-std-skill-panel__hint-icon",
    ]);
    const channelSpacingRule = getRuleBody(standardPanelStyles, [
      ".lh-std-channel-panel__hint-bar",
    ]);

    expect(hintRule).toBeDefined();
    expect(hintRule).toContain("background: transparent;");
    expect(hintRule).toContain("color: rgba(0, 0, 0, 0.5);");
    expect(hintRule).toContain("font-size: 14px;");
    expect(hintRule).toContain("font-weight: 500;");
    expect(hintRule).toContain("line-height: 24px;");
    expect(channelSpacingRule).toBeDefined();
    expect(channelSpacingRule).toContain("margin-bottom: 12px;");
    expect(iconRule).toContain("display: none;");
  });
});
