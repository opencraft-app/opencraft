import type { TaskContent, TaskDetail, TaskStatus } from "@opencraft/appserver-protocol";
export interface TaskDraft extends TaskContent { readonly id: string; readonly status: TaskStatus; readonly revision: number | null }
export function taskDraft(task?: TaskDetail, status: TaskStatus = "backlog"): TaskDraft {
  return { id: task?.id ?? crypto.randomUUID(), title: task?.title ?? "", description: task?.description ?? "", status: task?.status ?? status, revision: task?.revision ?? null, projectServerId: task?.projectServerId ?? null, projectId: task?.projectId ?? null, assigneeId: task?.assigneeId ?? null, priority: task?.priority ?? "none", dueDate: task?.dueDate ?? null, aiResearch: task?.aiResearch ?? "unassessed", aiResearchReason: task?.aiResearchReason ?? "", kind: task?.kind ?? "unclassified", acceptanceCriteria: task?.acceptanceCriteria ?? "" };
}
/** Activation-scoped owner; quick/full presentation and navigation share one draft. */
export class TasksEditorSession {
  private drafts = new Map<string, TaskDraft>();
  private bases = new Map<string, TaskDraft>();
  private newDraftId: string | null = null;
  private state: { draft: TaskDraft | null; presentation: "quick" | "detail" } = { draft: null, presentation: "detail" };
  private listeners = new Set<() => void>();
  readonly progressDrafts = new Map<string, string>();
  readonly inlineDrafts = new Map<TaskStatus, { id: string; title: string }>();
  setProgress(taskId: string, text: string) { if (text) this.progressDrafts.set(taskId, text); else this.progressDrafts.delete(taskId); this.publish({}); }
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private publish(change: Partial<typeof this.state>) { this.state = { ...this.state, ...change }; for (const fn of this.listeners) fn(); }
  open(task?: TaskDetail, status: TaskStatus = "backlog", presentation: "quick" | "detail" = "detail") {
    const id = task?.id ?? this.newDraftId;
    const retained = id ? this.drafts.get(id) : null;
    if (task && !retained) this.bases.set(task.id, taskDraft(task));
    const draft = retained ?? taskDraft(task, status);
    this.set(draft); this.publish({ presentation });
  }
  set(draft: TaskDraft | null) {
    if (draft) { if (JSON.stringify(this.bases.get(draft.id)) === JSON.stringify(draft)) this.drafts.delete(draft.id); else this.drafts.set(draft.id, draft); if (draft.revision === null) this.newDraftId = draft.id; }
    this.publish({ draft });
  }
  full() { this.publish({ presentation: "detail" }); }
  saved(task: TaskDetail) { if (task.id === this.newDraftId) this.newDraftId = null; this.bases.set(task.id, taskDraft(task)); this.set(taskDraft(task)); }
  rebase(task: TaskDetail) { const base = this.bases.get(task.id); if (base) this.bases.set(task.id, { ...base, status: task.status, revision: task.revision }); if (this.state.draft?.id === task.id) this.set({ ...this.state.draft, status: task.status, revision: task.revision }); }
  close() { this.publish({ draft: null }); }
  clear() { this.drafts.clear(); this.bases.clear(); this.progressDrafts.clear(); this.inlineDrafts.clear(); this.newDraftId = null; this.close(); this.listeners.clear(); }
}
