import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readPageSource = () =>
  readFileSync(join(process.cwd(), "src/pages/marketing/agent-settings-page.tsx"), "utf8");

describe("Agent memory page async boundary", () => {
  it("scopes memory saves by Agent and request id", () => {
    const page = readPageSource();

    expect(page).toContain("activeMemoryBotIdRef");
    expect(page).toContain("memorySaveRequestIdRef");
    expect(page).toContain("isHermesMemoryOperationCurrent");
  });

  it("disables both limit cards while either target is saving", () => {
    const page = readPageSource();
    const disabledBindings = page.match(/isDisabled=\{savingLimitTarget !== null\}/g) ?? [];

    expect(disabledBindings).toHaveLength(2);
  });

  it("shows a partial-success message without claiming the config write failed", () => {
    const page = readPageSource();

    expect(page).toContain("配置已保存，但后续步骤失败");
    expect(page).toContain("saveResult.status === \"partial\"");
  });
});
