import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CN_COMMUNITY_QR_IMAGE, DISCORD_INVITE_URL, WHATSAPP_INVITE_URL } from "@/constants/community";
import { BlogCommunity } from "../blog-community";
import { canonicalBlogUrl } from "../blog-share-actions";

const region = vi.hoisted(() => ({ isGlobal: true }));
vi.mock("@/lib/region", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/region")>()),
  get isGlobal() { return region.isGlobal; },
}));

afterEach(() => { cleanup(); region.isGlobal = true; });

describe("Blog community ending", () => {
  it("shows accessible QR codes and direct links for both international communities", () => {
    render(<BlogCommunity />);
    expect(screen.getByRole("link", { name: /Join on Discord/ })).toHaveAttribute("href", DISCORD_INVITE_URL);
    expect(screen.getByRole("link", { name: /Join on WhatsApp/ })).toHaveAttribute("href", WHATSAPP_INVITE_URL);
    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(screen.getByRole("img", { name: "Discord community QR code" }).tagName.toLowerCase()).toBe("svg");
    expect(screen.getByRole("img", { name: "WhatsApp community QR code" }).tagName.toLowerCase()).toBe("svg");
    expect(screen.queryByAltText("微信交流群二维码")).not.toBeInTheDocument();
  });

  it("keeps international communities while translating the Chinese article ending", () => {
    render(<BlogCommunity locale="zh-SG" />);
    expect(screen.getByRole("heading", { name: "加入 LightVela 交流群" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /加入 Discord/ })).toHaveAttribute("href", DISCORD_INVITE_URL);
    expect(screen.getByRole("link", { name: /加入 WhatsApp/ })).toHaveAttribute("href", WHATSAPP_INVITE_URL);
    expect(screen.queryByAltText("微信交流群二维码")).not.toBeInTheDocument();
  });

  it("shows the shared WeChat code on the China site and shares a China URL", () => {
    region.isGlobal = false;
    render(<BlogCommunity />);
    expect(screen.getByRole("heading", { name: "加入 LightVela 交流群" })).toBeInTheDocument();
    expect(screen.getByAltText("微信交流群二维码")).toHaveAttribute("src", CN_COMMUNITY_QR_IMAGE);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(canonicalBlogUrl("/blog/hermes")).toBe("https://lightvela.com/blog/hermes");
  });

  it.each([
    ["id-ID", "Bergabung dengan komunitas LightVela", "Bergabung di Discord"],
    ["es", "Únete a la comunidad de LightVela", "Únete en Discord"],
    ["ja-JP", "LightVela コミュニティに参加", "Discord に参加"],
    ["ko-KR", "LightVela 커뮤니티에 참여하세요", "Discord에서 참여하기"],
  ] as const)("localizes the community ending for %s without changing its channels", (locale, heading, join) => {
    render(<BlogCommunity locale={locale} />);
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: new RegExp(join) })).toHaveAttribute("href", DISCORD_INVITE_URL);
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([DISCORD_INVITE_URL, WHATSAPP_INVITE_URL]);
    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(screen.queryByText("Join the LightVela community")).not.toBeInTheDocument();
  });
});
