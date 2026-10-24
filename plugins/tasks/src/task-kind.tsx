import { TASK_KINDS, type TaskKind } from "@opencraft/appserver-protocol";
import { useIntl } from "@opencraft/i18n/react";

const kindWords: Record<TaskKind, readonly [string, string]> = {
  unclassified: ["未分类", "Unclassified"], feature: ["功能需求", "Feature"], improvement: ["改进优化", "Improvement"], bug: ["缺陷修复", "Bug"], engineering: ["技术建设", "Engineering"], harness: ["Harness 建设", "Harness"], research: ["调研验证", "Research"], documentation: ["文档知识", "Documentation"], operations: ["发布运维", "Operations"], growth: ["运营增长", "Growth"], task: ["通用任务", "Task"],
};
export function useKindText() {
  const intl = useIntl();
  return (kind: string) => kindWords[kind as TaskKind]?.[intl.locale.startsWith("zh") ? 0 : 1] ?? kind;
}
export function KindBadge({ kind = "unclassified" }: { kind?: string }) {
  const label = useKindText();
  return <span className="tasks-kind" data-kind={TASK_KINDS.includes(kind as TaskKind) ? kind : "unknown"}>{label(kind)}</span>;
}
