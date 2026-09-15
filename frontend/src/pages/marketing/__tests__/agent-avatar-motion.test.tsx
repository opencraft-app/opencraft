import { readFileSync } from "node:fs";

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GeometricAvatar } from "@/pages/marketing/agent-avatar-shapes";

/**
 * 头像动效守卫。
 *
 * 动效靠「SVG 分层 class + CSS keyframes」配合，两边任一侧改动都会静默失效
 * （动画不报错，只是不动）。所以这里同时断言结构与样式。
 */
describe("GeometricAvatar motion", () => {
  it("keeps eyes inside the body group so scaling does not misalign them", () => {
    const { container } = render(<GeometricAvatar shapeId="blob" color="#F9A8C4" />);
    const body = container.querySelector(".lv-avatar__body");
    expect(body).not.toBeNull();
    // 眼睛必须是 body 的后代，否则呼吸时形体与眼睛会分离
    expect(body!.querySelectorAll(".lv-avatar__eye")).toHaveLength(2);
    expect(body!.querySelector(".lv-avatar__eyes")).not.toBeNull();
  });

  it("stays still by default and only animates when alive", () => {
    const quiet = render(<GeometricAvatar shapeId="circle" color="#8EC5F5" />);
    expect(quiet.container.querySelector(".lv-avatar--alive")).toBeNull();

    const alive = render(<GeometricAvatar shapeId="circle" color="#8EC5F5" alive />);
    expect(alive.container.querySelector(".lv-avatar--alive")).not.toBeNull();
  });

  it("anchors each eye's transform origin at its own center for blinking", () => {
    // 眨眼是 scaleY，原点必须在眼睛自己中心，否则会从顶边压下来
    const { container } = render(<GeometricAvatar shapeId="teardrop" color="#7BD4CE" />);
    const eyes = [...container.querySelectorAll<SVGRectElement>(".lv-avatar__eye")];
    expect(eyes).toHaveLength(2);
    for (const eye of eyes) {
      const x = Number(eye.getAttribute("x"));
      const y = Number(eye.getAttribute("y"));
      const w = Number(eye.getAttribute("width"));
      const h = Number(eye.getAttribute("height"));
      expect(eye.style.transformOrigin).toBe(`${x + w / 2}px ${y + h / 2}px`);
    }
  });

  it("declares the keyframes and transform-box the animation depends on", () => {
    const css = readFileSync("src/styles.css", "utf8");
    for (const name of [
      "lv-avatar-pop",
      "lv-avatar-blink-once",
      "lv-avatar-breathe",
      "lv-avatar-blink-loop",
      "lv-avatar-look",
    ]) {
      expect(css, name).toContain(`@keyframes ${name}`);
    }
    // 没有 transform-box: view-box，px 形式的 transformOrigin 会错锚点
    expect(css).toContain("transform-box: view-box");
    // 循环动画必须限定在 alive 上，否则列表头像会集体乱动
    expect(css).toContain(".lv-avatar--alive .lv-avatar__eye");
    expect(css).toContain(".lv-avatar--alive .lv-avatar__body");
  });

  it("respects prefers-reduced-motion through the global rule", () => {
    const css = readFileSync("src/styles.css", "utf8");
    const idx = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(idx).toBeGreaterThan(-1);
    // 全局规则用 * 选择器统一关停动画，头像动效因此自动被覆盖
    const block = css.slice(idx, idx + 260);
    expect(block).toContain("animation-duration: 0.001ms !important");
  });
});
