/**
 * 总览页的交互元素守卫
 * ──────────────────────────────────────────────────────────────
 * 这条针对 Tailwind v4 的一个破坏性变更：
 *
 *   v3 的 Preflight 给 button 设 `cursor: pointer`
 *   v4 改成了 `cursor: default`
 *
 * 于是「能点但光标是箭头」在 v4 下不会有任何报错，只能靠人眼发现 ——
 * 资料卡片就是这么漏掉的：hover 有边框变化，光标却还是箭头，整张卡
 * 看起来不像能点。
 *
 * 用源码文本断言而不是渲染断言：jsdom 不跑 Preflight，渲染测试里
 * `toHaveStyle("cursor: pointer")` 永远拿不到真实值，测不出这个问题。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const panel = readFileSync(
  join(process.cwd(), "src/pages/marketing/agent-overview-panel.tsx"),
  "utf8",
);

/** 抓出所有 <button ...> 开标签（含跨行 className） */
function extractButtonTags(source: string): { line: number; tag: string }[] {
  const tags: { line: number; tag: string }[] = [];
  for (const match of source.matchAll(/<button\b[\s\S]{0,900}?\n\s*(?:\/>|>)/g)) {
    tags.push({
      line: source.slice(0, match.index).split("\n").length,
      tag: match[0],
    });
  }
  return tags;
}

describe("agent overview panel affordances", () => {
  it("gives every button an explicit pointer cursor", () => {
    const tags = extractButtonTags(panel);
    // 结构变了就该重新确认，不能让断言悄悄变成零覆盖
    expect(tags.length).toBeGreaterThanOrEqual(6);

    for (const { line, tag } of tags) {
      expect(
        tag.includes("cursor-pointer"),
        `agent-overview-panel.tsx L${line} 的 button 缺少 cursor-pointer，`
        + "Tailwind v4 下它的光标会是箭头，用户看不出能点",
      ).toBe(true);
    }
  });

  it("keeps the profile card clickable as a real button", () => {
    /*
     * 资料卡片是整张可点的，必须是真 button：
     * 用 div + onClick 会丢掉键盘可达性与 aria 语义。
     */
    const cardIndex = panel.indexOf('aria-label={t("编辑资料")}');
    expect(cardIndex).toBeGreaterThan(0);
    const card = panel.slice(cardIndex - 200, cardIndex + 600);
    expect(card).toContain("<button");
    expect(card).toContain('type="button"');
    expect(card).toContain("cursor-pointer");
    // hover 反馈也要有，光有光标变化不足以说明「这是一张卡」
    expect(card).toContain("hover:border-black/[0.12]");
  });

  it("pairs the disabled save button with a not-allowed cursor", () => {
    /*
     * 禁用态给 not-allowed、可用态给 pointer，两者都要显式写 ——
     * 只写 not-allowed 会让可用态回落到 v4 的 default。
     */
    const saveIndex = panel.indexOf("canSave");
    expect(saveIndex).toBeGreaterThan(0);
    expect(panel).toContain("cursor-pointer bg-black text-white");
    expect(panel).toContain("cursor-not-allowed bg-black/[0.06]");
  });
});
