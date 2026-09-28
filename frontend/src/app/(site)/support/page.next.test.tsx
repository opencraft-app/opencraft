import React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@next-site/support-page-client", () => ({
  SupportPageClient: () => "support-page",
}));

vi.stubGlobal("React", React);

describe("/support route", () => {
  it("renders the support page", async () => {
    const { default: SupportPage } = await import("./page.next");

    expect(React.isValidElement(SupportPage())).toBe(true);
  });
});
