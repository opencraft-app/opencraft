import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const settingsSource = readFileSync(
  join(process.cwd(), "src/pages/marketing/agent-settings-page.tsx"),
  "utf8",
);
const channelPanelSource = readFileSync(
  join(process.cwd(), "src/pages/marketing/agent-channel-panel.tsx"),
  "utf8",
);

describe("LightVela Slack channel integration", () => {
  it("delegates Slack connection behavior to the ChannelPanel", () => {
    // settings-page 不实现 Slack 专属逻辑，通道行为统一委托给 agent-channel-panel
    expect(settingsSource).not.toContain("buildSlackChannelConnectCommand");
    expect(settingsSource).not.toContain("withLightVelaSlackChannelList");
    expect(settingsSource).not.toContain("getSlackEnhancedProductConfig");
    expect(settingsSource).not.toContain("onSlackConnect");
    // settings-page 通过 lazy 懒加载本地化后的 ChannelPanel 渲染
    expect(settingsSource).toContain(
      'import("@/pages/marketing/agent-channel-panel")',
    );
    expect(settingsSource).toContain("AgentChannelPanel");
  });

  it("keeps Slack in LightVela-specific channel affordances", () => {
    // Slack 文档链接与绑定文案由 ChannelPanel 提供
    expect(channelPanelSource).toContain(
      "slack: 'https://lightvela.ai/docs/configuration/channel-slack'",
    );
    expect(channelPanelSource).toContain(
      "if (channelType === 'slack') return t('通过 Bot Token 和 App Token 绑定');",
    );
    expect(channelPanelSource).toContain("case 'slack':");
  });
});
