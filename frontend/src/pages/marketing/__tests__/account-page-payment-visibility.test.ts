import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Account payment methods visibility", () => {
  const readAccountPageSource = () => readFileSync(
    join(process.cwd(), "src/pages/marketing/account-page.tsx"),
    "utf8",
  );

  it("shows saved payment methods by default on the international billing page", () => {
    const page = readAccountPageSource();

    expect(page).toContain("isBillingView && isGlobal && <SavedCardsSection />");
    expect(page).not.toContain("showHiddenAccountTools");
    expect(page).not.toContain("RevealAccountToolsHost");
  });
});
