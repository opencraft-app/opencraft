import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readPageSource = () =>
  readFileSync(join(process.cwd(), "src/pages/marketing/agent-settings-page.tsx"), "utf8");
const readViewSource = () => readFileSync(join(process.cwd(), "src/pages/marketing/agent-memory-views.tsx"), "utf8");

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

  it("preserves line breaks and wraps long memory content", () => {
    const memoryEntries = readViewSource();

    expect(memoryEntries).toContain("whitespace-pre-wrap");
    expect(memoryEntries).toContain("break-words");
    expect(memoryEntries).not.toContain("truncate");
    expect(memoryEntries).not.toContain("toSingleLineMemoryEntry");
  });

  it("describes MEMORY.md as persistent memory", () => {
    const page = readPageSource();

    expect(page).toContain('查看当前 Hermes Agent 的持久记忆和用户画像文件');
    expect(page).not.toContain('查看当前 Hermes Agent 的记忆和用户画像文件');
  });

  it("keeps memory state ownership in the host and passes typed display actions", () => {
    const page = readPageSource();
    const memoryPanel = page.slice(
      page.indexOf("const MemoryPanel ="),
      page.indexOf("/* ─── Delete Confirm Dialog ─── */"),
    );

    expect(memoryPanel).toContain("<MemoryPanelView");
    expect(memoryPanel).toContain('refreshLabel={t("刷新")}');
    expect(memoryPanel).toContain("onRefresh={onRefresh}");
    expect(page).toContain("const [draftLimit, setDraftLimit]");
    expect(page).toContain("const saved = await onSaveLimit(target, validation.value, used)");
    const views = readViewSource();
    expect(views).toContain("AgentTooltip");
    expect(views).toContain("aria-label={refreshLabel}");
    expect(views).not.toMatch(/useRepositories|useOpenClaw|execDebugCommand|fetchHermes|saveHermes/);
  });
});
