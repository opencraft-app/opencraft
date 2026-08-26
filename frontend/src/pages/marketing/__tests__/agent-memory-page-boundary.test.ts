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

  it("describes empty memory files directly", () => {
    const page = readPageSource();

    expect(page).toContain('t("MEMORY.md 文件为空")');
    expect(page).toContain('t("USER.md 文件为空")');
    expect(page).not.toContain('t("暂无 Agent 记忆。")');
    expect(page).not.toContain('t("暂无用户画像。")');
  });
});
