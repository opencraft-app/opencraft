import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/pages/marketing/agent-settings-page.tsx"), "utf8");

describe("LightVela Slack channel integration", () => {
  it("delegates Slack connection behavior to the SDK ChannelPanel", () => {
    expect(source).not.toContain("buildSlackChannelConnectCommand");
    expect(source).not.toContain("withLightVelaSlackChannelList");
    expect(source).not.toContain("getSlackEnhancedProductConfig");
    expect(source).not.toContain("onSlackConnect");
    expect(source).toContain("renderChannelCard");
    expect(source).toContain("<LightVelaSdkChannelCard");
  });

  it("keeps Slack in LightVela-specific channel affordances", () => {
    expect(source).toContain('slack: "https://lightvela.ai/docs/configuration/channel-slack"');
    expect(source).toContain('if (channel.value === "slack") return t("通过 Bot Token / App Token 绑定");');
    expect(source).toContain('case "slack":');
  });
});
