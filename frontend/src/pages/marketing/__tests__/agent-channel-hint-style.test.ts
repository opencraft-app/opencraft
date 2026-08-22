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

function getRuleBody(selectorList: string): string | undefined {
  const escapedSelectorList = selectorList.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\})\\s*${escapedSelectorList}\\s*\\{([^}]*)\\}`)
    .exec(standardPanelStyles)?.[1];
}

describe("Channel panel hint", () => {
  it("shows a semantic channel title with the same hierarchy as the Skills page", () => {
    const titleRule = getRuleBody(".lh-std-channel-panel__title");

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

  it("reuses the lightweight Skills hint treatment", () => {
    const hintRule = getRuleBody(
      ".lh-std-channel-panel__hint-bar,\n.lh-std-skill-panel__hint-bar",
    );
    const iconRule = getRuleBody(
      ".lh-std-channel-panel__hint-icon,\n.lh-std-skill-panel__hint-icon",
    );
    const channelSpacingRule = getRuleBody(".lh-std-channel-panel__hint-bar");

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
