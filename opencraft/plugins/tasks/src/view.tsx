import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
  type TaskContent,
  type TaskDetail,
  type TaskConversation,
  type TaskStatus,
} from "@opencraft/appserver-protocol";
import type { TasksExtensionPorts, TaskConversationActivity } from "./index";
import { TasksController } from "./controller";
import "./styles.scss";
const words = {
  tasks: ["任务", "Tasks"],
  board: ["看板", "Board"],
  list: ["列表", "List"],
  add: ["新建任务", "New task"],
  edit: ["任务详情", "Task details"],
  title: ["标题", "Title"],
  description: ["说明", "Description"],
  save: ["保存", "Save"],
  cancel: ["返回任务", "Back to tasks"],
  remove: ["删除任务", "Delete task"],
  refresh: ["刷新", "Refresh"],
  loading: ["正在读取任务…", "Loading tasks…"],
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
    "任务已删除，你的输入仍保留。",
    "This task was deleted. Your draft is retained.",
  ],
  status: ["任务状态", "Task status"],
  move: ["移动到", "Move to"],
  drag: ["拖动任务", "Drag task"],
  backlog: ["待规划", "Backlog"],
  todo: ["待办", "To do"],
  in_progress: ["进行中", "In progress"],
  in_review: ["待审核", "In review"],
  done: ["已完成", "Done"],
  canceled: ["已取消", "Canceled"],
  source: ["会话连接", "Conversation connection"],
  search: ["搜索会话", "Search conversations"],
  conversation: ["选择会话", "Select conversation"],
  attach: ["关联会话", "Link conversation"],
  detach: ["解除关联", "Unlink"],
  open: ["打开会话", "Open conversation"],
  newConversation: ["新建会话", "New conversation"],
  executionSource: ["执行连接", "Execution connection"],
  prepareError: ["未能打开聊天，请检查连接后重试。", "Could not open chat. Check the connection and retry."],
  pendingLink: ["会话已创建，关联尚未完成。", "Conversation created; linking is incomplete."],
  retryLink: ["重试关联", "Retry linking"],
  links: ["关联会话", "Conversations"],
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
interface Draft extends TaskContent {
  id: string;
  status: TaskStatus;
  revision: number | null;
}
interface ViewDraft {
  editor: Draft | null;
  mode: "board" | "list";
  status: TaskStatus;
  project: string;
}
function draftFor(task?: TaskDetail, status: TaskStatus = "todo"): Draft {
  return {
    id: task?.id ?? crypto.randomUUID(),
    title: task?.title ?? "",
    description: task?.description ?? "",
    status: task?.status ?? status,
    projectServerId: task?.projectServerId ?? null,
    projectId: task?.projectId ?? null,
    revision: task?.revision ?? null,
  };
}
function TaskCard({
  task,
  pending,
  onEdit,
  onOpen,
  activity,
}: {
  task: TaskDetail;
  pending: boolean;
  onEdit(): void;
  onOpen(link: TaskConversation): void;
  activity: ReadonlyMap<string, TaskConversationActivity>;
}) {
  const t = useText(),
    sortable = useSortable({ id: task.id, disabled: pending });
  const states = task.conversations.map(
    (link) => activity.get(linkKey(link))?.state ?? "unknown",
  );
  return (
    <article
      ref={sortable.setNodeRef}
      data-task-id={task.id}
      className={`tasks-card${sortable.isDragging ? " tasks-card--dragging" : ""}`}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      aria-busy={pending}
    >
      <div className="tasks-card__heading">
        <SettingsButton
          variant="ghost"
          className="tasks-card__handle"
          disabled={pending}
          {...sortable.attributes}
          {...sortable.listeners}
          aria-label={`${t("drag")}: ${task.title}`}
        >
          ⠿
        </SettingsButton>
        <button type="button" className="tasks-card__title" onClick={onEdit}>
          {task.title}
        </button>
      </div>
      {states.length ? (
        <p className="tasks-card__activity">
          {t("links")} {states.length} ·{" "}
          {[...new Set(states)].map((state) => t(state)).join(" / ")}
        </p>
      ) : null}
      {task.conversations.slice(0, 1).map(link => (
        <SettingsButton key={linkKey(link)} type="button" variant="quiet"
          className="tasks-card__conversation" title={activity.get(linkKey(link))?.title ?? t("open")} onClick={() => onOpen(link)}>
          {t("open")}{activity.get(linkKey(link))?.title ? ` · ${activity.get(linkKey(link))!.title}` : ""}
        </SettingsButton>
      ))}
    </article>
  );
}

function TaskRow({ task, pending, onEdit, onMove, activity }: {
  task: TaskDetail;
  pending: boolean;
  onEdit(): void;
  onMove(status: TaskStatus): void;
  activity: ReadonlyMap<string, TaskConversationActivity>;
}) {
  const t = useText(), sortable = useSortable({ id: task.id, disabled: pending });
  const states = [...new Set(task.conversations.map(link => activity.get(linkKey(link))?.state ?? "unknown"))];
  return (
    <article ref={sortable.setNodeRef} className={`tasks-row${sortable.isDragging ? " tasks-card--dragging" : ""}`} data-task-id={task.id} aria-busy={pending}
      style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}>
      <SettingsButton variant="ghost" className="tasks-card__handle" disabled={pending}
        {...sortable.attributes} {...sortable.listeners} aria-label={`${t("drag")}: ${task.title}`}>⠿</SettingsButton>
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
}: {
  status: TaskStatus;
  tasks: readonly TaskDetail[];
  selected: boolean;
  children: React.ReactNode;
  onAdd(): void;
  positions: Map<string, number>;
  pending: boolean;
}) {
  const t = useText(),
    drop = useDroppable({ id: status });
  const element = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (element.current) element.current.scrollTop = positions.get(status) ?? 0;
  }, [selected, status, positions]);
  return (
    <section
      ref={(node) => {
        element.current = node;
        drop.setNodeRef(node);
      }}
      onScroll={(event) => {
        if (event.currentTarget.clientHeight > 0)
          positions.set(status, event.currentTarget.scrollTop);
      }}
      data-status={status}
      className={`tasks-column${selected ? " tasks-column--selected" : ""}${drop.isOver ? " tasks-column--over" : ""}`}
      aria-label={t(status)}
    >
      <header>
        <h2>
          {t(status)} <span>{tasks.length}</span>
        </h2>
        <SettingsButton
          variant="ghost"
          onClick={onAdd}
          disabled={pending}
          aria-label={`${t("add")}: ${t(status)}`}
        >
          ＋
        </SettingsButton>
      </header>
      <SortableContext
        items={tasks.map((task) => task.id)}
        strategy={verticalListSortingStrategy}
      >
        {children}
      </SortableContext>
      {!tasks.length ? <p>{t("empty")}</p> : null}
    </section>
  );
}
function Editor({
  draft,
  setDraft,
  task,
  host,
  ports,
  pending,
  error,
  activity,
  onSave,
  onClose,
  onLatest,
  onRemove,
  onLink,
  onOpen,
  onBeginConversation,
  onStatus,
}: {
  draft: Draft;
  setDraft(d: Draft): void;
  task?: TaskDetail;
  host: PlatformViewHost;
  ports: TasksExtensionPorts;
  pending: boolean;
  error: string | null;
  activity: ReadonlyMap<string, TaskConversationActivity>;
  onSave(e: FormEvent): void;
  onClose(): void;
  onLatest(): void;
  onRemove(): void;
  onLink(attach: boolean, serverId: string, threadId: string): Promise<boolean>;
  onOpen(link: TaskConversation): void;
  onBeginConversation(hostId: string): Promise<void>;
  onStatus(status: TaskStatus): Promise<void>;
}) {
  const t = useText();
  const live = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const [source, setSource] = useState(""),
    [executionHost, setExecutionHost] = useState(() => (draft.projectServerId ? hostFor(host, draft.projectServerId) : null) ?? host.activeHostId),
    [preparing, setPreparing] = useState(false),
    [prepareError, setPrepareError] = useState(false),
    [search, setSearch] = useState(""),
    [threadId, setThreadId] = useState(""),
    [threads, setThreads] = useState<readonly { id: string; title: string }[]>(
      [],
    ),
    [readError, setReadError] = useState(false),
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
    if (!source) return;
    const timer = setTimeout(() => {
      void ports.listThreads(source, search).then(
        (value) => {
          if (live) setThreads(value);
        },
        () => {
          if (live) setReadError(true);
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
    <form className="tasks-editor" onSubmit={onSave} aria-label={t("edit")}>
      <header className="tasks-editor__header">
        <h2 ref={heading} tabIndex={-1}>{t("edit")}</h2>
        <SettingsButton
          className="tasks-compact-only"
          type="submit"
          variant="primary"
          disabled={blocked || !draft.title.trim()}
        >
          {t("save")}
        </SettingsButton>
        <SettingsButton
          type="button"
          variant="quiet"
          disabled={busy}
          onClick={onClose}
        >
          {t("cancel")}
        </SettingsButton>
      </header>
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
        <label>
          {t("description")}
          <textarea
            aria-label={t("description")}
            maxLength={16384}
            value={draft.description}
            onChange={(e) => update({ description: e.target.value })}
          />
        </label>
        </section>
        <aside className="tasks-editor__properties">
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
        </aside>
          <section className="tasks-editor__conversations">
            <h2>{t("links")}</h2>
            {ports.prepareConversation ? (
              <div className="tasks-editor__fields">
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
                  onChange={(e) => setSource(e.target.value)}
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
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </label>
                  <label>
                    {t("conversation")}
                    <SettingsSelect
                      aria-label={t("conversation")}
                      value={threadId}
                      onChange={(e) => setThreadId(e.target.value)}
                    >
                      <option value="">{t("choose")}</option>
                      {threads.map((thread) => (
                        <option key={thread.id} value={thread.id}>
                          {thread.title}
                        </option>
                      ))}
                    </SettingsSelect>
                  </label>
                  <SettingsButton
                    type="button"
                    disabled={blocked || !draft.title.trim() || !threadId}
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
        {changed ? (
          <SettingsNotice>
            {t("newer")}{" "}
            <SettingsButton type="button" onClick={onLatest}>
              {t("latest")}
            </SettingsButton>
          </SettingsNotice>
        ) : null}
        {removed ? <SettingsNotice>{t("removed")}</SettingsNotice> : null}
        {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
      </fieldset>
      <footer className="tasks-editor__actions">
        <SettingsButton
          className="tasks-wide-only"
          type="submit"
          variant="primary"
          disabled={blocked || !draft.title.trim()}
        >
          {t("save")}
        </SettingsButton>
        {task ? (
          <SettingsButton type="button" disabled={blocked} onClick={onRemove}>
            {t("remove")}
          </SettingsButton>
        ) : null}
      </footer>
    </form>
  );
}
export function createTasksView(
  ports: TasksExtensionPorts,
  activationSignal: AbortSignal,
) {
  let controller: TasksController | null = null;
  const positions = new Map<string, number>();
  let remembered: ViewDraft = {
    editor: null,
    mode: "board",
    status: "todo",
    project: "",
  };
  activationSignal.addEventListener(
    "abort",
    () => {
      controller?.dispose();
      controller = null;
      positions.clear();
      remembered = { editor: null, mode: "board", status: "todo", project: "" };
    },
    { once: true },
  );
  return function TasksView({ host }: ExtensionSettingsViewProps) {
    const viewLive = useRef(true);
    useEffect(() => {
      viewLive.current = true;
      return () => { viewLive.current = false; };
    }, []);
    const t = useText(),
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
    const state = useSyncExternalStore(
      model.subscribe,
      model.getSnapshot,
      model.getSnapshot,
    );
    const [draft, setDraft] = useState(remembered),
      [routeError, setRouteError] = useState(false),
      [preparingConversation, setPreparingConversation] = useState(false),
      [activityEpoch, setActivityEpoch] = useState(0),
      [activity, setActivity] = useState<
        ReadonlyMap<string, TaskConversationActivity>
      >(new Map());
    const opener = useRef<HTMLElement | null>(null),
      drag = useRef<{ id: string; revision: number } | null>(null);
    const change = (value: Partial<ViewDraft>) => {
      remembered = { ...remembered, ...value };
      setDraft(remembered);
    };
    useEffect(() => {
      void model.start();
      let debounce: ReturnType<typeof setTimeout> | undefined;
      const refresh = () => {
        if (document.visibilityState !== "visible" || drag.current) return;
        void model.refresh();
        setActivityEpoch((value) => value + 1);
      };
      const stop = ports.subscribe((kind) => {
        if (kind === "tasks") void model.refresh();
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
    const sensors = useSensors(
      useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
      useSensor(TouchSensor, {
        activationConstraint: { delay: 180, tolerance: 8 },
      }),
      useSensor(KeyboardSensor, {
        coordinateGetter: sortableKeyboardCoordinates,
      }),
    );
    const openEditor = (task?: TaskDetail, status: TaskStatus = "todo") => {
      opener.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      change({ editor: draftFor(task, status) });
    };
    const task = state.tasks.find((task) => task.id === draft.editor?.id);
    const error = state.error
      ? t(
          state.error === "conflict"
            ? "conflict"
            : state.error === "save"
              ? "saveError"
              : "refreshError",
        )
      : routeError
        ? t("routeError")
        : null;
    const save = async () => {
      const d = remembered.editor;
      if (!d) return null;
      const content: TaskContent = {
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
      if (saved && latest && remembered.editor?.id === d.id) change({ editor: draftFor(latest) });
      return saved && latest ? latest : null;
    };
    const link = async (
      attach: boolean,
      serverId: string,
      threadId: string,
    ) => {
      let d = remembered.editor;
      if (d && !d.revision) {
        if (!await save()) return false;
        d = remembered.editor;
      }
      if (!d?.revision) return false;
      const saved = await model.mutate(attach ? TASKS.attach : TASKS.detach, {
        id: d.id,
        expectedRevision: d.revision,
        serverId,
        threadId,
      });
      const latest = model.getSnapshot().tasks.find((task) => task.id === d.id);
      if (saved && latest && remembered.editor?.id === d.id)
        change({
          editor: { ...remembered.editor!, revision: latest.revision },
        });
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
    const drop = ({ active, over }: DragEndEvent) => {
      const captured = drag.current;
      drag.current = null;
      if (!over || active.id === over.id || !captured) return;
      const task = state.tasks.find((t) => t.id === captured.id),
        target = state.tasks.find((t) => t.id === over.id),
        status = target?.status ?? TASK_STATUSES.find((s) => s === over.id);
      if (!task || !status) return;
      let beforeId = target?.id ?? null;
      if (
        target &&
        target.status === task.status &&
        task.sortOrder < target.sortOrder
      )
        beforeId =
          state.tasks.find(
            (t) => t.status === status && t.sortOrder > target.sortOrder,
          )?.id ?? null;
      void move(task, status, beforeId, captured.revision);
    };
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
      (task) => !draft.project || projectKey(task) === draft.project,
    );
    const cards = (tasks: readonly TaskDetail[]) =>
      tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          pending={state.pending}
          activity={activity}
          onEdit={() => openEditor(task)}
          onOpen={open}
        />
      ));
    return (
      <div className="tasks-viewport">
        <section className="tasks">
          <div className="tasks-overview" hidden={!!draft.editor}>
          <header className="tasks-toolbar">
            <h2>{t("tasks")}</h2>
            <SegmentedControl
              label={t("view")}
              value={draft.mode}
              onValueChange={(mode) =>
                change({ mode: mode as ViewDraft["mode"] })
              }
              options={[
                { value: "board", label: t("board") },
                { value: "list", label: t("list") },
              ]}
            />
            {projects.length || draft.project ? (
              <SettingsSelect
                aria-label={t("project")}
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
              </SettingsSelect>
            ) : null}
            <SettingsButton
              variant="primary"
              disabled={state.phase !== "ready" || state.pending}
              onClick={() => openEditor()}
            >
              {t("add")}
            </SettingsButton>
            <SettingsButton
              variant="quiet"
              disabled={state.pending}
              onClick={() => void model.start()}
            >
              {t("refresh")}
            </SettingsButton>
          </header>
          {state.phase === "loading" ? (
            <p>{t("loading")}</p>
          ) : state.phase === "unavailable" ? (
            <SettingsNotice>{t("unavailable")}</SettingsNotice>
          ) : null}
          {error && !draft.editor ? (
            <SettingsNotice tone="error">{error}</SettingsNotice>
          ) : null}
          {(ports.pendingConversationLinks?.() ?? []).map(link => (
            <SettingsNotice key={`${link.taskId}:${linkKey(link)}`} tone="error">
              {t("pendingLink")}{" "}
              <SettingsButton variant="quiet" onClick={() => open({ ...link, createdAt: 0 })}>{t("open")}</SettingsButton>
              <SettingsButton variant="quiet" onClick={() => void ports.retryConversationLinks?.(link.taskId)}>{t("retryLink")}</SettingsButton>
            </SettingsNotice>
          ))}
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
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={({ active }) => {
              const task = state.tasks.find((t) => t.id === active.id);
              drag.current = task
                ? { id: task.id, revision: task.revision }
                : null;
            }}
            onDragEnd={drop}
            onDragCancel={() => {
              drag.current = null;
            }}
          >
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
                      onAdd={() => openEditor(undefined, status)}
                    >
                      {cards(items)}
                    </Column>
                  );
                })}
              </div>
            ) : (
              <div className="tasks-list">
                <SortableContext
                  items={tasks.map((task) => task.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {tasks.map(task => <TaskRow key={task.id} task={task} pending={state.pending} activity={activity}
                    onEdit={() => openEditor(task)} onMove={status => void move(task, status, null)} />)}
                </SortableContext>
                {!tasks.length ? <p>{t("empty")}</p> : null}
              </div>
            )}
          </DndContext>
          </div>
                {draft.editor ? (
                  <Editor
                    key={draft.editor.id}
                    draft={draft.editor}
                    setDraft={(editor) => change({ editor })}
                    task={task}
                    host={host}
                    ports={ports}
                    pending={state.pending}
                    error={error}
                    activity={activity}
                    onSave={(event) => { event.preventDefault(); void save(); }}
                    onBeginConversation={async hostId => {
                      setPreparingConversation(true);
                      try {
                        const saved = await save();
                        if (!saved || !ports.prepareConversation) return;
                        if (!viewLive.current) throw new Error("Task View closed");
                        await ports.prepareConversation(saved.id, hostId);
                      } finally { setPreparingConversation(false); }
                    }}
                    onStatus={async status => {
                      const d = remembered.editor;
                      if (!d?.revision) return;
                      const moved = await model.mutate(TASKS.move, { id: d.id, expectedRevision: d.revision, status, beforeId: null });
                      const latest = model.getSnapshot().tasks.find(task => task.id === d.id);
                      if (moved && latest && remembered.editor?.id === d.id) change({ editor: { ...remembered.editor, status: latest.status, revision: latest.revision } });
                    }}
                    onClose={() => {
                      const target = opener.current;
                      change({ editor: null });
                      requestAnimationFrame(() => {
                        if (viewLive.current && !remembered.editor && target?.isConnected) target.focus({ preventScroll: true });
                      });
                    }}
                    onLatest={() => {
                      if (task) change({ editor: draftFor(task) });
                    }}
                    onRemove={() => {
                      const d = remembered.editor;
                      if (d?.revision)
                        void model
                          .mutate(TASKS.remove, {
                            id: d.id,
                            expectedRevision: d.revision,
                          })
                          .then((saved) => {
                            if (saved) change({ editor: null });
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
