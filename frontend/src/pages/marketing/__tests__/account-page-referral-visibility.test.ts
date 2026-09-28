import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Account referral visibility", () => {
  const page = readFileSync(
    join(process.cwd(), "src/pages/marketing/account-page.tsx"),
    "utf8",
  );

  it("shows the referral section whenever the runtime feature is enabled", () => {
    expect(page).not.toContain("referralRevealed");
    expect(page).not.toContain("subscribeConsoleShow");
    expect(page).toContain("referralEnabled && <ReferralSection />");
  });
});
