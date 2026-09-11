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

  it("preserves line breaks and wraps long memory content", () => {
    const page = readPageSource();
    const memoryEntries = page.slice(
      page.indexOf("const MemoryEntries ="),
      page.indexOf("const MemoryPanel ="),
    );

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

  it("uses the automations icon-only refresh button style", () => {
    const page = readPageSource();
    const memoryPanel = page.slice(
      page.indexOf("const MemoryPanel ="),
      page.indexOf("/* ─── Delete Confirm Dialog ─── */"),
    );

    expect(memoryPanel).toContain(
      'className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center text-black/35 transition hover:text-black/80 disabled:cursor-not-allowed disabled:text-black/20"',
    );
    expect(memoryPanel).toContain('aria-label={t("刷新")}');
    expect(memoryPanel).toContain('title={t("刷新")}');
    expect(memoryPanel).toContain('RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`}');
    expect(memoryPanel).not.toContain('Loader2 className="h-4 w-4 animate-spin"');
    expect(memoryPanel).not.toContain('\n            {t("刷新")}\n');
  });
});
