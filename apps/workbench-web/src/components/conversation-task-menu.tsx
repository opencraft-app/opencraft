import { LoadingRingIcon as LoaderCircle, MoreIcon as MoreHorizontal, EditIcon as Pencil } from "@opencraft/design-system-web/action-icons";
import { TaskLinkIcon } from "@opencraft/design-system-web/task-link-icon";
import { ConversationSchedulesPanel } from "./conversation-schedules-panel";
import type { ConversationSchedulesRequestPort } from "@opencraft/appserver-protocol";
import { useAsyncNotices } from "./async-notices";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import { MessageIcon as MessageSquare, ArchiveIcon as Archive, ClockIcon as Clock, ForkIcon as GitFork, InfoIcon as Info, TasksIcon as ListTodo, PinIcon as Pin, PinOffIcon as PinOff } from "@opencraft/design-system-web/action-icons";
import { lazy, Suspense, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TASKS, type TaskDetail, type TasksRequestPort } from "@opencraft/appserver-protocol";
import { useIntl } from "@opencraft/i18n/react";
import {
  SettingsButton, SettingsGroup, SettingsListItem, SettingsNotice,
  SettingsPanel, SettingsSwitch, SettingsTextInput,
} from "@opencraft/extension-react";
import { ModalSurface } from "./modal";
import { ConversationRenameDialog } from "./conversation-rename-dialog";
import { ToolbarDock, type ToolbarDockAction } from "./toolbar-dock";
import { conversationToolbarDock } from "./toolbar-dock-state";
import "../styles/context-menu.scss";

const ImSources = lazy(() => import("@opencraft/plugin-im/sources").then(module => ({default:module.ImSources})));

const ConversationInformationDialog = lazy(() => import("./conversation-information-dialog"));

export interface ConversationTaskMenuProps {
  readonly im?: { fetcher: typeof fetch; openSettings(): void };
  readonly port?: TasksRequestPort;
  readonly schedules?: ConversationSchedulesRequestPort;
  readonly scope: string;
  readonly serverId: string;
  readonly threadId: string;
  readonly verifyConversation: () => Promise<void>;
  readonly onOpenTasks: () => void;
  readonly title?: string;
  readonly pinned?: boolean;
  readonly onRename?: (title: string) => Promise<void>;
  readonly onSetPinned?: (pinned: boolean) => Promise<void>;
  readonly onArchive?: () => Promise<void>;
  readonly onFork?: () => Promise<void>;
  readonly project?: string;
  readonly workspaceDirectory?: string;
}

type Props = ConversationTaskMenuProps;

function belongsTo(task: TaskDetail, target: Pick<Props, "serverId" | "threadId">) {
  return task.conversations.some(link => link.serverId === target.serverId && link.threadId === target.threadId);
}

type TaskProps = Props & { readonly port: TasksRequestPort };

function TaskRelationRow({ task, queryKey, ...target }: TaskProps & {
  task: TaskDetail;
  queryKey: readonly string[];
}) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const linked = belongsTo(task, target);
  const notices = useAsyncNotices();
  const mutation = useMutation({
    mutationFn: async (attach: boolean) => {
      if (attach) await target.verifyConversation();
      return target.port.request(attach ? TASKS.attach : TASKS.detach, {
        id: task.id, expectedRevision: task.revision, serverId: target.serverId, threadId: target.threadId,
      });
    },
    onError: () => notices.error({ key: `task-relation:${target.scope}:${target.serverId}:${task.id}:${target.threadId}`, detail: task.title,
      message: intl.formatMessage({ id: "tasks.relation.saveError", defaultMessage: "Could not confirm the change. Review the current selection and retry." }) }),
    // The backend owns the result, including commits whose acknowledgement was lost.
    // Never replay a mutation or optimistically replace another task's revision.
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
  return <SettingsListItem
    label={task.title}
    aria-busy={mutation.isPending || undefined}
    actions={<SettingsSwitch
      label={task.title}
      checked={linked}
      disabled={mutation.isPending}
      onCheckedChange={checked => mutation.mutate(checked)}
    />}
  />;
}

function TaskPicker(props: TaskProps & { onClose(): void; returnFocus(): HTMLElement | null }) {
  const intl = useIntl();
  const [search, setSearch] = useState("");
  const queryKey = ["opencraft", "tasks", props.scope];
  const query = useQuery({
    queryKey,
    queryFn: () => props.port.request(TASKS.list, {}),
    refetchInterval: 5000,
    retry: false,
  });
  const needle = search.trim().toLocaleLowerCase();
  const tasks = (query.data?.tasks ?? []).filter(task =>
    !needle || `${task.title}\n${task.description}`.toLocaleLowerCase().includes(needle),
  ).sort((a, b) => Number(belongsTo(b, props)) - Number(belongsTo(a, props)));
  const title = intl.formatMessage({ id: "tasks.relation.title", defaultMessage: "Link tasks" });
  return <ModalSurface label={title} size="compact" appearance="utility"
    onDismiss={props.onClose} returnFocus={props.returnFocus}>
    <SettingsPanel title={title} footer={<>
      <SettingsButton variant="quiet" onClick={() => { props.onClose(); props.onOpenTasks(); }}>
        {intl.formatMessage({ id: "tasks.relation.openTasks", defaultMessage: "Open tasks" })}
      </SettingsButton>
      <SettingsButton onClick={props.onClose}>{intl.formatMessage({ id: "tasks.relation.close", defaultMessage: "Done" })}</SettingsButton>
    </>}>
      <SettingsNotice>{intl.formatMessage({ id: "tasks.relation.hint", defaultMessage: "Link this conversation to one or more tasks. Changes are saved immediately." })}</SettingsNotice>
      <SettingsTextInput autoFocus value={search} onChange={event => setSearch(event.target.value)}
        aria-label={intl.formatMessage({ id: "tasks.relation.search", defaultMessage: "Search tasks" })}
        placeholder={intl.formatMessage({ id: "tasks.relation.search", defaultMessage: "Search tasks" })} />
      {query.isPending ? <SettingsNotice role="status">{intl.formatMessage({ id: "tasks.relation.loading", defaultMessage: "Loading tasks…" })}</SettingsNotice> : null}
      {query.isError ? <SettingsNotice tone="error" role="alert">
        {intl.formatMessage({ id: "tasks.relation.readError", defaultMessage: "Could not load tasks. Check the connection and retry." })}{" "}
        <SettingsButton disabled={query.isFetching} onClick={() => void query.refetch()}>
          {intl.formatMessage({ id: "tasks.relation.retry", defaultMessage: "Retry" })}
        </SettingsButton>
      </SettingsNotice> : null}
      {query.data && !tasks.length ? <SettingsNotice>
        {needle ? intl.formatMessage({ id: "tasks.relation.noMatches", defaultMessage: "No matching tasks." })
          : intl.formatMessage({ id: "tasks.relation.empty", defaultMessage: "No tasks yet. Create a task to link this conversation." })}
      </SettingsNotice> : null}
      <SettingsGroup aria-label={title}>
        {tasks.map(task => <TaskRelationRow key={task.id} {...props} task={task} queryKey={queryKey} />)}
      </SettingsGroup>
    </SettingsPanel>
  </ModalSurface>;
}

/** The application supplies the confirmed conversation identity and fixed Tasks authority. */
export function ConversationTaskMenu(props: Props) {
  const intl = useIntl();
  const notices = useAsyncNotices();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const actionTrigger = useRef<HTMLElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [imOpen, setImOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const [name, setName] = useState("");
  const rename = useMutation({
    onError: () => notices.error({ key: `rename:${props.scope}:${props.serverId}:${props.threadId}`, detail: props.title, message: intl.formatMessage({ id: "chat.rename.failed", defaultMessage: "Could not rename the conversation. Try again." }) }),
    mutationFn: (title: string) => props.onRename!(title),
    onSuccess: () => setRenameOpen(false),
  });
  const pin = useMutation({
    onError: () => notices.error({ key: `pin:${props.scope}:${props.serverId}:${props.threadId}`, detail: props.title, message: intl.formatMessage({ id: "chat.pin.failed", defaultMessage: "Could not update pin. Try again." }) }),
    mutationFn: (value: boolean) => props.onSetPinned!(value),
  });
  const archive = useMutation({
    onMutate: target => notices.loading({ key: target.key, detail: target.title,
      message: intl.formatMessage({ id: "chat.archive.pending", defaultMessage: "Archiving conversation…" }) }),
    onError: (_error, target) => notices.error({ key: target.key, detail: target.title,
      message: intl.formatMessage({ id: "tasks.relation.saveError", defaultMessage: "Could not confirm the change. Review the current selection and retry." }) }),
    mutationFn: (target: { key: string; title: string; execute: () => Promise<void> }) => target.execute(),
    retry: false,
    onSuccess: (_result, target) => notices.success({ key: target.key, detail: target.title,
      message: intl.formatMessage({ id: "chat.archive.done", defaultMessage: "Conversation archived" }) }),
  });
  const fork = useMutation({
    onError: () => notices.error({ key: `fork:${props.scope}:${props.serverId}:${props.threadId}`, detail: props.title, message: intl.formatMessage({ id: "chat.fork.unconfirmed", defaultMessage: "Could not confirm the new branch. Check the conversation list before trying again." }) }),
    mutationFn: () => props.onFork!(),
    retry: false,
  });
  const busy = pin.isPending || archive.isPending || fork.isPending;
  const label = intl.formatMessage({ id: "tasks.relation.actions", defaultMessage: "Conversation actions" });
  const actions: ToolbarDockAction[] = [];
  const add = (id: string, label: string, icon: ToolbarDockAction["icon"], invoke: () => void, dialog = false, pending = false) =>
    actions.push({ id, label, icon, invoke, dialog, disabled: busy, pending });
  if (props.port) add("link-tasks", intl.formatMessage({ id: "tasks.relation.title", defaultMessage: "Link tasks" }), <TaskLinkIcon size={16} aria-hidden="true" />, () => setPickerOpen(true), true);
  if (props.onRename) add("rename", intl.formatMessage({ id: "common.rename", defaultMessage: "Rename" }), <Pencil size={16} aria-hidden="true" />,
    () => { rename.reset(); setName(props.title ?? ""); setRenameOpen(true); }, true);
  if (props.onSetPinned) add("pin", intl.formatMessage(props.pinned ? { id: "chat.unpin", defaultMessage: "Unpin" } : { id: "chat.pin", defaultMessage: "Pin" }),
    props.pinned ? <PinOff size={16} aria-hidden="true" /> : <Pin size={16} aria-hidden="true" />, () => pin.mutate(props.pinned !== true));
  if (props.onFork) add("fork", intl.formatMessage({ id: "sidebar.thread.fork", defaultMessage: "Create branch" }),
    fork.isPending ? <LoaderCircle size={16} aria-hidden="true" /> : <GitFork size={16} aria-hidden="true" />, () => fork.mutate(), false, fork.isPending);
  if (props.onArchive) add("archive", intl.formatMessage({ id: "sidebar.thread.archive", defaultMessage: "Archive" }), <Archive size={16} aria-hidden="true" />,
    () => archive.mutate({ key: `archive:${props.scope}:${props.serverId}:${props.threadId}`, title: props.title ?? "", execute: props.onArchive! }));
  if (props.im) add("im-sources", "聊天来源", <MessageSquare size={16} aria-hidden="true" />, () => setImOpen(true), true);
  if (props.schedules) add("schedules", intl.formatMessage({ id: "schedules.title", defaultMessage: "Scheduled task" }), <Clock size={16} aria-hidden="true" />, () => setSchedulesOpen(true), true);
  if (props.project || props.workspaceDirectory) add("information", intl.formatMessage({ id: "chat.details.title", defaultMessage: "Conversation info" }), <Info size={16} aria-hidden="true" />, () => setDetailsOpen(true), true);
  const returnFocus = () => actionTrigger.current?.isConnected ? actionTrigger.current : trigger.current;
  return <>
    <span ref={node => { trigger.current = node?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]') ?? null; }} className="conversation-toolbar">
      <ToolbarDock scope={props.scope} dockId={conversationToolbarDock} defaultActions={["link-tasks"]} actions={actions} label={label}
        onActionTrigger={element => { actionTrigger.current = element; }} returnFocus={returnFocus} />
    </span>
    {renameOpen ? <ConversationRenameDialog value={name} pending={rename.isPending}
      onChange={setName} onSubmit={title => rename.mutate(title)} onDismiss={() => setRenameOpen(false)}
      returnFocus={returnFocus} /> : null}
    {imOpen && props.im ? <ModalSurface label="聊天来源" closeLabel="关闭聊天来源" size="compact" appearance="utility" onDismiss={() => setImOpen(false)} returnFocus={returnFocus}>
      <SettingsPanel title="聊天来源">
        <Suspense fallback={null}><ImSources fetcher={props.im.fetcher} hostId={props.serverId} threadId={props.threadId}
          onOpenSettings={() => { setImOpen(false); props.im!.openSettings(); }} reportError={message => notices.error({key:"im-sources",message})} /></Suspense>
      </SettingsPanel>
    </ModalSurface> : null}
    {detailsOpen ? <Suspense fallback={null}><ConversationInformationDialog project={props.project} workspaceDirectory={props.workspaceDirectory}
      onDismiss={() => setDetailsOpen(false)} returnFocus={returnFocus} /></Suspense> : null}
    {schedulesOpen && props.schedules ? <ConversationSchedulesPanel port={props.schedules} scope={props.scope} hostId={props.serverId} threadId={props.threadId} onClose={() => setSchedulesOpen(false)} returnFocus={returnFocus} /> : null}
    {pickerOpen && props.port ? <TaskPicker {...props} port={props.port} onClose={() => setPickerOpen(false)} returnFocus={returnFocus} /> : null}
  </>;
}
