import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) =>
  readFileSync(join(process.cwd(), relativePath), "utf8");

describe("Account route footer boundary", () => {
  it("omits the auth-gate footer on the account route", () => {
    const source = readSource("next-site/account-page-client.tsx");

    expect(source).toContain(
      "<AppRouteShell loadingFallback={<AccountRouteLoading />} showAuthGateFooter={false}>",
    );
  });

  it("omits the auth-gate footer on the account orders route", () => {
    const source = readSource("next-site/account-orders-page-client.tsx");

    expect(source).toContain(
      "<AppRouteShell loadingFallback={<AccountOrdersRouteLoading />} showAuthGateFooter={false}>",
    );
  });
});
