import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) =>
  readFileSync(join(process.cwd(), relativePath), "utf8");

describe("Private page footer boundary", () => {
  it("omits the product footer from every Agents settings page", () => {
    const page = readSource("src/pages/marketing/agent-settings-page.tsx");

    expect(page).not.toContain("ProductFooter");
  });

  it("disables the shared product footer on the account page", () => {
    const page = readSource("src/pages/marketing/account-page.tsx");

    expect(page).toContain(
      "<ProductPageShell afterFooter={pageOverlays} footer={null}>",
    );
  });

  it("omits the legal footer from the account orders page", () => {
    const page = readSource("src/pages/marketing/account-orders-page.tsx");

    expect(page).not.toContain("LegalFooter");
  });

  it("removes the obsolete chat-page footer layout rule", () => {
    const styles = readSource("src/styles.css");

    expect(styles).not.toContain(".lv-agent-chat-page > footer");
  });
});
