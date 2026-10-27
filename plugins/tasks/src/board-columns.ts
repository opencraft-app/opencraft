import { TASK_STATUSES, type TaskKind, type TaskStatus } from "@opencraft/appserver-protocol";

export type BoardColumnId = Exclude<TaskStatus, "backlog"> | "product_backlog" | "technical_backlog";
export const BOARD_COLUMNS: readonly BoardColumnId[] = ["product_backlog", "technical_backlog", ...TASK_STATUSES.filter((status): status is Exclude<TaskStatus, "backlog"> => status !== "backlog")];
const technicalKinds: readonly string[] = ["engineering", "harness", "research", "documentation", "operations"];
export function boardColumn(task: { status: TaskStatus; kind?: string }): BoardColumnId {
  return task.status === "backlog" ? technicalKinds.includes(task.kind ?? "") ? "technical_backlog" : "product_backlog" : task.status;
}
export function columnStatus(column: BoardColumnId): TaskStatus {
  return column === "product_backlog" || column === "technical_backlog" ? "backlog" : column;
}
export function columnCreateKind(column: BoardColumnId, filter: string): TaskKind {
  if (columnStatus(column) !== "backlog" || (filter && boardColumn({ status: "backlog", kind: filter }) === column)) return (filter || "unclassified") as TaskKind;
  return column === "technical_backlog" ? "engineering" : "feature";
}
