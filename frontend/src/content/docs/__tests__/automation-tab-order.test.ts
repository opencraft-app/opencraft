import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const frontendRoot = join(import.meta.dirname, "../../../..");

const AUTOMATION_DOCS = [
  {
    path: "src/content/docs/configuration/automation.md",
    tabs: ["当前任务", "已结束任务", "最近执行"],
    validationHeading: "## 结果校验",
  },
  {
    path: "src/content/docs/global/configuration/automation.md",
    tabs: ["当前任务", "已结束任务", "最近执行"],
    validationHeading: "## 结果校验",
  },
  {
    path: "src/content/docs/en/configuration/automation.md",
    tabs: ["Current Jobs", "Ended Jobs", "Recent Runs"],
    validationHeading: "## Validation",
  },
  {
    path: "src/content/docs/id/configuration/automation.md",
    tabs: ["Job Saat Ini", "Job Berakhir", "Eksekusi terbaru"],
    validationHeading: "## Validasi",
  },
  {
    path: "src/content/docs/es/configuration/automation.md",
    tabs: ["Jobs actuales", "Jobs finalizados", "Ejecuciones recientes"],
    validationHeading: "## Validación",
  },
  {
    path: "src/content/docs/ja/configuration/automation.md",
    tabs: ["現在のタスク", "終了したタスク", "最近の実行"],
    validationHeading: "## 結果の確認",
  },
  {
    path: "src/content/docs/ko/configuration/automation.md",
    tabs: ["현재 작업", "종료된 작업", "최근 실행"],
    validationHeading: "## 결과 확인",
  },
] as const;

function assertTabOrder(line: string, tabs: readonly [string, string, string]): void {
  const [currentIndex, endedIndex, recentIndex] = tabs.map((tab) => line.indexOf(tab)) as [
    number,
    number,
    number,
  ];
  expect([currentIndex, endedIndex, recentIndex].every((index) => index >= 0)).toBe(true);
  expect(currentIndex).toBeLessThan(endedIndex);
  expect(endedIndex).toBeLessThan(recentIndex);
}

describe("自动任务文档页签顺序", () => {
  it.each(AUTOMATION_DOCS)(
    "$path 的正文、图片说明与结果校验保持完整",
    ({ path, tabs, validationHeading }) => {
      const markdown = readFileSync(join(frontendRoot, path), "utf8");
      const lines = markdown.split("\n");
      const managementLine = lines.find(
        (line) => tabs.every((tab) => line.includes(tab)) && !line.startsWith("!["),
      );
      const imageLine = lines.find((line) => line.includes("automation-current-jobs.webp"));

      expect(managementLine).toBeDefined();
      expect(imageLine).toBeDefined();
      assertTabOrder(managementLine ?? "", tabs);
      assertTabOrder(imageLine ?? "", tabs);
      expect(markdown).toContain(validationHeading);
    },
  );
});
