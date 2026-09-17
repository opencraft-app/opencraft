import { describe, expect, it } from "vitest";

import enUS from "../generated/en-US.json";
import zhToKey from "../generated/zh-to-key.json";

function en(source: keyof typeof zhToKey): string {
  return enUS[zhToKey[source] as keyof typeof enUS];
}

describe("Soul page English copy", () => {
  it("uses Soul consistently for the Agent's Soul", () => {
    expect(en("设置人设文件（SOUL.md），让你的 Agent 拥有独特的性格与表达方式")).toBe(
      "Set up your Agent's Soul (SOUL.md) to give it a distinct personality and voice.",
    );
    expect(en("人设卡片")).toBe("Soul Cards");
    expect(en("上传人设文件")).toBe("Upload a Soul file");
    expect(en("自定义人设")).toBe("Custom Soul");
    expect(en("已注入：自定义人设 · {{name}}")).toBe("Applied: Custom Soul · {{name}}");
    expect(en("注入此人设")).toBe("Inject this Soul");
    expect(en("人设已更新")).toBe("Soul updated");
  });

  it("distinguishes an uploaded Markdown file from the Agent's SOUL.md", () => {
    expect(en("选择 Markdown 人设文件")).toBe("Choose a Markdown file");
    expect(en("选择 Markdown 人设文件，将其内容填入 SOUL.md")).toBe(
      "Choose a Markdown file to use as your Agent's Soul (SOUL.md).",
    );
  });

  it("calls the quiz a Soul Quiz while describing the user's traits as personality", () => {
    expect(en("Soul人格测试")).toBe("Soul Quiz");
    expect(en("你的灵魂画像")).toBe("Your personality profile");
    expect(en("为你推荐的智能体伙伴 Soul 是")).toBe("We recommend this Soul for your Agent");
    expect(en("Soul 设定解读")).toBe("About this Soul");
  });
});
