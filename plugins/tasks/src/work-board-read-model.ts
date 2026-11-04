import type { TaskDetail } from "@opencraft/appserver-protocol";
import { activeFollowUpTask, followUpDwellStart, type FollowUpProjection } from "./ai-follow-up-model";
import { boardColumn } from "./board-columns";

/** Existing accessible Tasks data only. This projection grants no write or execution permission. */
export function workBoardReadRecord(task: TaskDetail, projection: FollowUpProjection, verified: boolean, since = 0) {
  const current = activeFollowUpTask(task), known = current && verified;
  const report = known ? projection.report : null;
  const needs = known && projection.lane === "needs";
  const judge = needs ? report?.judgeId ?? null : null;
  return {
    id: task.id, revision: task.revision, title: task.title,
    workflowStatus: task.status, workflowGroup: boardColumn(task), priority: task.priority ?? "none", ownerId: task.assigneeId ?? null,
    collaboration: { group: current ? verified ? projection.lane : "unknown" : "closed", verified: current ? verified : true,
      actionRequired: current && !verified ? null : needs,
      handlerId: judge ?? task.assigneeId ?? null,
      currentHumanActorId: judge,
      request: needs ? { roundId: report?.roundId ?? null, question: projection.decision, judgeId: judge, readyAt: projection.readyAt } : null,
      report, executionState: "unknown" },
    clock: { kind: "collaboration_state_dwell", startedAt: known ? followUpDwellStart(task, projection, since) : null, floor: since },
    conversations: task.conversations.map(link => ({ serverId: link.serverId, threadId: link.threadId })),
    context: { description: task.description, acceptanceCriteria: task.acceptanceCriteria ?? "" },
    source: { kind: "tasks-authority", updatedAt: task.updatedAt, latestProgressEventId: task.latestProgress?.eventId ?? null },
    access: { projection: "read-only", grantsExecution: false, grantsApproval: false },
  } as const;
}
