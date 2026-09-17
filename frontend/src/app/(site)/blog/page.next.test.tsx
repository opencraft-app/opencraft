import React from "react";
import { describe, expect, it, vi } from "vitest";

let mockIsGlobal = false;

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
}));

vi.mock("@/lib/region", () => ({
  get isGlobal() {
    return mockIsGlobal;
  },
}));

vi.mock("@next-site/public-pages", () => ({
  PublicBlogPage: () => "blog-page",
}));

vi.stubGlobal("React", React);

describe("/blog route", () => {
  it("renders the Chinese Blog page for the domestic build", async () => {
    mockIsGlobal = false;
    const { default: BlogRoute } = await import("./page.next");

    expect(React.isValidElement(BlogRoute())).toBe(true);
  });

  it("renders the blog page for the international build", async () => {
    mockIsGlobal = true;
    const { default: BlogRoute } = await import("./page.next");

    expect(React.isValidElement(BlogRoute())).toBe(true);
  });
});
