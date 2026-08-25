import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DOCS_ROUTE_SLUGS } from "../next-site/docs-route-manifest";

const docsRoot = join(process.cwd(), "src", "content", "docs");
const generatedDocsRoot = join(process.cwd(), ".fumadocs-content", "docs");
const slackSlug = ["configuration", "channel-slack"];
const imagesRoot = join(docsRoot, "images");

const slackImageNames = [
  "slack-create-app.png",
  "slack-create-from-scratch.png",
  "slack-select-workspace.png",
  "slack-basic-information.png",
  "slack-generate-app-token.png",
  "slack-add-connection-scope.png",
  "slack-select-connections-write.png",
  "slack-generate-token.png",
  "slack-copy-app-token.png",
  "slack-enable-socket-mode.png",
  "slack-add-oauth-scope.png",
  "slack-bot-token-scopes.png",
  "slack-event-subscriptions.png",
  "slack-install-workspace.png",
  "slack-authorize-workspace.png",
  "slack-copy-bot-token.png",
  "slack-direct-message-test.png",
];

const hasRoute = (locale: "en-us" | "zh-sg" | "zh-hant") =>
  DOCS_ROUTE_SLUGS[locale].some((slug) => slug.join("/") === slackSlug.join("/"));

describe("Slack international docs publication", () => {
  it("publishes Slack docs for English, simplified Chinese, and traditional Chinese", () => {
    expect(existsSync(join(docsRoot, "en", "configuration/channel-slack.md"))).toBe(true);
    expect(existsSync(join(docsRoot, "global", "configuration/channel-slack.md"))).toBe(true);
    expect(existsSync(join(generatedDocsRoot, "zh-hant", "configuration/channel-slack.mdx"))).toBe(true);

    expect(hasRoute("en-us")).toBe(true);
    expect(hasRoute("zh-sg")).toBe(true);
    expect(hasRoute("zh-hant")).toBe(true);
  });

  it("keeps Slack in the international sidebar before WeChat", () => {
    const sidebar = readFileSync(join(process.cwd(), "src/config/docs-sidebar.ts"), "utf8");
    const slackIndex = sidebar.indexOf('slug: "configuration/channel-slack"');
    const wechatIndex = sidebar.indexOf('slug: "configuration/channel-wechat"', slackIndex);

    expect(slackIndex).toBeGreaterThan(-1);
    expect(wechatIndex).toBeGreaterThan(slackIndex);
  });

  it("registers the Slack slug for international docs", () => {
    const sidebar = readFileSync(join(process.cwd(), "src/config/docs-sidebar.ts"), "utf8");
    const globalMapStart = sidebar.indexOf("const GLOBAL_SLUG_TO_FILE");
    const globalMapEnd = sidebar.indexOf("export const SLUG_TO_FILE", globalMapStart);
    const globalMap = sidebar.slice(globalMapStart, globalMapEnd);

    expect(globalMap).toContain(
      '"configuration/channel-slack": "configuration/channel-slack.md"',
    );
  });

  it("provides a complete illustrated Slack setup guide in both source languages", () => {
    const globalMarkdown = readFileSync(
      join(docsRoot, "global", "configuration/channel-slack.md"),
      "utf8",
    );
    const englishMarkdown = readFileSync(
      join(docsRoot, "en", "configuration/channel-slack.md"),
      "utf8",
    );

    expect(globalMarkdown).toContain("## 本页覆盖");
    expect(englishMarkdown).toContain("## This page covers");
    expect(globalMarkdown).toContain("## 操作步骤");
    expect(englishMarkdown).toContain("## Steps");
    expect(globalMarkdown).toContain("### 4.3 开启 App Home 私信入口");
    expect(englishMarkdown).toContain("### 4.3 Enable direct messages in App Home");
    expect(globalMarkdown).toContain("## 成功状态");
    expect(englishMarkdown).toContain("## Success state");
    expect(globalMarkdown).toContain("## 支持的消息类型");
    expect(englishMarkdown).toContain("## Supported message types");
    expect(globalMarkdown).toContain("## 常见问题");
    expect(englishMarkdown).toContain("## FAQ");
    expect(globalMarkdown).toContain("## 下一步");
    expect(englishMarkdown).toContain("## Next steps");
    expect(globalMarkdown).not.toContain("## 常见失败处理");
    expect(englishMarkdown).not.toContain("## Troubleshooting");
    expect(globalMarkdown).not.toContain("## 通道说明");
    expect(englishMarkdown).not.toContain("## Channel notes");

    for (const imageName of slackImageNames) {
      expect(globalMarkdown).toContain(`../images/${imageName}`);
      expect(englishMarkdown).toContain(`../images/${imageName}`);
      expect(existsSync(join(imagesRoot, imageName))).toBe(true);
    }

    expect(globalMarkdown).not.toMatch(/Lighthouse|dscache-intl|交流群|教程合集/);
    expect(englishMarkdown).not.toMatch(/Tencent Cloud Lighthouse|dscache-intl|Developer Community/);
  });
});
