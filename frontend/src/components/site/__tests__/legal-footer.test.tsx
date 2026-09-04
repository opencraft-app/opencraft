import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LegalFooter } from "@/components/site/legal-footer";
import zhCN from "@/i18n/generated/zh-CN.json";
import zhToKey from "@/i18n/generated/zh-to-key.json";

const localeState = vi.hoisted(() => ({
  language: "zh-CN",
}));

const footerTranslations = vi.hoisted(() => ({
  "en-US": {
    "Copyright © {{year}} LightVela 版权所有，腾讯轻量云出品":
      "Copyright © {{year}} LightVela. All rights reserved. Powered by Tencent Lighthouse.",
    加入交流群: "Join Community",
    开源声明: "Open Source Notice",
    服务条款: "Terms of Service",
    隐私政策: "Privacy Policy",
  },
  "zh-CN": {
    "Copyright © {{year}} LightVela 版权所有，腾讯轻量云出品":
      "Copyright © {{year}} LightVela 版权所有 · 腾讯轻量云出品",
  },
}));

const interpolateYear = (text: string, values?: Record<string, number>) =>
  values?.year ? text.replace("{{year}}", String(values.year)) : text;

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string, values?: Record<string, number>) => {
    const locale = localeState.language as keyof typeof footerTranslations;
    const translated = footerTranslations[locale]?.[text as keyof typeof footerTranslations[typeof locale]] ?? text;
    return interpolateYear(translated, values);
  },
  useLocaleOverride: () => null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: localeState.language },
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
  localizedPath: (path: string, locale?: string) => {
    if (!regionState.isGlobal) return path;
    return locale === "zh-CN" || locale === "zh-SG" ? `/zh-sg${path}` : path;
  },
}));

vi.mock("@/lib/public-site-routing", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/public-site-routing")>(),
  resolveVisiblePublicSiteLocale: () => localeState.language,
}));

beforeEach(() => {
  regionState.isCN = true;
  regionState.isGlobal = false;
  localeState.language = "zh-CN";
});

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

  it("renders the compact international footer without the logo block", () => {
    regionState.isCN = false;
    regionState.isGlobal = true;
    localeState.language = "en-US";

    render(<LegalFooter />);

    expect(
      screen.getByText("Copyright © 2026 LightVela. All rights reserved. Powered by Tencent Lighthouse."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy-policy");
    expect(screen.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/terms-of-service");
    expect(screen.getByRole("link", { name: "Open Source Notice" })).toHaveAttribute(
      "href",
      "/open-source-licenses",
    );
    expect(screen.getByRole("link", { name: "Join Community" })).toHaveAttribute(
      "href",
      "https://discord.gg/Myh58xEMe2",
    );
    expect(screen.queryByRole("link", { name: "LightVela" })).not.toBeInTheDocument();
  });

  it("localizes the compact international footer for Chinese public routes", () => {
    regionState.isCN = false;
    regionState.isGlobal = true;
    localeState.language = "zh-CN";

    render(<LegalFooter />);

    expect(screen.getByText("Copyright © 2026 LightVela 版权所有 · 腾讯轻量云出品")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "隐私政策" })).toHaveAttribute("href", "/zh-sg/privacy-policy");
    expect(screen.getByRole("link", { name: "服务条款" })).toHaveAttribute("href", "/zh-sg/terms-of-service");
    expect(screen.getByRole("link", { name: "开源声明" })).toHaveAttribute(
      "href",
      "/zh-sg/open-source-licenses",
    );
    expect(screen.getByRole("link", { name: "加入交流群" })).toHaveAttribute(
      "href",
      "https://discord.gg/Myh58xEMe2",
    );
    expect(screen.queryByText(/All rights reserved/)).not.toBeInTheDocument();
  });
});
