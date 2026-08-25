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

vi.mock("@next-site/support-page-client", () => ({
  SupportPageClient: () => "support-page",
}));

vi.stubGlobal("React", React);

describe("/support route", () => {
  it("renders the support page for the domestic build", async () => {
    mockIsGlobal = false;
    const { default: SupportPage } = await import("./page.next");

    expect(React.isValidElement(SupportPage())).toBe(true);
  });

  it("returns not found for the international build", async () => {
    mockIsGlobal = true;
    const { default: SupportPage } = await import("./page.next");

    expect(() => SupportPage()).toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });
});
