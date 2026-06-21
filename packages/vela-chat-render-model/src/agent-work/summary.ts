import type { AgentWorkRenderRow } from "./tools";

export interface AgentWorkGroupSummary {
  title: string;
  summary: string;
}

export function summarizeAgentWorkGroup(rows: readonly AgentWorkRenderRow[]): AgentWorkGroupSummary {
  const counters = rows.reduce(
    (accumulator, row) => {
      const category = categoryForAgentWork(row);
      accumulator[category] += 1;
      return accumulator;
    },
    {
      command: 0,
      read: 0,
      search: 0,
      edit: 0,
      write: 0,
      other: 0,
    },
  );

  return {
    title: joinChinesePhrases([
      countChinese(counters.command, "已运行", "条命令"),
      countChinese(counters.read, "读取", "个文件"),
      countChinese(counters.search, "搜索", "次"),
      countChinese(counters.edit, "编辑", "个文件"),
      countChinese(counters.write, "写入", "个文件"),
      countChinese(counters.other, "处理", "项工作"),
    ]),
    summary: rows
      .map((row) => row.summary)
      .filter(Boolean)
      .slice(0, 4)
      .join(" · "),
  };
}

type AgentWorkCategory = "command" | "read" | "search" | "edit" | "write" | "other";

function categoryForAgentWork(row: AgentWorkRenderRow): AgentWorkCategory {
  switch (row.title) {
    case "Ran command":
    case "Running command":
      return "command";
    case "Read file":
      return "read";
    case "Searched code":
    case "Searched web":
      return "search";
    case "Edited file":
      return "edit";
    case "Wrote file":
      return "write";
    default:
      return "other";
  }
}

function countChinese(count: number, verb: string, noun: string): string {
  return count > 0 ? `${verb} ${count} ${noun}` : "";
}

function joinChinesePhrases(phrases: string[]): string {
  const active = phrases.filter(Boolean);
  if (active.length === 0) return "已处理工作";
  if (active.length === 1) return active[0]!;
  return `${active.slice(0, -1).join("、")}并${active[active.length - 1]}`;
}
