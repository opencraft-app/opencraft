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

  it.each([
    ["搭子状态未加载成功，暂时无法保存推荐人设，请先重试加载状态", "Buddy status failed to load, so the recommended Soul cannot be saved yet. Please retry loading the status first."],
    ["卡槽已满，请先删除一张人设，再使用测试推荐", "All slots are full. Please delete one Soul before using the test recommendation."],
    ["拉取人设详情失败，请检查网络后重试", "Failed to fetch Soul details. Check your network and try again."],
    ["确认删除人设", "Remove this Soul?"],
    ["该人设已注入 Agent，删除会同时取消 Agent 当前人设，确认？", "This Soul is currently active. Removing it will also clear the Agent's current Soul. Continue?"],
    ["取消选中此人设", "Deselect this Soul"],
    ["选中此人设", "Select this Soul"],
    ["重新抽取这张人设", "Redraw this Soul"],
    ["删除这张人设", "Remove this Soul"],
    ["点击空卡抽取人设", "Click an empty card to draw a Soul"],
    ["点击抽取人设", "Click to draw a Soul"],
  ] as const)("uses Soul for %s", (source, expected) => {
    expect(en(source)).toBe(expected);
  });

  it("names a downloaded copy SOUL.md in both fallback messages", () => {
    expect(en("无法写入 Agent 沙箱，已下载 SOUL.md 到本地")).toBe(
      "Could not write to Agent sandbox. SOUL.md downloaded to your device.",
    );
    expect(en("当前未选中 Agent，已下载 SOUL.md 到本地")).toBe(
      "No Agent selected. SOUL.md downloaded to your device.",
    );
  });
});
