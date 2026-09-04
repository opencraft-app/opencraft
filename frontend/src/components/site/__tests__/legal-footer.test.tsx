import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LegalFooter } from "@/components/site/legal-footer";

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

const regionState = vi.hoisted(() => ({
  isCN: true,
  isGlobal: false,
}));

vi.mock("@/lib/region", () => ({
  get isCN() {
    return regionState.isCN;
  },
  get isGlobal() {
    return regionState.isGlobal;
  },
  localizedPath: (path: string) => path,
}));

beforeEach(() => {
  regionState.isCN = true;
  regionState.isGlobal = false;
});

afterEach(() => {
  cleanup();
});

describe("LegalFooter", () => {
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

  it("renders the compact international footer without the logo block", () => {
    regionState.isCN = false;
    regionState.isGlobal = true;

    render(<LegalFooter />);

    expect(screen.getByText("Copyright © 2026 LightVela. All rights reserved. Powered by Tencent Lighthouse.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy-policy");
    expect(screen.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/terms-of-service");
    expect(screen.getByRole("link", { name: "Open Source Notice" })).toHaveAttribute("href", "/open-source-licenses");
    expect(screen.getByRole("link", { name: "Join Community" })).toHaveAttribute(
      "href",
      "https://discord.gg/Myh58xEMe2",
    );
    expect(screen.queryByRole("link", { name: "LightVela" })).not.toBeInTheDocument();
  });
});
