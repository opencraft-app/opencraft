import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Info, MoreHorizontal, Pencil, Pin, PinOff } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TASKS, type TaskDetail, type TasksRequestPort } from "@opencraft/appserver-protocol";
import { useIntl } from "@opencraft/i18n/react";
import {
  SettingsButton, SettingsGroup, SettingsListItem, SettingsNotice,
  SettingsPanel, SettingsSwitch, SettingsTextInput,
} from "@opencraft/extension-react";
import { ModalSurface } from "./modal";
import { useWorkbenchPresentationRoot } from "./workbench-presentation-root";
import "../styles/context-menu.scss";

interface Props {
  readonly port?: TasksRequestPort;
  readonly scope: string;
  readonly serverId: string;
  readonly threadId: string;
  readonly verifyConversation: () => Promise<void>;
  readonly onOpenTasks: () => void;
  readonly title?: string;
  readonly pinned?: boolean;
  readonly onRename?: (title: string) => Promise<void>;
  readonly onSetPinned?: (pinned: boolean) => Promise<void>;
  readonly project?: string;
  readonly workspaceDirectory?: string;
}

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
  const mutation = useMutation({
    mutationFn: async (attach: boolean) => {
      if (attach) await target.verifyConversation();
      return target.port.request(attach ? TASKS.attach : TASKS.detach, {
        id: task.id, expectedRevision: task.revision, serverId: target.serverId, threadId: target.threadId,
      });
    },
    // The backend owns the result, including commits whose acknowledgement was lost.
    // Never replay a mutation or optimistically replace another task's revision.
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
  return <SettingsListItem
    label={task.title}
    aria-busy={mutation.isPending || undefined}
    error={mutation.isError ? intl.formatMessage({ id: "tasks.relation.saveError", defaultMessage: "Could not confirm the change. Review the current selection and retry." }) : undefined}
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
  const title = intl.formatMessage({ id: "tasks.relation.title", defaultMessage: "Task membership" });
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
  const portalContainer = useWorkbenchPresentationRoot();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const modalHandoff = useRef(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [name, setName] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const formId = useId();
  const rename = useMutation({
    mutationFn: (title: string) => props.onRename!(title),
    onSuccess: () => setRenameOpen(false),
  });
  const pin = useMutation({
    mutationFn: (value: boolean) => props.onSetPinned!(value),
    onSuccess: () => setMenuOpen(false),
  });
  const label = intl.formatMessage({ id: "tasks.relation.actions", defaultMessage: "Conversation actions" });
  return <>
    <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenu.Trigger asChild>
        <button ref={trigger} type="button" className="chrome-button" aria-label={label} title={label}>
          <MoreHorizontal size={16} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={portalContainer}>
        <DropdownMenu.Content className="workbench-context-menu" align="end" sideOffset={4}
          onCloseAutoFocus={event => {
            if (modalHandoff.current) { event.preventDefault(); modalHandoff.current = false; }
          }}>
          {props.onRename ? <DropdownMenu.Item disabled={pin.isPending} onSelect={() => {
            modalHandoff.current = true; rename.reset(); setName(props.title ?? ""); setRenameOpen(true);
          }}><Pencil size={16} aria-hidden="true" />{intl.formatMessage({ id: "common.rename", defaultMessage: "Rename" })}</DropdownMenu.Item> : null}
          {props.onSetPinned ? <DropdownMenu.Item disabled={pin.isPending} onSelect={event => {
            event.preventDefault(); pin.mutate(props.pinned !== true);
          }}>{props.pinned ? <PinOff size={16} aria-hidden="true" /> : <Pin size={16} aria-hidden="true" />}
            {props.pinned ? intl.formatMessage({ id: "chat.unpin", defaultMessage: "Unpin" }) : intl.formatMessage({ id: "chat.pin", defaultMessage: "Pin" })}
          </DropdownMenu.Item> : null}
          {pin.isError ? <SettingsNotice tone="error" role="alert">{intl.formatMessage({ id: "chat.pin.failed", defaultMessage: "Could not update pin. Try again." })}</SettingsNotice> : null}
          {props.port && (props.onRename || props.onSetPinned) ? <DropdownMenu.Separator /> : null}
          {props.port ? <DropdownMenu.Item disabled={pin.isPending} onSelect={() => { modalHandoff.current = true; setPickerOpen(true); }}>
            {intl.formatMessage({ id: "tasks.relation.title", defaultMessage: "Task membership" })}
          </DropdownMenu.Item> : null}
          {props.project || props.workspaceDirectory ? <DropdownMenu.Item onSelect={() => {
            modalHandoff.current = true; setDetailsOpen(true);
          }}><Info size={16} aria-hidden="true" />{intl.formatMessage({ id: "chat.details.title", defaultMessage: "Conversation details" })}</DropdownMenu.Item> : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    {renameOpen ? <ModalSurface label={intl.formatMessage({ id: "chat.rename.title", defaultMessage: "Rename conversation" })}
      size="compact" appearance="utility" onDismiss={() => { if (!rename.isPending) setRenameOpen(false); }} returnFocus={() => trigger.current}>
      <SettingsPanel title={intl.formatMessage({ id: "chat.rename.title", defaultMessage: "Rename conversation" })} footer={<>
        <SettingsButton disabled={rename.isPending} onClick={() => setRenameOpen(false)}>{intl.formatMessage({ id: "common.cancel", defaultMessage: "Cancel" })}</SettingsButton>
        <SettingsButton form={formId} type="submit" variant="primary" disabled={rename.isPending || !name.trim()}>{intl.formatMessage({ id: "common.save", defaultMessage: "Save" })}</SettingsButton>
      </>}>
        <form id={formId} onSubmit={event => { event.preventDefault(); if (!rename.isPending && name.trim()) rename.mutate(name.trim()); }}>
          <SettingsTextInput autoFocus aria-label={intl.formatMessage({ id: "chat.rename.name", defaultMessage: "Conversation name" })}
            maxLength={60} value={name} disabled={rename.isPending} onChange={event => setName(event.target.value)} />
          {rename.isError ? <SettingsNotice tone="error" role="alert">{intl.formatMessage({ id: "chat.rename.failed", defaultMessage: "Could not rename the conversation. Try again." })}</SettingsNotice> : null}
        </form>
      </SettingsPanel>
    </ModalSurface> : null}
    {detailsOpen ? <ModalSurface label={intl.formatMessage({ id: "chat.details.title", defaultMessage: "Conversation details" })}
      size="compact" appearance="utility" onDismiss={() => setDetailsOpen(false)} returnFocus={() => trigger.current}>
      <SettingsPanel title={intl.formatMessage({ id: "chat.details.title", defaultMessage: "Conversation details" })}
        footer={<SettingsButton onClick={() => setDetailsOpen(false)}>{intl.formatMessage({ id: "common.close", defaultMessage: "Close" })}</SettingsButton>}>
        {props.project ? <SettingsListItem label={intl.formatMessage({ id: "chat.details.project", defaultMessage: "Project" })} description={props.project} /> : null}
        {props.workspaceDirectory ? <SettingsListItem className="conversation-details__directory" label={intl.formatMessage({ id: "chat.details.directory", defaultMessage: "Working directory" })} description={props.workspaceDirectory} /> : null}
      </SettingsPanel>
    </ModalSurface> : null}
    {pickerOpen && props.port ? <TaskPicker {...props} port={props.port} onClose={() => setPickerOpen(false)} returnFocus={() => trigger.current} /> : null}
  </>;
}
