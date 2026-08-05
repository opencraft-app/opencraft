import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LightVelaFooter } from "@/components/site/lightvela-footer";

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string) => text,
}));

// 当前语言可变，供不同用例切换（en-US / zh-CN / zh-SG / zh-Hant）
let mockLanguage = "en-US";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: {
      get language() {
        return mockLanguage;
      },
    },
  }),
}));

vi.mock("@/lib/region", () => ({
  isGlobal: true,
  localizedPath: (path: string, locale: "zh-CN" | "zh-SG" | "zh-Hant" | "en-US") => {
    const lang =
      locale === "zh-CN" ? "zh" : locale === "zh-SG" ? "zh-sg" : locale === "zh-Hant" ? "zh-hant" : "en";
    return path === "/" ? `/${lang}/` : `/${lang}${path}`;
  },
}));

beforeEach(() => {
  mockLanguage = "en-US";
});

afterEach(() => {
  cleanup();
});

describe("LightVelaFooter", () => {
  it("groups the international footer links under Legal and Community", () => {
    render(
      <MemoryRouter>
        <LightVelaFooter />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "LightVela" })).toHaveAttribute("href", "/");

    const companySection = screen.getByRole("heading", { name: "公司" }).closest("section");
    expect(companySection).not.toBeNull();
    expect(within(companySection as HTMLElement).getByRole("link", { name: "关于我们" })).toHaveAttribute(
      "href",
      "/en/about",
    );

    const legalSection = screen.getByRole("heading", { name: "法律" }).closest("section");
    expect(legalSection).not.toBeNull();
    expect(within(legalSection as HTMLElement).getByRole("link", { name: "隐私政策" })).toHaveAttribute(
      "href",
      "/en/privacy-policy",
    );
    expect(within(legalSection as HTMLElement).getByRole("link", { name: "服务条款" })).toHaveAttribute(
      "href",
      "https://www.tencentcloud.com/document/product/301/12905?lang=en&pg=",
    );
    expect(within(legalSection as HTMLElement).getByRole("link", { name: "开源声明" })).toHaveAttribute(
      "href",
      "/en/open-source-licenses",
    );

    const communitySection = screen.getByRole("heading", { name: "社区" }).closest("section");
    expect(communitySection).not.toBeNull();
    expect(within(communitySection as HTMLElement).getByRole("link", { name: "Discord" })).toHaveAttribute(
      "href",
      "https://discord.gg/Myh58xEMe2",
    );
    expect(within(communitySection as HTMLElement).getByRole("link", { name: "WhatsApp" })).toHaveAttribute(
      "href",
      "https://chat.whatsapp.com/KLF9OvdAj4sDdojG20JA9b",
    );
    expect(within(communitySection as HTMLElement).getByRole("link", { name: "X / Twitter" })).toHaveAttribute(
      "href",
      "https://x.com/agentlightvela",
    );
    expect(within(communitySection as HTMLElement).getByRole("link", { name: "Youtube" })).toHaveAttribute(
      "href",
      "https://www.youtube.com/@TencentLightVela",
    );
    expect(screen.getByText("© 2026 LightVela 版权所有，由腾讯轻量云团队出品")).toBeInTheDocument();
  });

  it("prefixes internal footer links with /zh-hant under Traditional Chinese", () => {
    mockLanguage = "zh-Hant";
    render(
      <MemoryRouter>
        <LightVelaFooter />
      </MemoryRouter>,
    );

    const companySection = screen.getByRole("heading", { name: "公司" }).closest("section");
    expect(within(companySection as HTMLElement).getByRole("link", { name: "关于我们" })).toHaveAttribute(
      "href",
      "/zh-hant/about",
    );

    const legalSection = screen.getByRole("heading", { name: "法律" }).closest("section");
    expect(within(legalSection as HTMLElement).getByRole("link", { name: "隐私政策" })).toHaveAttribute(
      "href",
      "/zh-hant/privacy-policy",
    );
    expect(within(legalSection as HTMLElement).getByRole("link", { name: "服务条款" })).toHaveAttribute(
      "href",
      "https://www.tencentcloud.com/document/product/301/12905?lang=zh&pg=",
    );
    expect(within(legalSection as HTMLElement).getByRole("link", { name: "开源声明" })).toHaveAttribute(
      "href",
      "/zh-hant/open-source-licenses",
    );
  });
});
