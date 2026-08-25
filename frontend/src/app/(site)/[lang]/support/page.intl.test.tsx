import { describe, expect, it, vi } from "vitest";

const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

vi.mock("next/navigation", () => ({
  notFound: () => notFound(),
}));

describe("/[lang]/support route", () => {
  it("does not generate localized support pages for the international build", async () => {
    const { generateStaticParams } = await import("./page.intl");

    expect(generateStaticParams()).toEqual([]);
  });

  it("returns not found for localized international support pages", async () => {
    const { default: LocalizedSupportPage } = await import("./page.intl");

    expect(() => LocalizedSupportPage()).toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });
});
