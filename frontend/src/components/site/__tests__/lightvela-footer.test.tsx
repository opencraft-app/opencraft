import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { LightVelaFooter } from "@/components/site/lightvela-footer";

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string) => text,
}));

vi.mock("@/lib/region", () => ({
  isGlobal: true,
}));

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
      "/about",
    );

    const legalSection = screen.getByRole("heading", { name: "法律" }).closest("section");
    expect(legalSection).not.toBeNull();
    expect(within(legalSection as HTMLElement).getByRole("link", { name: "隐私政策" })).toHaveAttribute(
      "href",
      "/privacy-policy",
    );
    expect(within(legalSection as HTMLElement).getByRole("link", { name: "服务条款" })).toHaveAttribute(
      "href",
      "https://cloud.tencent.com/document/product/301/48034",
    );
    expect(within(legalSection as HTMLElement).getByRole("link", { name: "开源声明" })).toHaveAttribute(
      "href",
      "/open-source-licenses",
    );

    const communitySection = screen.getByRole("heading", { name: "社区" }).closest("section");
    expect(communitySection).not.toBeNull();
    expect(within(communitySection as HTMLElement).getByRole("link", { name: "Discord" })).toHaveAttribute(
      "href",
      "https://discord.com/invite/NDqtU3JQTc",
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
});
