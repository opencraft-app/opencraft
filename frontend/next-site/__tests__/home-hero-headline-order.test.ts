import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = readFileSync(
  path.resolve("public/lightvela-intl-home/runtime.js"),
  "utf8",
);
const css = readFileSync(
  path.resolve("public/lightvela-intl-home/style.css"),
  "utf8",
);
const headlineRuntime = runtime.slice(
  runtime.indexOf("(function () {\n    var el = document.getElementById('hero-rotator');"),
  runtime.indexOf("(function () {\n    var els = document.querySelectorAll('.sr');"),
);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());

  document.body.innerHTML = `
    <div id="lightvela-intl-home" data-rotator-words='["工作助理","知识库"]'>
      <h1 class="hero__title">
        <span class="hero__line hero__line--main">越用越懂你，长期在线的 AI 伙伴</span>
        <span class="hero__line hero__line--dynamic">
          <span class="hero__prefix">LightVela 可以成为你的</span>
          <span class="hero__rotator-wrap"><em id="hero-rotator">工作助理</em></span>
        </span>
      </h1>
    </div>
  `;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.documentElement.classList.remove("hero-sequence-ready");
  document.body.innerHTML = "";
});

describe("homepage hero headline order", () => {
  it("keeps the first role until both headline lines have appeared", () => {
    new Function(headlineRuntime)();
    window.dispatchEvent(new Event("pageshow"));

    const rotator = document.querySelector<HTMLElement>("#hero-rotator")!;
    const wrap = document.querySelector<HTMLElement>(".hero__rotator-wrap")!;
    const mainChars = Array.from(
      document.querySelectorAll<HTMLElement>(".hero__line--main .hero__char"),
    );
    const prefixChars = Array.from(
      document.querySelectorAll<HTMLElement>(".hero__prefix .hero__char"),
    );
    const readDelay = (character: HTMLElement) =>
      Number.parseInt(character.style.getPropertyValue("--cd"), 10);
    const revealDelay = Number.parseInt(
      wrap.style.getPropertyValue("--rotator-delay"),
      10,
    );

    expect(document.documentElement).toHaveClass("hero-sequence-ready");
    expect(readDelay(prefixChars[0])).toBe(
      readDelay(mainChars.at(-1)!) + 500 + 80,
    );
    expect(revealDelay).toBe(
      readDelay(prefixChars.at(-1)!) + 500 + 80,
    );

    vi.advanceTimersByTime(revealDelay + 2_459);
    expect(rotator.textContent).toBe("工作助理");

    vi.advanceTimersByTime(1);
    expect(rotator.textContent).toBe("知识库");
  });

  it("keeps dependent hero elements hidden until their timing is ready", () => {
    expect(css).toContain(
      "html:not(.hero-sequence-ready) #lightvela-intl-home .hero__line--dynamic .hero__rotator-wrap",
    );
    expect(css).toMatch(
      /html:not\(\.hero-sequence-ready\)[\s\S]*animation: none;[\s\S]*opacity: 0;/,
    );
  });
});
