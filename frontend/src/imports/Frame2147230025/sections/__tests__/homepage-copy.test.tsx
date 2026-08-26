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
  it("只在国内站展示新的两句文案", () => {
    render(
      <LocaleOverrideProvider locale="zh-CN">
        <HeroSection />
      </LocaleOverrideProvider>,
    );

    if (isCN) {
      expect(screen.getByText("LightVela · Hermes Agent")).toBeInTheDocument();
      const heading = screen.getByRole("heading", {
        name: "越用越懂你，长期在线的 AI 伙伴",
      });
      expect(heading).toHaveClass("text-[30px]", "sm:text-[48px]", "lg:text-[56px]");
      return;
    }

    expect(
      screen.getByText("云端托管 Hermes Agent，越聊越懂你的智能伙伴"),
    ).toBeInTheDocument();
    const heading = screen.getByRole("heading", {
      name: "灵感随时发生，思考自由流动",
    });
    expect(heading).toHaveClass("text-[30px]", "sm:text-[52px]", "lg:text-[64px]");
  });
});
