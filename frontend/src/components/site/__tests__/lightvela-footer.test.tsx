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

// 当前语言可变，供不同用例切换。
let mockLanguage = "en-US";
let mockIsGlobal = true;

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
  get isGlobal() {
    return mockIsGlobal;
  },
  localizedPath: (path: string, locale: "zh-CN" | "zh-SG" | "zh-Hant" | "en-US" | "id-ID" | "es") => {
    const lang =
      locale === "zh-CN"
        ? "zh"
        : locale === "zh-SG"
          ? "zh-sg"
          : locale === "zh-Hant"
            ? "zh-hant"
            : locale === "id-ID"
              ? "id-id"
              : locale === "es"
                ? "es"
                : null;
    if (!lang) return path;
    return path === "/" ? `/${lang}/` : `/${lang}${path}`;
  },
}));

beforeEach(() => {
  mockLanguage = "en-US";
  mockIsGlobal = true;
});

afterEach(() => {
  cleanup();
});

describe("LightVelaFooter", () => {
  it("groups the international footer links under Product, Company, Community and Related Products", () => {
    render(
      <MemoryRouter>
        <LightVelaFooter />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "LightVela" })).toHaveAttribute("href", "/");

    // 产品栏：试用 / 定价指向订阅页，通道指引指向国际站三个渠道文档
    const productSection = screen.getByRole("heading", { name: "产品" }).closest("section");
    expect(productSection).not.toBeNull();
    const product = within(productSection as HTMLElement);
    expect(product.getAllByRole("link")[0]).toHaveAccessibleName("博客");
    expect(product.getAllByRole("link")[0]).toHaveAttribute("href", "/blog");
    expect(product.getByRole("link", { name: "14 天免费试用" })).toHaveAttribute("href", "/subscribe");
    expect(product.getByRole("link", { name: "定价" })).toHaveAttribute("href", "/subscribe");
    expect(product.getByRole("link", { name: "接入 WhatsApp 指引" })).toHaveAttribute(
      "href",
      "/docs/configuration/channel-whatsapp",
    );
    expect(product.getByRole("link", { name: "接入 Telegram 指引" })).toHaveAttribute(
      "href",
      "/docs/configuration/channel-telegram",
    );
    expect(product.getByRole("link", { name: "接入 Discord 指引" })).toHaveAttribute(
      "href",
      "/docs/configuration/channel-discord",
    );
    // 国内站专属通道不应出现在国际站页脚（两站分别描述，不混写）
    expect(product.queryByRole("link", { name: "接入 QQ 指引" })).toBeNull();
    expect(product.queryByRole("link", { name: "接入企微指引" })).toBeNull();

    // 公司栏：原「法律」栏已按需求合并进此栏
    const companySection = screen.getByRole("heading", { name: "公司" }).closest("section");
    expect(companySection).not.toBeNull();
    const company = within(companySection as HTMLElement);
    expect(company.getByRole("link", { name: "关于我们" })).toHaveAttribute("href", "/about");
    expect(company.queryByRole("link", { name: "帮助与反馈" })).not.toBeInTheDocument();
    expect(company.getByRole("link", { name: "隐私政策" })).toHaveAttribute("href", "/privacy-policy");
    expect(company.getByRole("link", { name: "服务条款" })).toHaveAttribute("href", "/terms-of-service");
    expect(company.getByRole("link", { name: "开源声明" })).toHaveAttribute(
      "href",
      "/open-source-licenses",
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

    // 对比栏：国际站 5 篇对比文档
    const compareSection = screen.getByRole("heading", { name: "对比" }).closest("section");
    expect(compareSection).not.toBeNull();
    const compare = within(compareSection as HTMLElement);
    expect(compare.getByRole("link", { name: "与本地部署对比" })).toHaveAttribute(
      "href",
      "/docs/compare/lightvela-vs-localhost-ai-agent",
    );
    expect(compare.getByRole("link", { name: "与 Hostinger 对比" })).toHaveAttribute(
      "href",
      "/docs/compare/lightvela-vs-hostinger",
    );
    expect(compare.getByRole("link", { name: "与 Manus 对比" })).toHaveAttribute(
      "href",
      "/docs/compare/lightvela-vs-manus",
    );
    expect(compare.getByRole("link", { name: "与 ChatGPT 对比" })).toHaveAttribute(
      "href",
      "/docs/compare/lightvela-vs-chatgpt",
    );
    expect(compare.getByRole("link", { name: "与 Genspark 对比" })).toHaveAttribute(
      "href",
      "/docs/compare/lightvela-vs-genspark",
    );
    // 国内站专属对比页不应出现在国际站
    expect(compare.queryByRole("link", { name: "与 AI Chatbot 对比" })).toBeNull();

    // 相关产品栏：仅国际站展示，带 from=lightvela 归因参数
    const relatedSection = screen.getByRole("heading", { name: "相关产品" }).closest("section");
    expect(relatedSection).not.toBeNull();
    expect(
      within(relatedSection as HTMLElement).getByRole("link", { name: "腾讯云开发 Tencent CloudBase" }),
    ).toHaveAttribute("href", "https://tcb.cloud.tencent.com/en/?from=lightvela");
    const edgeOneLink = within(relatedSection as HTMLElement).getByRole("link", { name: "Tencent EdgeOne" });
    expect(edgeOneLink).toHaveAttribute("href", "https://edgeone.ai/");
    expect(edgeOneLink).toHaveAttribute("target", "_blank");
    expect(edgeOneLink).toHaveAttribute("rel", "noopener noreferrer");

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
    const company = within(companySection as HTMLElement);
    expect(company.getByRole("link", { name: "关于我们" })).toHaveAttribute("href", "/zh-hant/about");
    expect(company.queryByRole("link", { name: "帮助与反馈" })).not.toBeInTheDocument();
    expect(company.getByRole("link", { name: "隐私政策" })).toHaveAttribute(
      "href",
      "/zh-hant/privacy-policy",
    );
    expect(company.getByRole("link", { name: "服务条款" })).toHaveAttribute(
      "href",
      "/zh-hant/terms-of-service",
    );
    expect(company.getByRole("link", { name: "开源声明" })).toHaveAttribute(
      "href",
      "/zh-hant/open-source-licenses",
    );

    const productSection = screen.getByRole("heading", { name: "产品" }).closest("section");
    expect(within(productSection as HTMLElement).getByRole("link", { name: "博客" })).toHaveAttribute(
      "href",
      "/zh-hant/blog",
    );
    expect(within(productSection as HTMLElement).getByRole("link", { name: "定价" })).toHaveAttribute(
      "href",
      "/zh-hant/subscribe",
    );
  });

  it("keeps the domestic Help and Feedback footer link on the Tencent questionnaire", () => {
    mockIsGlobal = false;
    mockLanguage = "zh-CN";
    render(
      <MemoryRouter>
        <LightVelaFooter />
      </MemoryRouter>,
    );

    const companySection = screen.getByRole("heading", { name: "公司" }).closest("section");
    expect(companySection).not.toBeNull();
    const supportLink = within(companySection as HTMLElement).getByRole("link", { name: "帮助与反馈" });
    expect(supportLink).toHaveAttribute("href", "https://wj.qq.com/s2/27184784/6d06/");
    expect(supportLink).toHaveAttribute("target", "_blank");
    expect(supportLink).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("link", { name: "博客" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Tencent EdgeOne" })).not.toBeInTheDocument();
  });

  it("keeps every Spanish footer link, including the logo, under /es", () => {
    mockLanguage = "es";
    render(
      <MemoryRouter>
        <LightVelaFooter />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "LightVela" })).toHaveAttribute("href", "/es/");

    const productSection = screen.getByRole("heading", { name: "产品" }).closest("section");
    expect(within(productSection as HTMLElement).getByRole("link", { name: "博客" })).toHaveAttribute(
      "href",
      "/es/blog",
    );

    const companySection = screen.getByRole("heading", { name: "公司" }).closest("section");
    const company = within(companySection as HTMLElement);
    expect(company.getByRole("link", { name: "关于我们" })).toHaveAttribute("href", "/es/about");
    expect(company.queryByRole("link", { name: "帮助与反馈" })).not.toBeInTheDocument();
    expect(company.getByRole("link", { name: "隐私政策" })).toHaveAttribute(
      "href",
      "/es/privacy-policy",
    );
    expect(company.getByRole("link", { name: "服务条款" })).toHaveAttribute(
      "href",
      "/es/terms-of-service",
    );
    expect(company.getByRole("link", { name: "开源声明" })).toHaveAttribute(
      "href",
      "/es/open-source-licenses",
    );
  });
});
