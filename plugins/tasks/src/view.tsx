import { UrgentPriorityIcon, ArrowUpIcon, ArrowDownIcon, MinusIcon } from "@opencraft/design-system-web/action-icons";
import { ChevronRightIcon } from "@opencraft/design-system-web/action-icons";
import { AddIcon as Plus, DeleteIcon as Trash2, CloseIcon as X, EditIcon as Pencil, MoreIcon as MoreHorizontal, RefreshIcon as RefreshCw } from "@opencraft/design-system-web/action-icons";
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import * as Dialog from "@radix-ui/react-dialog";
import { ChartIcon as ChartNoAxesCombined, SunriseIcon as Sunrise, ColumnsIcon as Columns3, ListIcon as List, SlidersIcon as SlidersHorizontal, MessageIcon as MessageSquare, ArrowUpRightIcon as ArrowUpRight, PersonIcon as UserRound, ArrowLeftIcon as ArrowLeft, ArchiveIcon as Archive, RestoreArchiveIcon as ArchiveRestore } from "@opencraft/design-system-web/action-icons";
import type { TrustedExtensionApiV1 } from "@opencraft/extension-runtime";
import { ownMemberId } from "./own-member";
import { MemberAvatar } from "./member-avatar";
import {
  SegmentedControl,
  SettingsButton,
  SettingsNotice,
  SettingsSelect,
  SettingsTextInput,
  type ExtensionSettingsViewProps,
  type PlatformViewHost,
} from "@opencraft/extension-react";
import { legacyDirectServerProjectionFromHost } from "@opencraft/workbench-runtime";
import { useIntl } from "@opencraft/i18n/react";
import {
  TASKS,
  TASK_STATUSES,
  TASK_PRIORITIES,
  TASK_KINDS,
  TASK_AI_RESEARCH,
  type TaskMember,
  type TasksMethodMap,
  type TaskContent,
  type TaskDetail,
  type TaskConversation,
  type TaskStatus,
} from "@opencraft/appserver-protocol";
import type { TasksExtensionPorts, TaskConversationActivity } from "./index";
import { TasksEditorSession, taskDraft as draftFor, type TaskDraft as Draft } from "./editor-session";
import { TaskActivityController } from "./activity-controller";
import { TasksArchiveController } from "./archive-controller";
import { TasksController } from "./controller";
import "./styles.scss";
import { TaskDescriptionField } from "./description-field";
import { KindBadge, useKindText } from "./task-kind";
import { AIFollowUp, type FollowUpSelection } from "./ai-follow-up";
import { MorningOverview } from "./morning-overview";
import { parseFollowUpReport } from "./ai-follow-up-model";
import { parseResearchHandoff } from "./research-handoff";
const ConversationOverview = lazy(() => import("./conversation-overview").then(module => ({ default: module.ConversationOverview })));
const words = {
  morningOverview: ["晨会总览", "Morning overview"],
  aiFollowUp: ["AI 跟进", "AI follow-up"],
  morningShort: ["晨会", "Morning"],
  aiResearch: ["AI 主动预研", "AI research"],
  allResearch: ["全部预研判断", "All research dispositions"],
  researchUnassessed: ["未判断", "Unassessed"],
  researchProactive: ["可主动预研", "AI can start research"],
  researchContext: ["需补充上下文", "Needs context"],
  researchDecision: ["需人判断", "Needs a decision"],
  researchReason: ["判断依据／缺少的信息", "Rationale / missing information"],
  researchHint: ["主管家先分流；此字段不启动会话，也不开始等待计时。", "Initial triage only; this field does not start a conversation or a waiting clock."],
  archive: ["归档任务", "Archive task"],
  archivedTasks: ["归档", "Archived tasks"],
  archiveHint: ["归档任务长期留底，不占用当前看板。恢复后回到原状态列。", "Archived tasks are retained outside the board. Restore an item to its original status column."],
  archiveSearch: ["搜索归档的标题、说明、验收标准或编号…", "Search archived titles, descriptions, criteria or IDs…"],
  archiveEmpty: ["暂无归档任务", "No archived tasks"],
  archiveNoResults: ["没有匹配的归档任务", "No matching archived tasks"],
  archiveReadError: ["归档读取失败，请刷新重试。", "Could not load archived tasks. Refresh to retry."],
  archiveMore: ["加载更多", "Load more"],
  archiveDate: ["归档时间", "Archived on"],
  archiveReadOnly: ["此任务已归档，内容和历史已保留。恢复到看板后可继续编辑。", "This item is archived. Its content and history are retained. Restore it to the board to edit."],
  archiveSaveFirst: ["请先保存修改，再归档任务", "Save your changes before archiving"],
  archiveRestore: ["恢复到看板", "Restore to board"],
  refreshArchive: ["刷新归档", "Refresh archived tasks"],
  event_archived: ["归档了事项", "Archived the item"],
  event_unarchived: ["恢复到看板", "Restored to the board"],
  kind: ["事项类型", "Type"],
  allKinds: ["所有类型", "All types"],
  acceptance: ["验收标准", "Acceptance criteria"],
  template: ["填入参考模板", "Use a starter template"],
  quickEdit: ["快速编辑", "Quick edit"],
  fullDetails: ["打开完整详情", "Open full details"],
  inlineAdd: ["添加事项", "Add an item"],
  inlineTitle: ["输入标题，Enter 添加", "Enter a title, then press Enter"],
  inheritedFilters: ["新事项沿用当前类型和项目筛选", "New items use the current type and project filters"],
  hiddenCreated: ["事项已创建，当前筛选未显示它。", "Item created; it is hidden by the current filters."],
  contentTab: ["内容", "Content"],
  activityTab: ["活动", "Activity"],
  progressText: ["记录进展、结论或下一步…", "Record progress, a finding or the next step…"],
  postProgress: ["发布进展", "Post progress"],
  activityEmpty: ["暂无活动记录", "No activity yet"],
  moreActivity: ["更早的活动", "Earlier activity"],
  activityReadError: ["活动读取失败，已保留现有记录。", "Could not refresh activity. Existing records are retained."],
  progressUnknown: ["结果尚未确认，请保留原文并重试核对。", "The result is unconfirmed. Retain the text and retry to reconcile."],
  unverifiedActor: ["身份未确认", "Identity unconfirmed"],
  agentEntry: ["Agent 入口", "Agent entry"],
  event_created: ["创建了事项", "Created the item"],
  event_updated: ["更新了", "Updated"],
  event_status_changed: ["调整了状态", "Changed status"],
  event_linked: ["关联了会话", "Linked a conversation"],
  event_unlinked: ["解除了会话关联", "Unlinked a conversation"],
  event_deleted: ["删除了事项", "Deleted the item"],
  event_restored: ["恢复了事项", "Restored the item"],
  event_progress: ["记录了进展", "Reported progress"],
  tasks: ["看板", "Board"],
  conversationOverview: ["任务统计", "Task stats"],
  searchTasks: ["搜索任务…", "Search tasks…"],
  assignee: ["负责人", "Assignee"],
  unassigned: ["未分配", "Unassigned"],
  allPeople: ["所有负责人", "All assignees"],
  priority: ["优先级", "Priority"],
  dueDate: ["截止日期", "Due date"],
  noPriority: ["无优先级", "No priority"],
  low: ["低", "Low"], normal: ["中", "Normal"], high: ["高", "High"], urgent: ["紧急", "Urgent"],
  overdue: ["已逾期", "Overdue"],
  results: ["项任务", "tasks"],
  clearFilters: ["清除筛选", "Clear filters"],
  filters: ["筛选", "Filters"],
  myTasks: ["我的任务", "My tasks"],
  myMember: ["我的成员账号", "My member account"],
  chooseMyMember: ["选择自己的成员账号", "Choose your member account"],
  noResults: ["没有符合筛选的任务", "No matching tasks"],
  addMember: ["添加团队成员", "Add team member"],
  memberName: ["姓名", "Name"],
  avatarProfile: ["头像资料", "Avatar profile"],
  identityKind: ["身份类型", "Identity kind"],
  identityId: ["身份账号", "Identity account"],
  employeeIdentity: ["员工", "Employee"],
  noIdentity: ["不关联身份", "No identity link"],
  identityHint: ["关联员工账号以显示头像，不会更改任务分配或登录权限。", "Link an employee account to show their photo. Task assignment and sign-in permissions stay the same."],
  saveIdentity: ["保存头像资料", "Save avatar profile"],
  identityChanged: ["成员资料已更新，请载入最新资料后再保存。", "This member profile changed. Load the latest profile before saving."],
  latestIdentity: ["载入最新资料", "Load latest profile"],
  memberId: ["成员标识（邮箱或员工账号）", "Member ID (email or employee handle)"],
  memberHint: ["用于分配任务，不会授予系统权限。", "For task ownership; does not grant system access."],

  board: ["看板", "Board"],
  list: ["列表", "List"],
  add: ["新建任务", "New task"],
  edit: ["任务详情", "Task details"],
  title: ["标题", "Title"],
  description: ["说明", "Description"],
  expandDescription: ["展开", "Expand"],
  collapseDescription: ["收起", "Collapse"],
  save: ["保存", "Save"],
  close: ["关闭任务详情", "Close task details"],
  closeButton: ["关闭", "Close"],
  remove: ["删除任务", "Delete task"],
  cancel: ["返回任务", "Back to tasks"],
  recycleBin: ["回收站", "Recycle bin"],
  restore: ["恢复", "Restore"],
  restoreError: ["未能确认恢复结果，请刷新回收站后重试。", "Could not confirm the restore. Refresh the recycle bin and retry."],
  restoring: ["恢复中…", "Restoring…"],
  recycleHint: ["删除的任务可在 7 天内恢复，保留描述和关联会话。", "Deleted tasks can be restored within 7 days, including their description and linked conversations."],
  recycleEmpty: ["回收站为空", "Recycle bin is empty"],
  restoreBy: ["可恢复至", "Restore by"],
  refresh: ["刷新", "Refresh"],
  refreshBoard: ["刷新看板", "Refresh board"],
  refreshRecycle: ["刷新回收站", "Refresh recycle bin"],
  moreActions: ["更多操作", "More actions"],
  loading: ["正在读取任务…", "Loading tasks…"],
  loadError: ["任务加载失败，请重试。", "Could not load tasks. Please retry."],
  retry: ["重试", "Retry"],
  empty: ["暂无任务", "No tasks yet"],
  unavailable: [
    "任务后端不可用，请恢复连接后重试。",
    "Tasks storage is unavailable. Restore the connection and retry.",
  ],
  conflict: [
    "任务已被其他窗口修改，请核对最新内容。",
    "Another window changed this task. Review the latest content.",
  ],
  saveError: [
    "未能确认保存结果，请核对后重试。",
    "Could not confirm the save. Review the task before retrying.",
  ],
  refreshError: [
    "暂时无法刷新，已保留上次读取的任务。",
    "Could not refresh. Previously loaded tasks are retained.",
  ],
  newer: [
    "任务已有更新，你的输入已保留。",
    "This task changed. Your draft is retained.",
  ],
  latest: ["载入最新内容", "Load latest content"],
  removed: [
    "任务已不在当前看板，你的输入仍保留。",
    "This task is no longer on the board. Your draft is retained.",
  ],
  status: ["任务状态", "Task status"],
  move: ["移动到", "Move to"],
  backlog: ["待规划", "Backlog"],
  todo: ["待办", "To do"],
  in_progress: ["进行中", "In progress"],
  in_review: ["待审核", "In review"],
  done: ["已完成", "Done"],
  canceled: ["已取消", "Canceled"],
  source: ["会话连接", "Conversation connection"],
  search: ["搜索会话", "Search conversations"],
  conversation: ["选择会话", "Select conversation"],
  loadingConversations: ["正在读取会话…", "Loading conversations…"],
  noConversations: ["此连接没有符合条件的会话", "No matching conversations on this connection"],
  attach: ["关联会话", "Link conversation"],
  detach: ["解除关联", "Unlink"],
  open: ["打开会话", "Open conversation"],
  newConversation: ["新建会话", "New conversation"],
  executionSource: ["执行连接", "Execution connection"],
  prepareError: ["未能打开聊天，请检查连接后重试。", "Could not open chat. Check the connection and retry."],
  pendingLink: ["会话已创建，关联尚未完成。", "Conversation created; linking is incomplete."],
  retryLink: ["重试关联", "Retry linking"],
  links: ["关联会话", "Conversations"],
  moreLinks: ["查看全部关联会话", "View all linked conversations"],
  choose: ["请选择", "Choose"],
  none: ["无", "None"],
  readError: [
    "无法读取此连接，请重试。",
    "Could not read this connection. Please retry.",
  ],
  routeError: [
    "会话连接不可用，请先恢复连接。",
    "The conversation connection is unavailable. Restore it first.",
  ],
  running: ["执行中", "Running"],
  waiting: ["等待输入", "Waiting"],
  idle: ["空闲", "Idle"],
  failed: ["执行异常", "Failed"],
  unknown: ["状态未知", "Unknown"],
  projectSource: ["项目连接", "Project connection"],
  project: ["项目", "Project"],
  allProjects: ["所有项目", "All projects"],
  view: ["任务视图", "Task view"],
} as const;
function useText() {
  const intl = useIntl();
  return (key: keyof typeof words) =>
    words[key][intl.locale.startsWith("zh") ? 0 : 1];
}
function starterTemplate(kind: string, chinese: boolean) {
  if (chinese) {
    const prompts: Record<string, string> = { bug: "复现步骤：\n\n预期表现：\n\n实际表现：\n\n影响范围：", growth: "目标人群：\n\n增长假设：\n\n行动与渠道：\n\n观察指标与时间窗：", harness: "目标能力与风险：\n\n测试场景或样本：\n\n评估指标：\n\n基线与回归方式：", research: "待验证问题：\n\n假设与方法：\n\n证据与结论：" };
    return { description: prompts[kind] ?? "背景与问题：\n\n期望结果：\n\n范围与方案：", acceptanceCriteria: "可验证的结果：\n\n验证方式与证据：" };
  }
  return { description: kind === "bug" ? "Steps to reproduce:\n\nExpected:\n\nActual:\n\nImpact:" : kind === "growth" ? "Audience:\n\nGrowth hypothesis:\n\nActions and channels:\n\nMetrics and observation window:" : kind === "harness" ? "Target capability and risk:\n\nScenarios or samples:\n\nEvaluation metrics:\n\nBaseline and regression:" : "Context and problem:\n\nDesired outcome:\n\nScope and approach:", acceptanceCriteria: "Verifiable outcome:\n\nVerification and evidence:" };
}
function ActivityPanel({ model, session, canPost, ports }: { model: TaskActivityController; session: TasksEditorSession; canPost: boolean; ports: TasksExtensionPorts }) {
  const t = useText(), intl = useIntl();
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const text = useSyncExternalStore(session.subscribe, () => session.progressDrafts.get(model.taskId) ?? "", () => "");
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void model.refresh(); };
    refresh();
    const stop = ports.subscribe(kind => { if (kind === "tasks") refresh(); });
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { stop(); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [model, ports]);
  const fields: Record<string, keyof typeof words> = { title: "title", description: "description", kind: "kind", acceptanceCriteria: "acceptance", aiResearch: "aiResearch", aiResearchReason: "researchReason", assigneeId: "assignee", priority: "priority", dueDate: "dueDate", projectId: "project", projectServerId: "projectSource" };
  return <section className="tasks-activity" aria-label={t("activityTab")}>
    <h3>{t("activityTab")}</h3>
    {canPost ? <div className="tasks-progress-composer">
      <textarea aria-label={t("progressText")} placeholder={t("progressText")} maxLength={4096} value={text} disabled={state.pending || state.error === "unknown" || state.error === "conflict" || state.error === "write"} onChange={event => session.setProgress(model.taskId, event.target.value)} />
      <SettingsButton type="button" variant="primary" disabled={state.pending || !text.trim()} onClick={() => { void model.append(text).then(saved => { if (saved) { if (session.progressDrafts.get(model.taskId) === text) session.setProgress(model.taskId, ""); } }); }}>{t(state.error === "unknown" ? "refresh" : "postProgress")}</SettingsButton>
    </div> : null}
    {state.error ? <SettingsNotice tone="error">{t(state.error === "read" ? "activityReadError" : "progressUnknown")} {state.error === "read" ? <SettingsButton type="button" onClick={() => void model.refresh()}>{t("refresh")}</SettingsButton> : null}</SettingsNotice> : null}
    {!state.events.length ? <p className="tasks-activity__empty">{t(state.loading ? "loading" : "activityEmpty")}</p> : null}
    <ol>{state.events.map(event => <li key={event.eventId} data-event-id={event.eventId}>
      <div className="tasks-activity__meta"><span>{event.actor?.label ?? event.actor?.id ?? t(event.channel === "agent" ? "agentEntry" : "unverifiedActor")}</span><time dateTime={new Date(event.createdAt).toISOString()}>{new Date(event.createdAt).toLocaleString(intl.locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></div>
      <p>{t(event.type === "updated" && typeof event.payload.archived === "boolean" ? event.payload.archived ? "event_archived" : "event_unarchived" : `event_${event.type}`)}{event.type === "updated" && typeof event.payload.archived !== "boolean" && Array.isArray(event.payload.fields) ? ` · ${event.payload.fields.map(field => fields[String(field)] ? t(fields[String(field)]!) : String(field)).join("、")}` : ""}{event.type === "status_changed" ? ` · ${TASK_STATUSES.includes(event.payload.from as TaskStatus) ? t(event.payload.from as TaskStatus) : ""} → ${TASK_STATUSES.includes(event.payload.to as TaskStatus) ? t(event.payload.to as TaskStatus) : ""}` : ""}</p>
      {event.type === "progress" ? <p className="tasks-activity__text">{(() => { const structured = parseFollowUpReport(event.payload.text); if (structured) return [structured.phase, structured.summary, structured.artifact, structured.decision, structured.roundId, structured.judgeId].filter(Boolean).join("\n\n"); const report = parseResearchHandoff(event.payload.text); return report ? intl.locale.startsWith("zh") ? `阶段产出：${report.output}\n\n需要判断：${report.decision}\n\n判断后下一步：${report.nextStep}` : `Output: ${report.output}\n\nDecision: ${report.decision}\n\nNext step: ${report.nextStep}` : String(event.payload.text ?? ""); })()}</p> : null}
    </li>)}</ol>
    {state.nextBeforeSeq !== null ? <SettingsButton type="button" disabled={state.loading} onClick={() => void model.refresh(true)}>{t("moreActivity")}</SettingsButton> : null}
  </section>;
}
function origin(host: PlatformViewHost, hostId: string): string | null {
  const p = host.profiles.find((p) => p.hostId === hostId);
  return p
    ? legacyDirectServerProjectionFromHost({
        hostId: p.hostId,
        hostKind: p.hostKind,
        label: p.displayName,
      }).serverOrigin.serverId
    : null;
}
function hostFor(host: PlatformViewHost, serverId: string): string | undefined {
  return host.profiles.find(
    (p) => p.enabled && origin(host, p.hostId) === serverId,
  )?.hostId;
}
function linkKey(link: Pick<TaskConversation, "serverId" | "threadId">): string {
  return JSON.stringify([link.serverId, link.threadId]);
}
interface ViewDraft {
  mode: "board" | "list" | "ai";
  status: TaskStatus;
  project: string;
  search: string;
  assignee: string;
  overdue: boolean;
  kind: string;
  aiResearch: string;
}
function researchLabel(mode: string, t: ReturnType<typeof useText>): string {
  return mode === "unassessed" ? t("researchUnassessed") : mode === "proactive" ? t("researchProactive") : mode === "needs_context" ? t("researchContext") : mode === "needs_decision" ? t("researchDecision") : mode;
}
function ResearchBadge({ task }: { task: TaskDetail }) {
  const t = useText();
  return task.aiResearch && task.aiResearch !== "unassessed" ? <span className="tasks-research" data-research={task.aiResearch} title={task.aiResearchReason}>{researchLabel(task.aiResearch, t)}</span> : null;
}
function isOverdue(task: TaskDetail): boolean {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
  return !!task.dueDate && task.dueDate < today && task.status !== "done" && task.status !== "canceled";
}
function TaskMeta({ task, members, compactOwner = false }: { task: TaskDetail; members: readonly TaskMember[]; compactOwner?: boolean }) {
  const t = useText();
  const member = members.find(member => member.id === task.assigneeId);
  const name = member?.name ?? task.assigneeId ?? t("unassigned");
  return <div className={`tasks-meta${compactOwner ? " tasks-meta--card" : ""}`}>
    {task.priority && task.priority !== "none" ? <span className={`tasks-priority tasks-priority--${task.priority}`} title={t("priority")}>{task.priority === "urgent" ? <UrgentPriorityIcon size={14} /> : task.priority === "high" ? <ArrowUpIcon size={14} /> : task.priority === "low" ? <ArrowDownIcon size={14} /> : <MinusIcon size={14} />} {t(task.priority)}</span> : null}
    {task.dueDate ? <time dateTime={task.dueDate} className={isOverdue(task) ? "tasks-due tasks-due--overdue" : "tasks-due"} title={`${t("dueDate")}: ${task.dueDate}${isOverdue(task) ? ` · ${t("overdue")}` : ""}`}>{task.dueDate.slice(5).replace("-", "/")}</time> : null}
    <span className="tasks-owner" title={`${t("assignee")}: ${name}`} role={compactOwner ? "img" : undefined} aria-label={compactOwner ? `${t("assignee")}: ${name}` : undefined}><MemberAvatar member={member} name={name} assigned={!!task.assigneeId} />{compactOwner ? null : <span className="tasks-owner__name">{name}</span>}</span>
  </div>;
}
type TaskCardProps = {
  task: TaskDetail;
  members: readonly TaskMember[];
  pending: boolean;
  onEdit(): void;
  onQuick?(): void;
  onArchive?(): void;
  onOpen(link: TaskConversation): void;
  activity: ReadonlyMap<string, TaskConversationActivity>;
};
function TaskConversationShortcut({ task, activity, onOpen, onEdit }: Pick<TaskCardProps, "task" | "activity" | "onOpen" | "onEdit">) {
  const t = useText();
  const link = task.conversations[0];
  if (!link) return null;
  const info = activity.get(linkKey(link));
  // Failed reads use the stable Thread ID as their transport fallback title.
  // Keep the relationship usable without presenting that ID as a human title.
  const named = Boolean(info?.title.trim() && info.title !== link.threadId);
  const title = named ? info!.title : t("open");
  const state = info?.state;
  return <div className="tasks-conversation" role="group" aria-label={t("links")}>
    <SettingsButton type="button" variant="ghost" className="tasks-conversation__open"
      aria-label={`${t("open")}: ${named ? title : task.title}`} title={title} onClick={() => onOpen(link)}>
      <span className="tasks-conversation__icon"><MessageSquare size={14} aria-hidden="true" /></span>
      <span className="tasks-conversation__title">{title}</span>
      {state && state !== "unknown" ? <span className="tasks-conversation__state" data-state={state}>{t(state)}</span> : null}
      <ArrowUpRight size={14} className="tasks-conversation__arrow" aria-hidden="true" />
    </SettingsButton>
    {task.conversations.length > 1 ? <SettingsButton type="button" variant="ghost"
      className="tasks-conversation__more" aria-label={`${t("moreLinks")} (${task.conversations.length})`}
      onClick={onEdit}>+{task.conversations.length - 1}<span>{t("moreLinks")}</span></SettingsButton> : null}
  </div>;
}
function TaskCardContents({ task, members, onEdit, onQuick, onArchive, onOpen, activity }: Omit<TaskCardProps, "pending">) {
  const t = useText();
  const afterMenuClose = useRef<(() => void) | null>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  return <>
      <div className="tasks-card__type"><KindBadge kind={task.kind} />{onQuick ? <div className="tasks-card__tools">
        <SettingsButton variant="ghost" className="tasks-card__quick" aria-label={`${t("quickEdit")}: ${task.title}`} onClick={onQuick}><Pencil size={14} aria-hidden="true" /></SettingsButton>
        <DropdownMenu.Root><DropdownMenu.Trigger ref={menuTrigger} asChild><SettingsButton variant="ghost" aria-label={`${t("edit")}: ${task.title}`}><MoreHorizontal size={15} aria-hidden="true" /></SettingsButton></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="tasks-card-menu" sideOffset={4}
          onCloseAutoFocus={event => {
            // Release the menu layer before mounting the next modal surface.
            const action = afterMenuClose.current;
            afterMenuClose.current = null;
            if (action) { event.preventDefault(); menuTrigger.current?.focus({ preventScroll: true }); action(); }
          }}>
          <DropdownMenu.Item onSelect={() => { afterMenuClose.current = onQuick ?? null; }}>{t("quickEdit")}</DropdownMenu.Item><DropdownMenu.Item onSelect={() => { afterMenuClose.current = onEdit; }}>{t("fullDetails")}</DropdownMenu.Item>
          {onArchive ? <DropdownMenu.Item onSelect={onArchive}>{t("archive")}</DropdownMenu.Item> : null}
        </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
      </div> : null}</div>
      <div className="tasks-card__heading">
        <button type="button" className="tasks-card__title" onClick={onEdit}>
          {task.title}
        </button>
      </div>
      {task.latestProgress ? <p className="tasks-card__progress" title={parseFollowUpReport(task.latestProgress.text)?.summary ?? parseResearchHandoff(task.latestProgress.text)?.output ?? task.latestProgress.text}>{parseFollowUpReport(task.latestProgress.text)?.summary ?? parseResearchHandoff(task.latestProgress.text)?.output ?? task.latestProgress.text}</p> : null}
      <TaskConversationShortcut task={task} activity={activity} onOpen={onOpen} onEdit={onEdit} />
      <ResearchBadge task={task} />
      <TaskMeta task={task} members={members} compactOwner />
  </>;
}
function TaskCard({ pending, ...props }: TaskCardProps) {
  const passivePress = useRef(false);
  const detailSurface = (target: EventTarget, card: Element) => target instanceof Element && card.contains(target) &&
    !target.closest('button, a, input, select, textarea, [role="button"], [contenteditable="true"]');
  return <article
    data-task-id={props.task.id}
    className="tasks-card"
    aria-busy={pending}
    onPointerDownCapture={event => { passivePress.current = event.button === 0 && detailSurface(event.target, event.currentTarget); }}
    onPointerCancel={() => { passivePress.current = false; }}
    onDragStart={event => { if (event.target instanceof HTMLImageElement) event.preventDefault(); }}
    onClick={event => {
      // Native controls keep their own action; passive surface clicks open details.
      // A press begun on an action and released over the card is retargeted by
      // the browser to their common ancestor; it is still not a surface click.
      const beganOnSurface = passivePress.current;
      passivePress.current = false;
      if (!beganOnSurface || event.defaultPrevented || event.button !== 0 || !detailSurface(event.target, event.currentTarget)) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && event.currentTarget.contains(selection.anchorNode)) return;
      event.currentTarget.querySelector<HTMLButtonElement>(".tasks-card__title")?.focus({ preventScroll: true });
      props.onEdit();
    }}
  >
    <TaskCardContents {...props} />
  </article>;
}

function TaskRow({ task, members, pending, onEdit, onMove, activity }: {
  task: TaskDetail;
  members: readonly TaskMember[];
  pending: boolean;
  onEdit(): void;
  onMove(status: TaskStatus): void;
  activity: ReadonlyMap<string, TaskConversationActivity>;
}) {
  const t = useText();
  const states = [...new Set(task.conversations.map(link => activity.get(linkKey(link))?.state ?? "unknown"))];
  return (
    <article className="tasks-row" data-task-id={task.id} aria-busy={pending}>
      <div className="tasks-row__status">
        <SettingsSelect
          aria-label={`${t("move")}: ${task.title}`}
          value={task.status}
          disabled={pending}
          onChange={(event) => onMove(event.target.value as TaskStatus)}
        >
          {TASK_STATUSES.map((status) => (
            <option key={status} value={status}>
              {t(status)}
            </option>
          ))}
        </SettingsSelect>
      </div>
      <button type="button" className="tasks-row__title" onClick={onEdit}>{task.title}</button>
      <div><TaskMeta task={task} members={members} /><ResearchBadge task={task} /></div>
      <span className="tasks-row__activity">{task.conversations.length ? `${t("links")} ${task.conversations.length} · ${states.map(state => t(state)).join(" / ")}` : ""}</span>
    </article>
  );
}
function Column({
  status,
  tasks,
  selected,
  children,
  onAdd,
  positions,
  pending,
  footer,
}: {
  footer?: React.ReactNode;
  status: TaskStatus;
  tasks: readonly TaskDetail[];
  selected: boolean;
  children: React.ReactNode;
  onAdd(): void;
  positions: Map<string, number>;
  pending: boolean;
}) {
  const t = useText();
  const element = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (element.current) element.current.scrollTop = positions.get(status) ?? 0;
  }, [selected, status, positions]);
  return (
    <section
      ref={element}
      onScroll={(event) => {
        if (event.currentTarget.clientHeight > 0)
          positions.set(status, event.currentTarget.scrollTop);
      }}
      data-status={status}
      className={`tasks-column${selected ? " tasks-column--selected" : ""}`}
      aria-label={t(status)}
    >
      <header>
        <h2>
          <i className="tasks-status-dot" aria-hidden="true" />{t(status)} <span>{tasks.length}</span>
        </h2>
        <SettingsButton
          variant="ghost"
          onClick={onAdd}
          disabled={pending}
          aria-label={`${t("add")}: ${t(status)}`}
        >
          <Plus size={14} />
        </SettingsButton>
      </header>
      {children}
      {!tasks.length ? <p>{t("empty")}</p> : null}
      {footer}
    </section>
  );
}
function InlineCreate({ value, busy, onChange, onSave, onClose, inherited }: { value: { id: string; title: string }; busy: boolean; onChange(title: string): void; onSave(): Promise<void>; onClose(): void; inherited: boolean }) {
  const t = useText();
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  return <form className="tasks-inline-create" onSubmit={event => { event.preventDefault(); void onSave().then(() => input.current?.focus()); }}>
    <textarea ref={input} aria-label={t("inlineTitle")} placeholder={t("inlineTitle")} maxLength={200} rows={3} value={value.title} disabled={busy}
      onChange={event => onChange(event.target.value)} onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (value.title.trim() && !busy) event.currentTarget.form?.requestSubmit(); } if (event.key === "Escape" && !busy) { event.preventDefault(); onClose(); } }} />
    {inherited ? <small>{t("inheritedFilters")}</small> : null}
    <div><SettingsButton type="submit" variant="primary" disabled={busy || !value.title.trim()}>{t("inlineAdd")}</SettingsButton><SettingsButton type="button" variant="quiet" disabled={busy} aria-label={t("closeButton")} onClick={onClose}><X size={16} /></SettingsButton></div>
  </form>;
}
function QuickEditor({ draft, task, session, planning, supportedKinds, properties, members, busy, compact, anchor, onSave, onStatus }: { draft: Draft; task: TaskDetail; session: TasksEditorSession; planning: boolean; supportedKinds: readonly string[]; properties: boolean; members: readonly TaskMember[]; busy: boolean; compact: boolean; anchor: HTMLElement | null; onSave(): Promise<unknown>; onStatus(status: TaskStatus): Promise<void> }) {
  const t = useText(), kt = useKindText();
  const update = (value: Partial<Draft>) => session.set({ ...draft, ...value });
  const changed = task.revision !== draft.revision;
  const fields = <form className="tasks-quick-form" aria-label={t("quickEdit")} onSubmit={event => { event.preventDefault(); void onSave(); }}>
    <h2>{t("quickEdit")}</h2>
    {changed ? <SettingsNotice>{t("newer")} <SettingsButton type="button" onClick={() => session.saved(task)}>{t("latest")}</SettingsButton></SettingsNotice> : null}
    <label>{t("title")}<SettingsTextInput autoFocus aria-label={t("title")} maxLength={200} value={draft.title} disabled={busy} onChange={event => update({ title: event.target.value })} /></label>
    {planning ? <label>{t("kind")}<SettingsSelect aria-label={t("kind")} value={draft.kind} disabled={busy} onChange={event => update({ kind: event.target.value })}>
      {draft.kind && !supportedKinds.includes(draft.kind) ? <option value={draft.kind}>{kt(draft.kind)}</option> : null}
      {TASK_KINDS.filter(kind => supportedKinds.includes(kind)).map(kind => <option key={kind} value={kind}>{kt(kind)}</option>)}
    </SettingsSelect></label> : null}
    {properties ? <div className="tasks-quick-form__fields">
      <label>{t("assignee")}<SettingsSelect aria-label={t("assignee")} disabled={busy} value={draft.assigneeId ?? ""} onChange={event => update({ assigneeId: event.target.value || null })}><option value="">{t("unassigned")}</option>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</SettingsSelect></label>
      <label>{t("priority")}<SettingsSelect aria-label={t("priority")} disabled={busy} value={draft.priority ?? "none"} onChange={event => update({ priority: event.target.value as Draft["priority"] })}>{TASK_PRIORITIES.map(priority => <option key={priority} value={priority}>{t(priority === "none" ? "noPriority" : priority)}</option>)}</SettingsSelect></label>
      <label>{t("dueDate")}<SettingsTextInput type="date" aria-label={t("dueDate")} disabled={busy} value={draft.dueDate ?? ""} onChange={event => update({ dueDate: event.target.value || null })} /></label>
    </div> : null}
    <label>{t("status")}<SettingsSelect aria-label={t("status")} value={draft.status} disabled={busy || changed} onChange={event => void onStatus(event.target.value as TaskStatus)}>{TASK_STATUSES.map(status => <option key={status} value={status}>{t(status)}</option>)}</SettingsSelect></label>
    <div className="tasks-quick-form__actions"><SettingsButton type="submit" variant="primary" disabled={busy || changed || !draft.title.trim()}>{t("save")}</SettingsButton><SettingsButton type="button" variant="quiet" disabled={busy} onClick={() => session.full()}><ArrowUpRight size={14} />{t("fullDetails")}</SettingsButton><SettingsButton type="button" variant="quiet" disabled={busy} onClick={() => session.close()}>{t("closeButton")}</SettingsButton></div>
  </form>;
  const returnFocus = (event: Event) => { event.preventDefault(); if (session.getSnapshot().draft === null) anchor?.focus({ preventScroll: true }); };
  if (compact) return <Dialog.Root open onOpenChange={open => { if (!open && !busy) session.close(); }}><Dialog.Portal><Dialog.Overlay className="modal-surface__scrim" data-layer="application" data-appearance="utility" /><Dialog.Content className="modal-surface tasks-quick-dialog" data-layer="application" data-appearance="utility" aria-describedby={undefined} onCloseAutoFocus={returnFocus} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}><Dialog.Title className="tasks-sr-only">{t("quickEdit")}</Dialog.Title>{fields}</Dialog.Content></Dialog.Portal></Dialog.Root>;
  const rect = () => (anchor?.closest("[data-task-id]") ?? anchor)?.getBoundingClientRect() ?? new DOMRect(24, 80, 272, 100);
  return <Popover.Root open modal onOpenChange={open => { if (!open && !busy) session.close(); }}><Popover.Anchor virtualRef={{ current: { getBoundingClientRect: rect } }} /><Popover.Portal><div className="tasks-quick-scrim" /></Popover.Portal><Popover.Portal><Popover.Content className="tasks-quick-popover" side="right" align="start" sideOffset={8} collisionPadding={16} onCloseAutoFocus={returnFocus} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onInteractOutside={event => { if (busy) event.preventDefault(); }}>{fields}</Popover.Content></Popover.Portal></Popover.Root>;
}
type MemberUpdate = TasksMethodMap["opencraft/tasks/members/upsert"]["params"];
function MemberIdentityEditor({ member, busy, onMember }: { member: TaskMember; busy: boolean; onMember(input: MemberUpdate): Promise<boolean> }) {
  const t = useText(), details = useRef<HTMLDetailsElement>(null), live = useRef(true);
  const [edit, setEdit] = useState<{ kind: string; id: string; revision: number; name: string } | null>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  return <details ref={details} className="tasks-members tasks-member-profile" onToggle={event => {
    if (event.currentTarget.open && !edit) setEdit({ kind: member.identity?.kind ?? "", id: member.identity?.id ?? "", revision: member.revision, name: member.name });
  }}>
    <summary><ChevronRightIcon size={14} />{t("avatarProfile")} · {member.name}</summary>
    {edit ? <>
      {edit.revision !== member.revision ? <SettingsNotice>{t("identityChanged")} <SettingsButton type="button" disabled={busy} onClick={() => setEdit({ kind: member.identity?.kind ?? "", id: member.identity?.id ?? "", revision: member.revision, name: member.name })}>{t("latestIdentity")}</SettingsButton></SettingsNotice> : null}
      <label>{t("identityKind")}<SettingsSelect aria-label={t("identityKind")} disabled={busy} value={edit.kind} onChange={e => setEdit({ ...edit, kind: e.target.value })}>
        <option value="">{t("noIdentity")}</option><option value="employee">{t("employeeIdentity")}</option>
        {edit.kind && edit.kind !== "employee" ? <option value={edit.kind}>{edit.kind}</option> : null}
      </SettingsSelect></label>
      {edit.kind ? <label>{t("identityId")}<SettingsTextInput aria-label={t("identityId")} disabled={busy} maxLength={256} value={edit.id} onChange={e => setEdit({ ...edit, id: e.target.value })} /></label> : null}
      <p>{t("identityHint")}</p>
      <SettingsButton type="button" disabled={busy || edit.revision !== member.revision || (!!edit.kind && !edit.id.trim())} onClick={() => {
        void onMember({ id: member.id, name: edit.name, expectedRevision: edit.revision, identity: edit.kind ? { kind: edit.kind, id: edit.id.trim() } : null }).then(saved => {
          if (saved && live.current) { if (details.current) details.current.open = false; setEdit(null); }
        });
      }}>{t("saveIdentity")}</SettingsButton>
    </> : null}
  </details>;
}
function Editor({
  planning, supportedKinds, aiResearch, activityModel, session, canPostProgress,
  draft,
  members,
  properties,
  memberIdentity,
  onMember,
  setDraft,
  task,
  host,
  ports,
  pending,
  error,
  activity,
  onSave,
  onClose,
  returnFocus,
  onLatest,
  onRemove,
  onArchive,
  onLink,
  onOpen,
  onBeginConversation,
  onStatus,
}: {
  planning: boolean; supportedKinds: readonly string[]; aiResearch: boolean; activityModel?: TaskActivityController; session: TasksEditorSession; canPostProgress: boolean;
  draft: Draft;
  members: readonly TaskMember[];
  properties: boolean;
  memberIdentity: boolean;
  onMember(input: MemberUpdate): Promise<boolean>;
  setDraft(d: Draft): void;
  task?: TaskDetail;
  host: PlatformViewHost;
  ports: TasksExtensionPorts;
  pending: boolean;
  error: string | null;
  activity: ReadonlyMap<string, TaskConversationActivity>;
  onSave(e: FormEvent): void;
  onClose(): void;
  returnFocus(): HTMLElement | null;
  onLatest(): void;
  onRemove(): void;
  onArchive?(): void;
  onLink(attach: boolean, serverId: string, threadId: string): Promise<boolean>;
  onOpen(link: TaskConversation): void;
  onBeginConversation(hostId: string): Promise<void>;
  onStatus(status: TaskStatus): Promise<void>;
}) {
  const t = useText(), kt = useKindText(), intl = useIntl();
  const [tab, setTab] = useState("content");
  const live = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const [memberId, setMemberId] = useState(""), [memberName, setMemberName] = useState("");
  const memberDetails = useRef<HTMLDetailsElement>(null);
  const assigneeControl = useRef<HTMLSelectElement>(null);
  const [source, setSource] = useState(() => host.profiles.find(profile => profile.enabled && profile.hostId === host.activeHostId)?.hostId ?? ""),
    [executionHost, setExecutionHost] = useState(() => (draft.projectServerId ? hostFor(host, draft.projectServerId) : null) ?? host.activeHostId),
    [preparing, setPreparing] = useState(false),
    [prepareError, setPrepareError] = useState(false),
    [search, setSearch] = useState(""),
    [threadId, setThreadId] = useState(""),
    [threads, setThreads] = useState<readonly { id: string; title: string }[]>(
      [],
    ),
    [readError, setReadError] = useState(false),
    [readingThreads, setReadingThreads] = useState(!!source),
    [linking, setLinking] = useState(false),
    [retry, setRetry] = useState(0);
  const [projectHost, setProjectHost] = useState(() =>
      draft.projectServerId ? (hostFor(host, draft.projectServerId) ?? "") : "",
    ),
    [projects, setProjects] = useState<
      readonly { id: string; title: string }[]
    >([]),
    [projectError, setProjectError] = useState(false);
  useEffect(() => {
    let live = true;
    setThreads([]);
    setThreadId("");
    setReadError(false);
    setReadingThreads(!!source);
    if (!source) return;
    const timer = setTimeout(() => {
      void ports.listThreads(source, search).then(
        (value) => {
          if (live) { setThreads(value); setReadingThreads(false); }
        },
        () => {
          if (live) { setReadError(true); setReadingThreads(false); }
        },
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [source, search, retry]);
  useEffect(() => {
    let live = true;
    setProjects([]);
    setProjectError(false);
    if (!projectHost) return;
    void ports.listProjects(projectHost).then(
      (value) => {
        if (live) setProjects(value);
      },
      () => {
        if (live) setProjectError(true);
      },
    );
    return () => {
      live = false;
    };
  }, [projectHost, retry]);
  const changed = !!task && task.revision !== draft.revision,
    removed = draft.revision !== null && !task,
    busy = pending || linking || preparing,
    blocked = busy || changed || removed;
  const update = (value: Partial<Draft>) => setDraft({ ...draft, ...value });
  const resetThreadChoice = (hasSource: boolean) => {
    setThreadId("");
    setThreads([]);
    setReadError(false);
    setReadingThreads(hasSource);
  };
  const attach = async () => {
    const serverId = origin(host, source);
    if (!serverId || !threadId || blocked) return;
    setLinking(true);
    try {
      await ports.readConversation(source, threadId);
      if (!live.current) return;
      await onLink(true, serverId, threadId);
      setReadError(false);
    } catch {
      setReadError(true);
    } finally {
      setLinking(false);
    }
  };
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay
        className="modal-surface__scrim"
        data-layer="application"
        data-appearance="utility"
        onClick={() => { if (!busy) onClose(); }}
      />
      <Dialog.Content
        className="modal-surface tasks-dialog"
        data-layer="application"
        data-appearance="utility"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          heading.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          const target = returnFocus();
          if (target?.isConnected && !target.closest("[inert]")) {
            event.preventDefault();
            target.focus({ preventScroll: true });
          }
        }}
        onPointerDownOutside={(event) => { if (busy) event.preventDefault(); }}
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
      >
    <form className="tasks-editor" data-tab={tab} onSubmit={onSave} aria-label={t("edit")}>
      <header className="tasks-editor__header">
        <Dialog.Title asChild><h2 ref={heading} tabIndex={-1}>{t("edit")}</h2></Dialog.Title>
        <SettingsButton
          className="tasks-compact-only"
          type="submit"
          variant="primary"
          disabled={blocked || !draft.title.trim()}
        >
          {t("save")}
        </SettingsButton>
        <Dialog.Close asChild><SettingsButton
          className="tasks-editor__close settings-icon-button"
          type="button"
          variant="quiet"
          aria-label={t("close")}
          title={t("close")}
          disabled={busy}
        >
          <X size={18} aria-hidden="true" />
        </SettingsButton></Dialog.Close>
      </header>
      {changed || removed || error ? <div className="tasks-editor__feedback" aria-live="polite">
        {changed ? <SettingsNotice>{t("newer")} <SettingsButton type="button" onClick={onLatest}>{t("latest")}</SettingsButton></SettingsNotice> : null}
        {removed ? <SettingsNotice>{t("removed")}</SettingsNotice> : null}
        {error && !changed && !removed ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
      </div> : null}
      {activityModel ? <SegmentedControl className="tasks-editor__tabs" label={t("edit")} value={tab} onValueChange={setTab} options={[{ value: "content", label: t("contentTab") }, { value: "activity", label: t("activityTab") }]} /> : null}
      <div className={`tasks-editor__workspace${activityModel ? " tasks-editor__workspace--activity" : ""}`}>
      <fieldset className="tasks-editor__body" disabled={busy}>
        <section className="tasks-editor__content">
        <label>
          {t("title")}
          <SettingsTextInput
            aria-label={t("title")}
            required
            maxLength={200}
            value={draft.title}
            onChange={(e) => update({ title: e.target.value })}
          />
        </label>
        <div className="tasks-editor__properties">
          {planning ? <label>{t("kind")}<SettingsSelect aria-label={t("kind")} value={draft.kind ?? "unclassified"} disabled={blocked} onChange={event => update({ kind: event.target.value })}>
            {draft.kind && !supportedKinds.includes(draft.kind) ? <option value={draft.kind}>{kt(draft.kind)}</option> : null}
            {TASK_KINDS.filter(kind => supportedKinds.includes(kind)).map(kind => <option key={kind} value={kind}>{kt(kind)}</option>)}
          </SettingsSelect></label> : null}
          {properties ? <>
            <label>{t("assignee")}<SettingsSelect ref={assigneeControl} aria-label={t("assignee")} value={draft.assigneeId ?? ""} disabled={blocked} onChange={e => update({ assigneeId: e.target.value || null })}>
              <option value="">{t("unassigned")}</option>
              {members.map(member => <option key={member.id} value={member.id}>{member.name} · {member.id}</option>)}
            </SettingsSelect></label>
            <label>{t("priority")}<SettingsSelect aria-label={t("priority")} value={draft.priority ?? "none"} disabled={blocked} onChange={e=>update({priority:e.target.value as Draft["priority"]})}>
              {TASK_PRIORITIES.map(priority=><option key={priority} value={priority}>{t(priority === "none" ? "noPriority" : priority)}</option>)}
            </SettingsSelect></label>
            <label>{t("dueDate")}<SettingsTextInput type="date" aria-label={t("dueDate")} value={draft.dueDate ?? ""} disabled={blocked} onChange={e=>update({dueDate:e.target.value || null})}/></label>
          </> : null}
          <label>
            {t("status")}
            <SettingsSelect
              aria-label={t("status")}
              value={draft.status}
              disabled={blocked}
              onChange={(e) => {
                const status = e.target.value as TaskStatus;
                if (draft.revision) void onStatus(status);
                else update({ status });
              }}
            >
              {TASK_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(status)}
                </option>
              ))}
            </SettingsSelect>
          </label>
        </div>
        <TaskDescriptionField
          label={t("description")}
          expandLabel={t("expandDescription")}
          collapseLabel={t("collapseDescription")}
          value={draft.description}
          onChange={(description) => update({ description })}
        />
        {aiResearch ? <div className="tasks-research-fields">
          <label>{t("aiResearch")}<SettingsSelect aria-label={t("aiResearch")} value={draft.aiResearch ?? "unassessed"} disabled={blocked} onChange={event => update({ aiResearch: event.target.value })}>
            {draft.aiResearch && !TASK_AI_RESEARCH.some(mode => mode === draft.aiResearch) ? <option value={draft.aiResearch}>{draft.aiResearch}</option> : null}
            {TASK_AI_RESEARCH.map(mode => <option key={mode} value={mode}>{researchLabel(mode, t)}</option>)}
          </SettingsSelect></label>
          <label>{t("researchReason")}<textarea aria-label={t("researchReason")} maxLength={2048} disabled={blocked} required={(draft.aiResearch ?? "unassessed") !== "unassessed"} value={draft.aiResearchReason ?? ""} onChange={event => update({ aiResearchReason: event.target.value })} /></label>
          <p>{t("researchHint")}</p>
        </div> : null}
        {planning ? <>
          <label className="tasks-acceptance">{t("acceptance")}<textarea aria-label={t("acceptance")} maxLength={16384} value={draft.acceptanceCriteria ?? ""} onChange={event => update({ acceptanceCriteria: event.target.value })} /></label>
          {!draft.description.trim() && !draft.acceptanceCriteria?.trim() ? <SettingsButton type="button" variant="quiet" disabled={blocked} onClick={() => update(starterTemplate(draft.kind ?? "unclassified", intl.locale.startsWith("zh")))}>{t("template")}</SettingsButton> : null}
        </> : null}
        </section>
        <aside className="tasks-editor__advanced">
        <div className="tasks-editor__fields">
          <label>
            {t("projectSource")}
            <SettingsSelect
              aria-label={t("projectSource")}
              value={projectHost}
              onChange={(e) => {
                setProjectHost(e.target.value);
                if (e.target.value) setExecutionHost(e.target.value);
                update({ projectServerId: null, projectId: null });
              }}
            >
              <option value="">{t("none")}</option>
              {host.profiles
                .filter((p) => p.enabled)
                .map((p) => (
                  <option key={p.hostId} value={p.hostId}>
                    {p.displayName}
                  </option>
                ))}
            </SettingsSelect>
          </label>
          {projectHost ? (
            <label>
              {t("project")}
              <SettingsSelect
                aria-label={t("project")}
                value={draft.projectId ?? ""}
                onChange={(e) =>
                  update({
                    projectId: e.target.value || null,
                    projectServerId: e.target.value
                      ? origin(host, projectHost)
                      : null,
                  })
                }
              >
                <option value="">{t("none")}</option>
                {draft.projectId &&
                !projects.some((p) => p.id === draft.projectId) ? (
                  <option value={draft.projectId}>{draft.projectId}</option>
                ) : null}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </SettingsSelect>
            </label>
          ) : null}
        </div>
        {projectError ? (
          <SettingsNotice tone="error">
            {t("readError")}{" "}
            <SettingsButton
              type="button"
              onClick={() => setRetry((value) => value + 1)}
            >
              {t("refresh")}
            </SettingsButton>
          </SettingsNotice>
        ) : null}
            {properties ? <details ref={memberDetails} className="tasks-members"><summary><ChevronRightIcon size={14} />{t("addMember")}</summary>
              <label>{t("memberName")}<SettingsTextInput aria-label={t("memberName")} maxLength={120} value={memberName} onChange={e=>setMemberName(e.target.value)} /></label>
              <label>{t("memberId")}<SettingsTextInput aria-label={t("memberId")} maxLength={256} value={memberId} onChange={e=>setMemberId(e.target.value)} /></label>
              <p>{t("memberHint")}</p>
              <SettingsButton type="button" disabled={busy || !memberName.trim() || !memberId.trim() || members.some(member=>member.id===memberId.trim())} onClick={() => {
                void onMember({ id: memberId.trim(), name: memberName.trim(), expectedRevision: null }).then(saved => { if (saved && live.current) {
                  update({ assigneeId: memberId.trim() }); setMemberId(""); setMemberName("");
                  if (memberDetails.current) memberDetails.current.open = false;
                  requestAnimationFrame(() => { if (live.current) assigneeControl.current?.focus(); });
                } });
              }}>{t("addMember")}</SettingsButton>
            </details> : null}
            {memberIdentity && members.some(member => member.id === draft.assigneeId) ? <MemberIdentityEditor key={draft.assigneeId} member={members.find(member => member.id === draft.assigneeId)!} busy={busy} onMember={onMember} /> : null}
        </aside>
          <section className="tasks-editor__conversations">
            <h2>{t("links")}</h2>
            {ports.prepareConversation ? (
              <div className="tasks-editor__fields tasks-editor__execution">
                <label>{t("executionSource")}
                  <SettingsSelect aria-label={t("executionSource")} value={executionHost} onChange={event => setExecutionHost(event.target.value)}>
                    <option value="">{t("choose")}</option>
                    {host.profiles.filter(profile => profile.enabled).map(profile => <option key={profile.hostId} value={profile.hostId}>{profile.displayName}</option>)}
                  </SettingsSelect>
                </label>
                <SettingsButton type="button" disabled={blocked || !draft.title.trim() || !executionHost}
                  onClick={() => {
                    setPreparing(true); setPrepareError(false);
                    void onBeginConversation(executionHost).catch(() => {
                      if (live.current) setPrepareError(true);
                    }).finally(() => { if (live.current) setPreparing(false); });
                  }}>{t("newConversation")}</SettingsButton>
              </div>
            ) : null}
            {prepareError ? <SettingsNotice tone="error">{t("prepareError")}</SettingsNotice> : null}
            {(task?.conversations ?? []).map((link) => {
              const info = activity.get(linkKey(link));
              return (
                <div className="tasks-link" key={linkKey(link)}>
                  <span>
                    {info?.title ?? link.threadId}
                    <small>
                      {host.profiles.find(
                        (profile) =>
                          origin(host, profile.hostId) === link.serverId,
                      )?.displayName ?? t("unknown")}{" "}
                      · {t(info?.state ?? "unknown")}
                    </small>
                  </span>
                  <SettingsButton
                    type="button"
                    variant="quiet"
                    onClick={() => onOpen(link)}
                  >
                    {t("open")}
                  </SettingsButton>
                  <SettingsButton
                    type="button"
                    variant="quiet"
                    disabled={blocked}
                    onClick={() =>
                      void onLink(false, link.serverId, link.threadId)
                    }
                  >
                    {t("detach")}
                  </SettingsButton>
                </div>
              );
            })}
            <div className="tasks-editor__fields">
              <label>
                {t("source")}
                <SettingsSelect
                  aria-label={t("source")}
                  value={source}
                  onChange={(e) => { if (e.target.value !== source) { setSource(e.target.value); resetThreadChoice(!!e.target.value); } }}
                >
                  <option value="">{t("choose")}</option>
                  {host.profiles
                    .filter((p) => p.enabled)
                    .map((p) => (
                      <option key={p.hostId} value={p.hostId}>
                        {p.displayName}
                      </option>
                    ))}
                </SettingsSelect>
              </label>
              {source ? (
                <>
                  <label>
                    {t("search")}
                    <SettingsTextInput
                      aria-label={t("search")}
                      value={search}
                      onChange={(e) => { setSearch(e.target.value); resetThreadChoice(!!source); }}
                    />
                  </label>
                  <label>
                    {t("conversation")}
                    <SettingsSelect
                      aria-label={t("conversation")}
                      aria-busy={readingThreads}
                      disabled={readingThreads || readError || !threads.length}
                      value={threadId}
                      onChange={(e) => setThreadId(e.target.value)}
                    >
                      <option value="">{t(readingThreads ? "loadingConversations" : !readError && !threads.length ? "noConversations" : "choose")}</option>
                      {threads.map((thread) => (
                        <option key={thread.id} value={thread.id}>
                          {thread.title}
                        </option>
                      ))}
                    </SettingsSelect>
                  </label>
                  <SettingsButton
                    type="button"
                    disabled={blocked || readingThreads || readError || !draft.title.trim() || !threadId}
                    onClick={() => void attach()}
                  >
                    {t("attach")}
                  </SettingsButton>
                </>
              ) : null}
            </div>
          </section>
        {readError ? (
          <SettingsNotice tone="error">
            {t("readError")}{" "}
            <SettingsButton
              type="button"
              onClick={() => setRetry((value) => value + 1)}
            >
              {t("refresh")}
            </SettingsButton>
          </SettingsNotice>
        ) : null}
      </fieldset>
      {activityModel ? <ActivityPanel key={activityModel.taskId} model={activityModel} session={session} canPost={canPostProgress} ports={ports} /> : null}
      </div>
      <footer className="tasks-editor__actions">
        <SettingsButton
          className="tasks-wide-only"
          type="submit"
          variant="primary"
          disabled={blocked || !draft.title.trim()}
        >
          {t("save")}
        </SettingsButton>
        {task && onArchive ? <SettingsButton variant="quiet" type="button" disabled={blocked || JSON.stringify(draftFor(task)) !== JSON.stringify(draft)} title={JSON.stringify(draftFor(task)) !== JSON.stringify(draft) ? t("archiveSaveFirst") : undefined} onClick={onArchive}><Archive size={14} aria-hidden="true" />{t("archive")}</SettingsButton> : null}
        {task ? (
          <SettingsButton className="tasks-editor__remove" variant="quiet" type="button" disabled={blocked} onClick={onRemove}>
            <Trash2 size={14} aria-hidden="true" />{t("remove")}
          </SettingsButton>
        ) : null}
      </footer>
    </form>
      </Dialog.Content>
    </Dialog.Portal>
    </Dialog.Root>
  );
}
function ArchivePanel({ model, members, pending, reportError, ports, session, activityFor, onOpen, onRestore, onRead }: {
  model: TasksArchiveController; members: readonly TaskMember[]; pending: boolean; reportError?: ExtensionSettingsViewProps["reportError"];
  ports: TasksExtensionPorts; session: TasksEditorSession; activityFor(task: TaskDetail): TaskActivityController;
  onOpen(link: TaskConversation): void; onRestore(task: TaskDetail): Promise<boolean>; onRead(id: string): Promise<TaskDetail>;
}) {
  const t = useText();
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const [query, setQuery] = useState(state.query);
  const [selected, setSelected] = useState<TaskDetail | null>(null);
  const opener = useRef<HTMLElement | null>(null), search = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { if (query === model.getSnapshot().query) return; const timer = setTimeout(() => void model.search(query), 200); return () => clearTimeout(timer); }, [query, model]);
  useEffect(() => { if (state.error) reportError?.({ key: "tasks-archive-read", message: t("archiveReadError") }); }, [state.error, reportError]);
  useEffect(() => { if (!selected) return; const latest = state.tasks.find(item => item.id === selected.id); if (latest && latest.revision !== selected.revision) setSelected(latest); }, [state.tasks, selected]);
  const restore = async (item: TaskDetail) => {
    const saved = await onRestore(item);
    if (!live.current) return;
    if (saved) { setSelected(null); search.current?.focus(); }
    else if (selected?.id === item.id) {
      // A lost acknowledgement or another writer can already have restored it.
      // Reconcile the selected record; never repeat the mutation automatically.
      try { const latest = await onRead(item.id); if (live.current) setSelected(latest.archivedAt == null ? null : latest); } catch {}
    }
  };
  return <section className="tasks-archive" aria-label={t("archivedTasks")}>
    <p>{t("archiveHint")}</p>
    <SettingsTextInput ref={search} type="search" maxLength={200} aria-label={t("archiveSearch")} placeholder={t("archiveSearch")} value={query} onChange={event => setQuery(event.target.value)} />
    <div className="tasks-archive__results" aria-busy={state.loading}>
      {!state.tasks.length ? <p role="status">{t(state.loading ? "loading" : state.error ? "archiveReadError" : state.query ? "archiveNoResults" : "archiveEmpty")}</p> : <ul className="tasks-archive__list">{state.tasks.map(item => <li key={item.id} data-task-id={item.id}>
        <div><KindBadge kind={item.kind} /><button type="button" className="tasks-archive__title" onClick={event => { opener.current = event.currentTarget; setSelected(item); }}>{item.title}</button>
          <div className="tasks-archive__metadata">{t(item.status)} · {t("archiveDate")} {new Date(item.archivedAt!).toLocaleString()}</div>
          <TaskMeta task={item} members={members} />
        </div>
        <SettingsButton variant="quiet" disabled={pending} aria-label={`${t("archiveRestore")}: ${item.title}`} onClick={() => void restore(item)}><ArchiveRestore size={16} aria-hidden="true" />{t("archiveRestore")}</SettingsButton>
      </li>)}</ul>}
      {state.nextCursor ? <SettingsButton disabled={state.loading} onClick={() => void model.refresh(true)}>{t(state.loading ? "loading" : "archiveMore")}</SettingsButton> : null}
    </div>
    {selected ? <Dialog.Root open onOpenChange={open => { if (!open && !pending) setSelected(null); }}><Dialog.Portal>
      <Dialog.Overlay className="modal-surface__scrim" data-layer="application" data-appearance="utility" />
      <Dialog.Content className="modal-surface tasks-dialog tasks-archive-dialog" data-layer="application" data-appearance="utility" aria-describedby={undefined}
        onCloseAutoFocus={event => { event.preventDefault(); const target = opener.current?.isConnected ? opener.current : search.current; target?.focus(); }}
        onEscapeKeyDown={event => { if (pending) event.preventDefault(); }} onPointerDownOutside={event => { if (pending) event.preventDefault(); }}>
        <header className="tasks-archive-dialog__header"><Dialog.Title>{selected.title}</Dialog.Title><Dialog.Close asChild><SettingsButton variant="ghost" aria-label={t("close")} disabled={pending}><X size={18} aria-hidden="true" /></SettingsButton></Dialog.Close></header>
        <div className="tasks-archive-dialog__body">
          <SettingsNotice>{t("archiveReadOnly")}</SettingsNotice>
          <KindBadge kind={selected.kind} /><p>{t("status")}: {t(selected.status)} · {t("archiveDate")}: {new Date(selected.archivedAt!).toLocaleString()}</p>
          <TaskMeta task={selected} members={members} />
          <h3>{t("description")}</h3><p className="tasks-archive__text">{selected.description || "—"}</p>
          <h3>{t("acceptance")}</h3><p className="tasks-archive__text">{selected.acceptanceCriteria || "—"}</p>
          {selected.projectId ? <p>{t("project")}: {selected.projectId}</p> : null}
          {selected.conversations.length ? <><h3>{t("links")}</h3>{selected.conversations.map(link => <SettingsButton key={linkKey(link)} variant="quiet" onClick={() => onOpen(link)}><ArrowUpRight size={14} aria-hidden="true" />{link.threadId}</SettingsButton>)}</> : null}
          <ActivityPanel model={activityFor(selected)} session={session} canPost={false} ports={ports} />
        </div>
        <footer><SettingsButton variant="primary" disabled={pending} onClick={() => void restore(selected)}><ArchiveRestore size={16} aria-hidden="true" />{t("archiveRestore")}</SettingsButton></footer>
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root> : null}
  </section>;
}
/** Decorative geometry only: counts and empty states require an authority snapshot. */
function TasksLoading({ mode, selected }: { mode: ViewDraft["mode"]; selected: TaskStatus }) {
  const t = useText();
  const bar = (className = "") => <span className={`tasks-loading__bar ${className}`} />;
  return <div className="tasks-loading" aria-busy="true" role="status" aria-label={t("loading")}>
    <div className="tasks-loading__geometry" aria-hidden="true">
      {mode === "board" ? <>
        <div className="tasks-loading__tabs">{TASK_STATUSES.map(status => <span key={status}>{bar()}</span>)}</div>
        <div className="tasks-columns">{TASK_STATUSES.map((status, index) => <div key={status} className={`tasks-column${selected === status ? " tasks-column--selected" : ""}`}>
          <header>{bar("tasks-loading__heading")}{bar("tasks-loading__count")}</header>
          {Array.from({ length: index % 2 ? 2 : 3 }, (_, card) => <div key={card} className="tasks-loading__card">
            {bar("tasks-loading__badge")}{bar()}{bar("tasks-loading__short")}
            <div className="tasks-loading__meta">{bar("tasks-loading__avatar")}{bar("tasks-loading__short")}</div>
          </div>)}
        </div>)}</div>
      </> : <div className="tasks-list">{Array.from({ length: 6 }, (_, row) => <div key={row} className="tasks-loading__row">{bar("tasks-loading__badge")}{bar()}{bar("tasks-loading__short")}</div>)}</div>}
    </div>
  </div>;
}
export function createTasksView(
  ports: TasksExtensionPorts,
  activationSignal: AbortSignal,
  preferences?: TrustedExtensionApiV1["localPreferences"],
) {
  const localSelections = new Map<string, string>();
  const aiOwnerSelections = new Map<string, string>();
  const aiViewSelections = new Map<string, FollowUpSelection>();
  let controller: TasksController | null = null;
  let archiveController: TasksArchiveController | null = null;
  const positions = new Map<string, number>();
  const editorSession = new TasksEditorSession();
  const activities = new Map<string, TaskActivityController>();
  let remembered: ViewDraft = {
    mode: "board",
    status: "todo",
    project: "", search: "", assignee: "", overdue: false, kind: "", aiResearch: "",
  };
  activationSignal.addEventListener(
    "abort",
    () => {
      controller?.dispose();
      controller = null;
      archiveController?.dispose(); archiveController = null;
      positions.clear();
      editorSession.clear();
      for (const activity of activities.values()) activity.dispose();
      activities.clear();
      localSelections.clear();
      aiOwnerSelections.clear(); aiViewSelections.clear();
      remembered = { mode: "board", status: "todo", project: "", search: "", assignee: "", overdue: false, kind: "", aiResearch: "" };
    },
    { once: true },
  );
  return function TasksView({ host, reportError }: ExtensionSettingsViewProps) {
    const filterId = useId();
    const viewport = useRef<HTMLDivElement>(null);
    const [compact, setCompact] = useState(false);
    const [inlineStatus, setInlineStatus] = useState<TaskStatus | null>(null);
    const [, updateInline] = useState(0);
    const [hiddenCreated, setHiddenCreated] = useState(false);
    useLayoutEffect(() => { const node = viewport.current; if (!node) return; const observer = new ResizeObserver(entries => setCompact(entries[0]!.contentRect.width <= 600)); observer.observe(node); return () => observer.disconnect(); }, []);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [overviewOpen, setOverviewOpen] = useState(false);
    const [morningOpen, setMorningOpen] = useState(false);
    const wasMorning = useRef(false);
    useEffect(() => {
      if (morningOpen) viewport.current?.querySelector<HTMLButtonElement>("[data-morning-back]")?.focus();
      else if (wasMorning.current) viewport.current?.querySelector<HTMLButtonElement>("[data-morning-entry]")?.focus();
      wasMorning.current = morningOpen;
    }, [morningOpen]);
    const viewLive = useRef(true);
    useEffect(() => {
      viewLive.current = true;
      return () => { viewLive.current = false; };
    }, []);
    const t = useText(), kt = useKindText(),
      authority = ports.storageHostId;
    const model = useMemo(() => {
      if (!controller)
        controller = new TasksController({
          request: (method, params) => {
            activationSignal.throwIfAborted();
            if (!authority) throw new Error("Missing task authority");
            return ports.request(authority, method, params);
          },
        });
      return controller;
    }, []);
    const morningPort = useMemo(() => ({ request: <M extends keyof import("@opencraft/appserver-protocol").TasksMethodMap>(method: M, params: import("@opencraft/appserver-protocol").TasksMethodMap[M]["params"]) => {
      activationSignal.throwIfAborted();
      if (!authority) throw new Error("Missing task authority");
      return ports.request(authority, method, params);
    } }), [authority]);
    const state = useSyncExternalStore(
      model.subscribe,
      model.getSnapshot,
      model.getSnapshot,
    );
    const archives = useMemo(() => {
      if (!archiveController) archiveController = new TasksArchiveController({ request: (method, params) => {
        activationSignal.throwIfAborted();
        if (!authority) throw new Error("Missing task authority");
        return ports.request(authority, method, params);
      } });
      return archiveController;
    }, []);
    const archiveState = useSyncExternalStore(archives.subscribe, archives.getSnapshot, archives.getSnapshot);
    const editing = useSyncExternalStore(editorSession.subscribe, editorSession.getSnapshot, editorSession.getSnapshot);
    const edit = editing.draft;
    const changeEditor = (editor: Draft | null) => editorSession.set(editor);
    // Explicit selections are client-local and separated by task authority and verified account.
    // The anonymous bucket is a manual viewing preference, never a claimed authenticated identity.
    const memberScope = JSON.stringify([authority, host.currentUser?.providerId ?? null, host.currentUser?.id ?? null]);
    const memberStore = useMemo(() => preferences?.forAccount(memberScope), [memberScope]);
    const [, refreshLocalSelection] = useState(0);
    const selectedMember = useSyncExternalStore(
      memberStore?.subscribe ?? (() => () => {}),
      () => { const value = memberStore?.get("selfMember"); return typeof value === "string" ? value : localSelections.get(memberScope) ?? null; },
    );
    const myMemberId = ownMemberId(state.members, host.currentUser, selectedMember);
    const [recycleOpen, setRecycleOpen] = useState(false);
    const [archiveOpen, setArchiveOpen] = useState(false);
    const managementOpen = recycleOpen || archiveOpen;
    const archiveVisible = useRef(false); archiveVisible.current = archiveOpen;
    useEffect(() => { if (archiveOpen && state.archive) void archives.refresh(); }, [archiveOpen, state.archive]);
    const recycleHeading = useRef<HTMLDivElement | null>(null);
    const managementActions = useRef<HTMLDivElement | null>(null);
    const wasRecycling = useRef(false);
    useEffect(() => {
      if (managementOpen) recycleHeading.current?.querySelector<HTMLButtonElement>("button")?.focus();
      else if (wasRecycling.current) managementActions.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus();
      wasRecycling.current = managementOpen;
    }, [managementOpen]);
    const [refreshing, setRefreshing] = useState(false);
    const refreshInFlight = useRef(false);
    const refreshTasks = async () => {
      if (refreshInFlight.current) return;
      refreshInFlight.current = true;
      setRefreshing(true);
      try { await model.start(); }
      finally { refreshInFlight.current = false; setRefreshing(false); }
    };
    const [restoringId, setRestoringId] = useState<string | null>(null);
    const [draft, setDraft] = useState(remembered),
      [routeError, setRouteError] = useState(false),
      [activityEpoch, setActivityEpoch] = useState(0),
      [activity, setActivity] = useState<
        ReadonlyMap<string, TaskConversationActivity>
      >(new Map());
    const opener = useRef<HTMLElement | null>(null);
    const change = (value: Partial<ViewDraft>) => {
      remembered = { ...remembered, ...value };
      setDraft(remembered);
    };
    useEffect(() => {
      void model.start();
      let debounce: ReturnType<typeof setTimeout> | undefined;
      const refresh = () => {
        if (document.visibilityState !== "visible") return;
        void model.refresh();
        setActivityEpoch((value) => value + 1);
      };
      const stop = ports.subscribe((kind) => {
        if (kind === "tasks") { void model.refresh(); if (archiveVisible.current) void archives.refresh(); }
        else {
          clearTimeout(debounce);
          debounce = setTimeout(
            () => setActivityEpoch((value) => value + 1),
            150,
          );
        }
      });
      const timer = setInterval(refresh, 5000);
      window.addEventListener("focus", refresh);
      document.addEventListener("visibilitychange", refresh);
      return () => {
        stop();
        clearInterval(timer);
        clearTimeout(debounce);
        window.removeEventListener("focus", refresh);
        document.removeEventListener("visibilitychange", refresh);
      };
    }, [model]);
    useEffect(() => {
      let live = true;
      const links = [
        ...new Map(
          state.tasks
            .flatMap((task) => task.conversations)
            .map((link) => [linkKey(link), link]),
        ).values(),
      ];
      const values = new Map<string, TaskConversationActivity>();
      let cursor = 0;
      const worker = async () => {
        while (cursor < links.length) {
          const link = links[cursor++],
            hostId = hostFor(host, link.serverId);
          let value: TaskConversationActivity = {
            title: link.threadId,
            state: "unknown",
          };
          if (hostId)
            try {
              value = await ports.readConversation(hostId, link.threadId);
            } catch {}
          values.set(linkKey(link), value);
        }
      };
      void Promise.all(
        Array.from({ length: Math.min(8, links.length) }, worker),
      ).then(() => {
        if (live) setActivity(values);
      });
      return () => {
        live = false;
      };
    }, [state.tasks, activityEpoch, host.profiles]);
    const [projectNames, setProjectNames] = useState<
      ReadonlyMap<string, string>
    >(new Map());
    const projectServers = [
      ...new Set(
        state.tasks.flatMap((task) =>
          task.projectServerId ? [task.projectServerId] : [],
        ),
      ),
    ]
      .sort()
      .join("\n");
    useEffect(() => {
      let live = true;
      const servers = [
        ...new Set(
          state.tasks.flatMap((task) =>
            task.projectServerId ? [task.projectServerId] : [],
          ),
        ),
      ];
      void Promise.all(
        servers.map(async (serverId) => {
          const hostId = hostFor(host, serverId);
          if (!hostId) return [];
          try {
            return (await ports.listProjects(hostId)).map(
              (project) =>
                [
                  JSON.stringify([serverId, project.id]),
                  project.title,
                ] as const,
            );
          } catch {
            return [];
          }
        }),
      ).then((results) => {
        if (live) setProjectNames(new Map(results.flat()));
      });
      return () => {
        live = false;
      };
    }, [projectServers, activityEpoch]);
    const openEditor = (task?: TaskDetail, status: TaskStatus = "backlog", quick = false) => {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      editorSession.open(task, status, quick ? "quick" : "detail");
    };
    const task = state.tasks.find(task => task.id === edit?.id);
    const changeStatus = async (status: TaskStatus) => {
      const d = editorSession.getSnapshot().draft;
      if (!d?.revision) return;
      const moved = await model.mutate(TASKS.move, { id: d.id, expectedRevision: d.revision, status, beforeId: null });
      const latest = model.getSnapshot().tasks.find(task => task.id === d.id);
      if (moved && latest && editorSession.getSnapshot().draft?.id === d.id) editorSession.rebase(latest);
    };
    const error = state.error
      ? t(
          state.error === "conflict"
            ? "conflict"
            : state.error === "restore"
              ? "restoreError"
            : state.error === "save"
              ? "saveError"
              : "refreshError",
        )
      : routeError
        ? t("routeError")
        : null;
    useEffect(() => {
      if (error) reportError?.({ key: "tasks-operation", message: error });
    }, [error, reportError]);
    const save = async () => {
      const d = editorSession.getSnapshot().draft;
      if (!d) return null;
      const content: TaskContent = {
        ...(state.aiResearch ? { ...(d.aiResearch !== (task?.aiResearch ?? "unassessed") || !d.revision ? { aiResearch: d.aiResearch ?? "unassessed" } : {}), ...(d.aiResearchReason !== (task?.aiResearchReason ?? "") || !d.revision ? { aiResearchReason: d.aiResearchReason ?? "" } : {}) } : {}),
        ...(state.properties ? { assigneeId: d.assigneeId ?? null, priority: d.priority ?? "none", dueDate: d.dueDate ?? null } : {}),
        ...(state.planning ? { ...(d.kind !== (task?.kind ?? "unclassified") || !d.revision ? { kind: d.kind ?? "unclassified" } : {}), acceptanceCriteria: d.acceptanceCriteria ?? "" } : {}),
        title: d.title.trim(),
        description: d.description,
        projectServerId: d.projectServerId,
        projectId: d.projectId,
      };
      const saved = d.revision
        ? await model.mutate(TASKS.update, {
            ...content,
            id: d.id,
            expectedRevision: d.revision,
          })
        : await model.mutate(TASKS.create, {
            ...content,
            id: d.id,
            status: d.status,
          });
      const latest = model.getSnapshot().tasks.find((task) => task.id === d.id);
      if (saved && latest && editorSession.getSnapshot().draft?.id === d.id) editorSession.saved(latest);
      return saved && latest ? latest : null;
    };
    const link = async (
      attach: boolean,
      serverId: string,
      threadId: string,
    ) => {
      let d = editorSession.getSnapshot().draft;
      if (d && !d.revision) {
        if (!await save()) return false;
        d = editorSession.getSnapshot().draft;
      }
      if (!d?.revision) return false;
      const saved = await model.mutate(attach ? TASKS.attach : TASKS.detach, {
        id: d.id,
        expectedRevision: d.revision,
        serverId,
        threadId,
      });
      const latest = model.getSnapshot().tasks.find((task) => task.id === d.id);
      if (saved && latest && editorSession.getSnapshot().draft?.id === d.id)
        editorSession.rebase(latest);
      return saved;
    };
    const open = (link: TaskConversation) => {
      try {
        if (!host.openConversation) throw new Error();
        void Promise.resolve(
          host.openConversation(link.serverId, link.threadId),
        ).then(
          () => setRouteError(false),
          () => setRouteError(true),
        );
      } catch {
        setRouteError(true);
      }
    };
    const move = (
      task: TaskDetail,
      status: TaskStatus,
      beforeId: string | null,
      revision = task.revision,
    ) =>
      model.mutate(TASKS.move, {
        id: task.id,
        expectedRevision: revision,
        status,
        beforeId,
      });
    const projectKey = (task: TaskDetail) =>
      task.projectId
        ? JSON.stringify([task.projectServerId, task.projectId])
        : "";
    const projects = [
      ...new Map(
        state.tasks
          .filter((task) => task.projectId)
          .map((task) => [projectKey(task), task]),
      ).entries(),
    ];
    const tasks = state.tasks.filter(
      (task) => (!draft.project || projectKey(task) === draft.project)
        && (!draft.search.trim() || `${task.title} ${task.description}`.toLocaleLowerCase().includes(draft.search.trim().toLocaleLowerCase()))
        && (!draft.assignee || (draft.assignee === "mine" ? !!myMemberId && task.assigneeId === myMemberId : draft.assignee === "unassigned" ? !task.assigneeId : task.assigneeId === draft.assignee.slice(7)))
        && (!draft.overdue || isOverdue(task))
        && (!draft.kind || (task.kind ?? "unclassified") === draft.kind)
        && (!draft.aiResearch || (task.aiResearch ?? "unassessed") === draft.aiResearch),
    );
    const archiveTask = async (item: TaskDetail) => {
      const saved = await model.mutate(TASKS.archive, { id: item.id, expectedRevision: item.revision });
      if (!saved || !viewLive.current) return;
      if (editorSession.getSnapshot().draft?.id === item.id) {
        opener.current = managementActions.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]') ?? null;
        editorSession.close();
      }
      managementActions.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus();
    };
    const cards = (tasks: readonly TaskDetail[]) =>
      tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          members={state.members}
          pending={state.pending}
          activity={activity}
          onEdit={() => openEditor(task)}
          onQuick={() => openEditor(task, task.status, true)}
          onArchive={state.archive && !state.pending ? () => void archiveTask(task) : undefined}
          onOpen={open}
        />
      ));
    return (
      <div ref={viewport} className="tasks-viewport">
        <section className="tasks">
          <div className="tasks-overview" data-conversation-overview={overviewOpen && !managementOpen && !morningOpen}>
          <div className="tasks-page-heading">
            <div className="tasks-heading-title" ref={recycleHeading}>
              {morningOpen ? <SettingsButton data-morning-back="" variant="ghost" className="tasks-icon-action" aria-label={t("cancel")} title={t("cancel")} onClick={() => setMorningOpen(false)}><ArrowLeft size={18} aria-hidden="true" /></SettingsButton> : managementOpen ? <SettingsButton variant="ghost" className="tasks-icon-action" aria-label={t("cancel")} title={t("cancel")} onClick={() => { setRecycleOpen(false); setArchiveOpen(false); }}><ArrowLeft size={18} aria-hidden="true" /></SettingsButton> : null}
              <h2 className="tasks-title">{morningOpen ? t("morningOverview") : archiveOpen ? t("archivedTasks") : recycleOpen ? t("recycleBin") : t("tasks")}</h2>
            </div>
            <div className="tasks-heading-actions" ref={managementActions}>
              {morningOpen ? <SettingsButton variant="ghost" className="tasks-icon-action" aria-label={t("refreshBoard")} title={t("refreshBoard")} aria-busy={refreshing} disabled={state.pending || refreshing || state.phase === "loading"} onClick={() => void refreshTasks()}><RefreshCw size={18} aria-hidden="true" /></SettingsButton> : managementOpen ? <SettingsButton variant="ghost" className="tasks-icon-action" aria-label={t(archiveOpen ? "refreshArchive" : "refreshRecycle")} title={t(archiveOpen ? "refreshArchive" : "refreshRecycle")} aria-busy={archiveOpen ? archiveState.loading : refreshing} disabled={state.pending || (archiveOpen ? archiveState.loading : refreshing)} onClick={() => void (archiveOpen ? archives.refresh() : refreshTasks())}><RefreshCw size={18} aria-hidden="true" /></SettingsButton> : <>
                <SettingsButton data-morning-entry="" variant="quiet" aria-label={t("morningOverview")} onClick={() => setMorningOpen(true)}><Sunrise size={18} aria-hidden="true" /><span className="tasks-wide-only">{t("morningOverview")}</span><span className="tasks-compact-only">{t("morningShort")}</span></SettingsButton>
                <SettingsButton className="tasks-create" variant="primary" aria-label={t("add")} disabled={state.phase !== "ready" || state.pending} onClick={() => openEditor()}><Plus size={18} aria-hidden="true" /><span className="tasks-wide-only">{t("add")}</span></SettingsButton>
                <DropdownMenu.Root><DropdownMenu.Trigger asChild>
                  <SettingsButton variant="ghost" className="tasks-icon-action" aria-label={t("moreActions")} title={t("moreActions")}><MoreHorizontal size={18} aria-hidden="true" /></SettingsButton>
                </DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="tasks-board-menu" align="end" sideOffset={4} collisionPadding={12}>
                  <DropdownMenu.Item disabled={state.pending || refreshing || state.phase === "loading"} onSelect={() => void refreshTasks()}><RefreshCw size={16} aria-hidden="true" />{t("refreshBoard")}</DropdownMenu.Item>
                  {state.archive ? <DropdownMenu.Item disabled={state.phase !== "ready"} onSelect={() => setArchiveOpen(true)}><Archive size={16} aria-hidden="true" />{t("archivedTasks")}</DropdownMenu.Item> : null}
                  {state.recycleBinRetentionMs !== null ? <DropdownMenu.Item disabled={state.phase !== "ready"} onSelect={() => setRecycleOpen(true)}><Trash2 size={16} aria-hidden="true" />{t("recycleBin")}</DropdownMenu.Item> : null}
                </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
              </>}
            </div>
          </div>
          <header className={`tasks-toolbar${draft.mode === "ai" && !overviewOpen ? " tasks-toolbar--ai-follow-up" : ""}`} hidden={managementOpen || morningOpen}>
            <SegmentedControl
              className="tasks-view-switch"
              label={t("view")}
              value={overviewOpen ? "overview" : draft.mode}
              onValueChange={(mode) => {
                setOverviewOpen(mode === "overview");
                if (mode !== "overview") change({ mode: mode as ViewDraft["mode"] });
              }}
              options={[
                { value: "board", label: <><Columns3 className="tasks-compact-only" size={18} aria-hidden="true" /><span className="tasks-view-label">{t("board")}</span></> },
                { value: "list", label: <><List className="tasks-compact-only" size={18} aria-hidden="true" /><span className="tasks-view-label">{t("list")}</span></> },
                { value: "ai", label: <><MessageSquare className="tasks-compact-only" size={18} aria-hidden="true" /><span className="tasks-view-label">{t("aiFollowUp")}</span></> },
                ...(ports.conversationOverview ? [{ value: "overview", label: <><ChartNoAxesCombined className="tasks-compact-only" size={18} aria-hidden="true" /><span className="tasks-view-label">{t("conversationOverview")}</span><small className="tasks-view-beta">Beta</small></> }] : []),
              ]}
            />
            {draft.mode !== "ai" || overviewOpen ? <>
            <SettingsTextInput className="tasks-search" aria-label={t("searchTasks")} placeholder={t("searchTasks")} type="search" value={draft.search} onChange={e=>change({search:e.target.value})} />
            {state.properties ? <SettingsButton className="tasks-mine" variant="quiet" aria-label={t("myTasks")} title={t("myTasks")} aria-pressed={draft.assignee === "mine"} onClick={() => {
              change({ assignee: draft.assignee === "mine" ? "" : "mine" });
              if (draft.assignee !== "mine" && !myMemberId) setFiltersOpen(true);
            }}><UserRound size={18} aria-hidden="true" /><span className="tasks-wide-only">{t("myTasks")}</span></SettingsButton> : null}
            <SettingsButton className="tasks-filter-trigger" variant="quiet" aria-label={t("filters")} title={t("filters")} aria-expanded={filtersOpen} aria-controls={filterId} onClick={()=>setFiltersOpen(value=>!value)}>
              <SlidersHorizontal size={18} aria-hidden="true" /><span className="tasks-wide-only">{t("filters")}</span>
              {(draft.assignee || draft.project || draft.overdue || draft.kind || draft.aiResearch) ? <span className="tasks-filter-count" aria-hidden="true">{Number(!!draft.assignee)+Number(!!draft.project)+Number(draft.overdue)+Number(!!draft.kind)+Number(!!draft.aiResearch)}</span> : null}
            </SettingsButton>
            </> : null}
            <SettingsButton className="tasks-refresh tasks-icon-action" variant="ghost" aria-label={t("refreshBoard")} title={t("refreshBoard")} aria-busy={refreshing} disabled={state.pending || refreshing || state.phase === "loading"} onClick={() => void refreshTasks()}><RefreshCw size={18} aria-hidden="true" /></SettingsButton>
            <div id={filterId} className="tasks-filters" hidden={!filtersOpen || (draft.mode === "ai" && !overviewOpen)} role="group" aria-label={t("filters")}>
            {state.aiResearch ? <label>{t("aiResearch")}<SettingsSelect aria-label={t("aiResearch")} value={draft.aiResearch} onChange={event => change({ aiResearch: event.target.value })}><option value="">{t("allResearch")}</option>{TASK_AI_RESEARCH.map(mode => <option key={mode} value={mode}>{researchLabel(mode, t)}</option>)}</SettingsSelect></label> : null}
            {state.planning ? <label>{t("kind")}<SettingsSelect aria-label={t("kind")} value={draft.kind} onChange={event => change({ kind: event.target.value })}><option value="">{t("allKinds")}</option>{[...new Set([...TASK_KINDS, ...state.tasks.map(task => task.kind ?? "unclassified")])].map(kind => <option key={kind} value={kind}>{kt(kind)}</option>)}</SettingsSelect></label> : null}
            {state.properties ? <>
              <label>{t("assignee")}<SettingsSelect aria-label={t("assignee")} value={draft.assignee} onChange={e=>change({assignee:e.target.value})}>
                <option value="">{t("allPeople")}</option><option value="mine">{t("myTasks")}</option><option value="unassigned">{t("unassigned")}</option>
                {state.members.map(member=><option key={member.id} value={`member:${member.id}`}>{member.name} · {member.id}</option>)}
              </SettingsSelect></label>
              <SettingsButton variant="quiet" aria-pressed={draft.overdue} onClick={()=>change({overdue:!draft.overdue})}>{t("overdue")}</SettingsButton>
              {draft.assignee === "mine" && (!host.currentUser || !myMemberId || selectedMember) ? <label>{t("myMember")}<SettingsSelect className="tasks-self-member" aria-label={t("myMember")} value={myMemberId ?? ""} onChange={e => {
                const value = e.target.value;
                localSelections.set(memberScope, value);
                memberStore?.set("selfMember", value);
                refreshLocalSelection(epoch => epoch + 1);
              }}>
                <option value="">{t("chooseMyMember")}</option>
                {state.members.map(member => <option key={member.id} value={member.id}>{member.name} · {member.id}</option>)}
              </SettingsSelect></label> : null}
            </> : null}
            {projects.length || draft.project ? (
              <label>{t("project")}<SettingsSelect
                aria-label={t("project")}
                disabled={managementOpen}
                value={draft.project}
                onChange={(e) => change({ project: e.target.value })}
              >
                <option value="">{t("allProjects")}</option>
                {projects.map(([key, task]) => (
                  <option key={key} value={key}>
                    {projectNames.get(key) ?? t("project")} ·{" "}
                    {host.profiles.find(
                      (profile) =>
                        origin(host, profile.hostId) === task.projectServerId,
                    )?.displayName ?? t("unknown")}
                  </option>
                ))}
              </SettingsSelect></label>
            ) : null}

            </div>
          </header>
          {overviewOpen && !managementOpen && !morningOpen && ports.conversationOverview ? <Suspense fallback={<p role="status">{t("loadingConversations")}</p>}><ConversationOverview key={memberScope} port={ports.conversationOverview} host={host} /></Suspense> : null}
          {(ports.pendingConversationLinks?.() ?? []).map(link => (
            <SettingsNotice key={`${link.taskId}:${linkKey(link)}`} tone="error">
              {t("pendingLink")}{" "}
              <SettingsButton variant="quiet" onClick={() => open({ ...link, createdAt: 0 })}>{t("open")}</SettingsButton>
              <SettingsButton variant="quiet" onClick={() => void ports.retryConversationLinks?.(link.taskId)}>{t("retryLink")}</SettingsButton>
            </SettingsNotice>
          ))}
          {overviewOpen && !managementOpen && !morningOpen ? null : state.phase === "loading" ? <TasksLoading mode={draft.mode} selected={draft.status} /> : state.phase !== "ready" ? (
            <div className="tasks-load-error" role="status">
              <SettingsNotice>{t(state.phase === "unavailable" ? "unavailable" : "loadError")}</SettingsNotice>
              <SettingsButton disabled={refreshing} onClick={() => void refreshTasks()}>{t("retry")}</SettingsButton>
            </div>
          ) : <>
          {morningOpen ? <MorningOverview /> : null}
          {draft.mode === "ai" && !morningOpen && !managementOpen && !overviewOpen ? <AIFollowUp dwellSince={ports.followUpDwellSince} tasks={state.tasks} members={state.members} activity={state.activity} port={morningPort} myMemberId={myMemberId} selection={aiViewSelections.get(memberScope) ?? { scope: "all", search: "" }} onSelectionChange={value => { aiViewSelections.set(memberScope, value); refreshLocalSelection(epoch => epoch + 1); }} ownerFilter={aiOwnerSelections.get(memberScope) ?? ""} onOwnerFilterChange={value => { aiOwnerSelections.set(memberScope, value); refreshLocalSelection(epoch => epoch + 1); }} onOpenConversation={host.openConversation ? open : undefined} /> : null}
          {archiveOpen && state.archive ? <ArchivePanel model={archives} members={state.members} pending={state.pending} reportError={reportError} ports={ports} session={editorSession}
            activityFor={item => { let activity = activities.get(item.id); if (!activity) { activity = new TaskActivityController({ request: (method, params) => ports.request(authority!, method, params) }, item.id, () => {}); activities.set(item.id, activity); } return activity; }}
            onRead={id => ports.request(authority!, TASKS.read, { id })} onOpen={open} onRestore={async item => { const saved = await model.mutate(TASKS.unarchive, { id: item.id, expectedRevision: item.revision }); await archives.refresh(); return saved; }} /> : null}
          <section hidden={!recycleOpen} className="tasks-recycle" aria-label={t("recycleBin")}>
            <p>{t("recycleHint")}</p>
            {state.recycled.length === 0 ? <p>{t("recycleEmpty")}</p> : <ul className="tasks-recycle__list">
              {state.recycled.map(task => <li key={task.id} className="tasks-recycle__row">
                <div><strong>{task.title}</strong><div className="tasks-recycle__metadata">
                  {t(task.status)} · {t("restoreBy")} {new Date(task.deletedAt! + state.recycleBinRetentionMs!).toLocaleString()}
                </div><details><summary className="ui-native-disclosure">{t("description")}</summary><p className="tasks-recycle__description">{task.description}</p></details></div>
                <SettingsButton disabled={state.pending || state.phase !== "ready"} aria-label={`${t("restore")} ${task.title}`}
                  onClick={() => { setRestoringId(task.id); void model.mutate(TASKS.restore, { id: task.id, expectedRevision: task.revision }).finally(() => setRestoringId(null)); }}>
                  {restoringId === task.id ? t("restoring") : t("restore")}
                </SettingsButton>
              </li>)}
            </ul>}
          </section>
          <div className="tasks-active-view" hidden={managementOpen || morningOpen || draft.mode === "ai"}>
          {draft.mode === "board" ? (
            <SegmentedControl
              className="tasks-statuses tasks-compact-only"
              label={t("status")}
              value={draft.status}
              onValueChange={(status) =>
                change({ status: status as TaskStatus })
              }
              options={TASK_STATUSES.map((status) => ({
                value: status,
                label: `${t(status)} ${tasks.filter((task) => task.status === status).length}`,
              }))}
            />
          ) : null}
          {(draft.search || draft.assignee || draft.project || draft.overdue || draft.kind || draft.aiResearch) ? <div className="tasks-filter-result" role="status"><span>{draft.assignee === "mine" && !myMemberId ? t("chooseMyMember") : tasks.length ? `${tasks.length} ${t("results")}` : t("noResults")}</span><SettingsButton variant="quiet" onClick={()=>change({search:"",assignee:"",project:"",overdue:false,kind:"",aiResearch:""})}>{t("clearFilters")}</SettingsButton></div> : null}
          {hiddenCreated ? <div className="tasks-filter-result" role="status"><span>{t("hiddenCreated")}</span><SettingsButton variant="quiet" onClick={() => { change({ search: "", assignee: "", project: "", overdue: false, kind: "", aiResearch: "" }); setHiddenCreated(false); }}>{t("clearFilters")}</SettingsButton></div> : null}
            {draft.mode === "board" ? (
              <div className="tasks-columns">
                {TASK_STATUSES.map((status) => {
                  const items = tasks.filter((task) => task.status === status);
                  return (
                    <Column
                      key={status}
                      status={status}
                      tasks={items}
                      selected={draft.status === status}
                      positions={positions}
                      pending={state.pending || state.phase !== "ready"}
                      onAdd={() => { if (!editorSession.inlineDrafts.has(status)) editorSession.inlineDrafts.set(status, { id: crypto.randomUUID(), title: "" }); setInlineStatus(status); }}
                      footer={inlineStatus === status ? <InlineCreate value={editorSession.inlineDrafts.get(status)!} busy={state.pending} inherited={!!draft.kind || !!draft.project}
                        onChange={title => { editorSession.inlineDrafts.set(status, { ...editorSession.inlineDrafts.get(status)!, title }); updateInline(epoch => epoch + 1); }}
                        onClose={() => setInlineStatus(null)} onSave={async () => {
                          const input = editorSession.inlineDrafts.get(status)!;
                          let projectServerId: string | null = null, projectId: string | null = null;
                          if (draft.project) [projectServerId, projectId] = JSON.parse(draft.project);
                          const saved = await model.mutate(TASKS.create, { id: input.id, title: input.title.trim(), description: "", status, projectServerId, projectId, ...(state.planning ? { kind: draft.kind || "unclassified", acceptanceCriteria: "" } : {}) });
                          if (saved) { editorSession.inlineDrafts.set(status, { id: crypto.randomUUID(), title: "" }); updateInline(epoch => epoch + 1); if (draft.search || draft.assignee || draft.overdue) setHiddenCreated(true); }
                        }} /> : <SettingsButton variant="quiet" className="tasks-column__add" disabled={state.pending || state.phase !== "ready"} onClick={() => { if (!editorSession.inlineDrafts.has(status)) editorSession.inlineDrafts.set(status, { id: crypto.randomUUID(), title: "" }); setInlineStatus(status); }}><Plus size={15} />{t("inlineAdd")}</SettingsButton>}
                    >
                      {cards(items)}
                    </Column>
                  );
                })}
              </div>
            ) : (
              <div className="tasks-list">
                  {tasks.map(task => <TaskRow key={task.id} task={task} members={state.members} pending={state.pending} activity={activity}
                    onEdit={() => openEditor(task)} onMove={status => void move(task, status, null)} />)}
                {!tasks.length ? <p>{t(draft.search || draft.assignee || draft.project || draft.overdue ? "noResults" : "empty")}</p> : null}
              </div>
            )}
          </div>
          </>}
          </div>
                {edit && editing.presentation === "quick" && task ? <QuickEditor draft={edit} task={task} session={editorSession} planning={state.planning} supportedKinds={state.supportedKinds} properties={state.properties} members={state.members} busy={state.pending} compact={compact} anchor={opener.current} onSave={save} onStatus={changeStatus} /> : null}
                {edit && (editing.presentation === "detail" || !task) ? (
                  <Editor
                    key={edit.id}
                    draft={edit}
                    planning={state.planning} supportedKinds={state.supportedKinds} aiResearch={state.aiResearch} session={editorSession} canPostProgress={state.progress}
                    activityModel={task && state.activity ? (() => { let activity = activities.get(task.id); if (!activity) { activity = new TaskActivityController({ request: (method, params) => ports.request(authority!, method, params) }, task.id, () => { void model.refresh(); }); activities.set(task.id, activity); } return activity; })() : undefined}
                    members={state.members}
                    properties={state.properties}
                    memberIdentity={state.memberIdentity}
                    onMember={input=>model.mutate(TASKS.members,input)}
                    setDraft={(editor) => changeEditor(editor)}
                    task={task}
                    host={host}
                    ports={ports}
                    pending={state.pending}
                    error={null}
                    activity={activity}
                    onSave={(event) => { event.preventDefault(); void save(); }}
                    onBeginConversation={async hostId => {
                      const saved = await save();
                      if (!saved || !ports.prepareConversation) return;
                      if (!viewLive.current) throw new Error("Task View closed");
                      await ports.prepareConversation(saved.id, hostId);
                    }}
                    onStatus={changeStatus}
                    onClose={() => editorSession.close()}
                    returnFocus={() => opener.current}
                    onLatest={() => {
                      if (task) editorSession.saved(task);
                    }}
                    onArchive={state.archive && task ? () => void archiveTask(task) : undefined}
                    onRemove={() => {
                      const d = editorSession.getSnapshot().draft;
                      if (d?.revision)
                        void model
                          .mutate(TASKS.remove, {
                            id: d.id,
                            expectedRevision: d.revision,
                          })
                          .then((saved) => {
                            if (saved) editorSession.close();
                          });
                    }}
                    onLink={link}
                    onOpen={open}
                  />
                ) : null}
        </section>
      </div>
    );
  };
}
