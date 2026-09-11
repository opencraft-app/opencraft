import React from "react";
import { describe, expect, it, vi } from "vitest";

const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

let mockIsGlobal = false;

vi.mock("next/navigation", () => ({
  notFound: () => notFound(),
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
  it("returns not found for the domestic build", async () => {
    mockIsGlobal = false;
    const { default: BlogRoute } = await import("./page.next");

    expect(() => BlogRoute()).toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });

  it("renders the blog page for the international build", async () => {
    mockIsGlobal = true;
    const { default: BlogRoute } = await import("./page.next");

    expect(React.isValidElement(BlogRoute())).toBe(true);
  });
});
