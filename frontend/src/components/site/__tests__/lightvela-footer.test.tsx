import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LightVelaFooter } from "@/components/site/lightvela-footer";

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string) => text,
  // 组件用 `useLocaleOverride() ?? i18n.language` 判定语言；
  // 这里返回 null 表示无覆盖，让用例继续通过 mockLanguage 控制语言。
  useLocaleOverride: () => null,
}));

// 当前语言可变，供不同用例切换（en-US / zh-CN / zh-SG / zh-Hant / id-ID）
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
  localizedPath: (path: string, locale: "zh-CN" | "zh-SG" | "zh-Hant" | "en-US" | "id-ID") => {
    const lang =
      locale === "zh-CN"
        ? "zh"
        : locale === "zh-SG"
          ? "zh-sg"
          : locale === "zh-Hant"
            ? "zh-hant"
            : locale === "id-ID"
              ? "id-id"
              : "en";
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
      "/en/terms-of-service",
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
      "/zh-hant/terms-of-service",
    );
    expect(within(legalSection as HTMLElement).getByRole("link", { name: "开源声明" })).toHaveAttribute(
      "href",
      "/zh-hant/open-source-licenses",
    );
  });
});
