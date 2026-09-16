import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const qrModalSource = readFileSync(
  join(process.cwd(), "src/pages/marketing/agent-config/components/HermesQrCodeModal.tsx"),
  "utf8",
);
const channelPanelSource = readFileSync(
  join(process.cwd(), "src/pages/marketing/agent-channel-panel.tsx"),
  "utf8",
);
const standardPanelStyles = readFileSync(
  join(process.cwd(), "src/pages/marketing/agent-config/standard-panel.css"),
  "utf8",
);

// hermes 侧 `gateway qr-url` 的 platform enum 已含 dingtalk（lib/dingtalk_qr.sh 设备码流），
// 前端需保证钉钉扫码入口不被 fallback、且保留手动 Client ID / Secret 绑定路径。
describe("DingTalk channel QR binding", () => {
  it("keeps dingtalk in the QR flow whitelist so it is not silently degraded to weixin", () => {
    expect(qrModalSource).toMatch(
      /SUPPORTED_QR_PLATFORMS = \['weixin', 'feishu', 'qqbot', 'whatsapp', 'yuanbao', 'dingtalk'\]/,
    );
  });

  it("offers QR code and manual Client ID / Secret methods for dingtalk", () => {
    // 连接入口走方式选择弹窗（与 QQ 共用）
    expect(channelPanelSource).toMatch(
      /channelValue === 'qqbot' \|\| channelValue === 'dingtalk'/,
    );
    // 卡片描述体现双方式
    expect(channelPanelSource).toContain(
      "if (channelType === 'dingtalk') return t('扫码或通过 Client ID / Secret 连接');",
    );
    // 手动路径保留 token 表单元数据
    expect(channelPanelSource).toMatch(/case 'dingtalk':/);
    // 教程链接存在
    expect(channelPanelSource).toContain(
      "dingtalk: 'https://lightvela.ai/docs/configuration/channel-dingtalk',",
    );
  });

  it("uses connection language consistently in channel card descriptions", () => {
    expect(channelPanelSource).toContain("if (channelType === 'qqbot') return t('扫码或通过 App ID / Secret 连接');");
    expect(channelPanelSource).toContain("if (channelType === 'telegram') return t('通过 Bot Token 连接');");
    expect(channelPanelSource).toContain("if (channelType === 'slack') return t('通过 Bot Token 和 App Token 连接');");
    expect(channelPanelSource).toContain("if (channelType === 'dingtalk') return t('扫码或通过 Client ID / Secret 连接');");
  });

  it("uses the standard tinted icon treatment for dingtalk", () => {
    expect(channelPanelSource).toContain(
      "style={{ background: 'rgba(0, 137, 255, 0.08)' }}",
    );
    expect(channelPanelSource).not.toContain(
      "style={{ background: '#ffffff' }}",
    );
  });

  it("uses the standard dialog radius instead of the Skills panel private token", () => {
    const channelButtonRule = standardPanelStyles.match(
      /\.agents-ui\.lh-std-channel-panel :is\([^}]+\)\s*\{([^}]*)\}/,
    )?.[1];

    expect(channelButtonRule).toBeDefined();
    expect(channelButtonRule).toMatch(
      /border-radius\s*:\s*6px\s*;/,
    );
    expect(channelButtonRule).not.toContain("--lh-std-skill-radius");
  });
});
