import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import i18n from "@/i18n";
import { LocaleOverrideProvider } from "@/i18n/t";
import { isCN } from "@/lib/region";
import HeroSection from "../HeroSection";

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("首页 Hero 文案", () => {
  it("在国内站展示最终简中文案", () => {
    render(
      <LocaleOverrideProvider locale="zh-CN">
        <HeroSection />
      </LocaleOverrideProvider>,
    );

    if (!isCN) return;

    expect(screen.getByText("LightVela · 云端 Hermes Agent")).toBeInTheDocument();
    const heading = screen.getByRole("heading", {
      name: "你的 AI 伙伴，长期在线，持续进化",
    });
    expect(heading).toHaveClass("text-[30px]", "sm:text-[48px]", "lg:text-[56px]");
  });

  it.each([
    ["zh-CN", "LightVela · 云端 Hermes Agent", "你的 AI 伙伴，随时都在，持续进化"],
    [
      "zh-Hant",
      "LightVela · 雲端 Hermes Agent",
      "你的 AI 夥伴，隨時都在，持續進化",
    ],
    [
      "en-US",
      "LightVela · Hermes Agent in the Cloud",
      "Your AI companion—always here, always evolving with you",
    ],
    [
      "id-ID",
      "LightVela · Hermes Agent di cloud",
      "Pendamping AI-mu—selalu ada, selalu berkembang bersamamu",
    ],
  ] as const)("在国际站展示 %s Hero 文案", (locale, eyebrow, slogan) => {
    render(
      <LocaleOverrideProvider locale={locale}>
        <HeroSection />
      </LocaleOverrideProvider>,
    );

    if (isCN) return;

    expect(screen.getByText(eyebrow)).toBeInTheDocument();
    const heading = screen.getByRole("heading", { name: slogan });
    expect(heading).toHaveClass("text-[30px]", "sm:text-[52px]", "lg:text-[64px]");
  });
});
