import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Account referral visibility", () => {
  const page = readFileSync(
    join(process.cwd(), "src/pages/marketing/account-page.tsx"),
    "utf8",
  );

  it("keeps the referral section hidden until console show() reveals it", () => {
    expect(page).toContain("const [referralRevealed, setReferralRevealed] = useState(false);");
    expect(page).toContain("return subscribeConsoleShow(setReferralRevealed);");
    expect(page).toContain("referralEnabled && referralRevealed && <ReferralSection />");
  });
});
