import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LegalFooter } from "@/components/site/legal-footer";
import zhCN from "@/i18n/generated/zh-CN.json";
import zhToKey from "@/i18n/generated/zh-to-key.json";

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string, values?: Record<string, number>) =>
    values?.year ? text.replace("{{year}}", String(values.year)) : text,
  useLocaleOverride: () => null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "zh-CN" },
  }),
}));

vi.mock("@/lib/region", () => ({
  isCN: true,
  isGlobal: false,
  localizedPath: (path: string) => path,
}));

afterEach(() => {
  cleanup();
});

describe("LegalFooter", () => {
  it("separates the domestic copyright and attribution with a middle dot", () => {
    const source = "Copyright © {{year}} LightVela 版权所有，腾讯轻量云出品";
    const key = zhToKey[source as keyof typeof zhToKey];

    expect(zhCN[key as keyof typeof zhCN]).toBe(
      ["Copyright © {{year}} LightVela 版权所有", "腾讯轻量云出品"].join(" · "),
    );
  });

  it("links domestic product feedback to the Tencent questionnaire", () => {
    render(<LegalFooter />);

    const feedbackLink = screen.getByRole("link", { name: "产品反馈" });
    expect(feedbackLink).toHaveAttribute("href", "https://wj.qq.com/s2/27184784/6d06/");
    expect(feedbackLink).toHaveAttribute("target", "_blank");
    expect(feedbackLink).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("wraps long localized QR instructions inside a viewport-safe popover", async () => {
    render(<LegalFooter />);

    await userEvent.hover(screen.getByText("加入交流群"));

    const instruction = await screen.findByText("扫码加入交流群");
    expect(instruction).toHaveClass("max-w-full", "whitespace-normal", "text-center", "text-pretty");
    expect(instruction).not.toHaveClass("whitespace-nowrap", "tracking-wider");
    expect(instruction.parentElement).toHaveClass("w-60", "max-w-[calc(100vw-2rem)]");
  });
});
