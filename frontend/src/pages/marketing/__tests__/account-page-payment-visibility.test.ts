import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Account payment methods visibility", () => {
  const readAccountPageSource = () => readFileSync(
    join(process.cwd(), "src/pages/marketing/account-page.tsx"),
    "utf8",
  );

  it("keeps saved payment methods behind show()", () => {
    const page = readAccountPageSource();

    expect(page).toContain("setShowHiddenAccountTools(true)");
    expect(page).toContain("isGlobal && showHiddenAccountTools && <SavedCardsSection />");
  });

  it("chains the account reveal with an existing show() helper", () => {
    const page = readAccountPageSource();

    expect(page).toContain("const originalShow = host.show");
    expect(page).toContain("originalShow.apply(host, args)");
  });
});
