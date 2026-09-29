import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { Bot, LoaderCircle, MessagesSquare, MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import {
  SettingsButton,
  SettingsIconButton,
  SettingsNotice,
  SettingsPanel,
  SettingsSelect,
  SettingsTextInput,
  type ExtensionSettingsViewProps,
} from "@opencraft/extension-react";
import type { AppServerBotConversationService, AppServerBotDirectory, AppServerBotDirectoryEntry } from "@opencraft/bot-conversation-appserver";
import { botConversationResourceUri, botSelectionResourceUri } from "@opencraft/bot-conversation";
import { createConversationKey } from "@opencraft/chat-core";
import type { AppServerBotConfigurationOptions, AppServerBotConversationDescriptor } from "@opencraft/appserver-protocol";
import { ModalSurface } from "./modal/modal-surface";
import {
  botConfigurationControlState,
  botConfigurationHeaderState,
} from "./bot-configuration-controls";
import "../styles/context-menu.scss";
import "../styles/bot-management.scss";
import { connectCloudHermesBotHost, resolveCloudHermesBotHost } from "../runtime/bot-management-host";
import { useWorkbenchPresentationRoot } from "./workbench-presentation-root";

type Directory = Pick<AppServerBotDirectory, "subscribe" | "getSnapshot" | "refresh" | "create" | "update" | "delete">;
type BotMutationAction = { kind: "create"; hostId: string } | { kind: "clone" | "rename" | "delete"; entry: AppServerBotDirectoryEntry };
type Action = BotMutationAction | { kind: "configure"; entry: AppServerBotDirectoryEntry };

function GroupOperation({ hostId, entries, conversations, onClose, onCreated }: {
  hostId: string; entries: readonly AppServerBotDirectoryEntry[]; conversations: AppServerBotConversationService;
  onClose(): void; onCreated(conversationId: string): void;
}) {
  const portalContainer = useWorkbenchPresentationRoot();
  const formId = useId();
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const available = entries.filter(entry => entry.availability === "available" && entry.bot.status === "available");
  const toggle = (botId: string) => setSelected(previous => {
    const next = new Set(previous);
    if (next.has(botId)) next.delete(botId); else if (next.size < 6) next.add(botId);
    return next;
  });
  const submit = async () => {
    if (busy || selected.size < 2) return;
    setBusy(true); setError(null);
    try {
      const result = await conversations.createConversation(hostId, {
        clientRequestId: crypto.randomUUID(),
        topology: "group",
        ...(title.trim() ? { title: title.trim() } : {}),
        participantIds: [...selected].map(botId => `bot:${botId}`),
      });
      onCreated(result.conversation.conversationId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };
  return <ModalSurface portalContainer={portalContainer} label="新建群聊" size="compact" appearance="utility" dismissOnOutsidePress={!busy} onDismiss={onClose}>
    <SettingsPanel title="新建群聊" footer={<><SettingsButton disabled={busy} onClick={onClose}>取消</SettingsButton>
      <SettingsButton variant="primary" type="submit" form={formId} disabled={busy || selected.size < 2}>{busy ? "创建中…" : "创建"}</SettingsButton></>}>
      <form id={formId} className="bot-management__group-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <label htmlFor={`${formId}-title`}>群聊名称</label>
        <SettingsTextInput id={`${formId}-title`} value={title} disabled={busy} placeholder="可选" onChange={event => setTitle(event.target.value)} />
        <fieldset disabled={busy}><legend>选择 2–6 个 Bots</legend>
          {available.map(entry => <label key={entry.bot.botId} className="bot-management__group-member">
            <input type="checkbox" checked={selected.has(entry.bot.botId)} disabled={!selected.has(entry.bot.botId) && selected.size >= 6}
              onChange={() => toggle(entry.bot.botId)} />
            <Bot aria-hidden="true" size={16} /><span>{entry.bot.name}</span>
          </label>)}
        </fieldset>
        {available.length < 2 && <p className="settings-control-notice">至少需要两个可用 Bot。</p>}
        {error && <p role="alert" className="settings-control-notice">{error}</p>}
      </form>
    </SettingsPanel>
  </ModalSurface>;
}

function BotOperation({ action, directory, onClose, onComplete }: {
  action: BotMutationAction; directory: Directory; onClose(): void; onComplete(): void;
}) {
  const portalContainer = useWorkbenchPresentationRoot();
  const entry = action.kind === "create" ? null : action.entry;
  const hostId = action.kind === "create" ? action.hostId : action.entry.hostId;
  const [name, setName] = useState(action.kind === "rename" ? entry!.bot.name : action.kind === "clone" ? `${entry!.bot.name} 副本` : "");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const mounted = useRef(true), submitting = useRef(false), formId = useId();
  const request = useRef<{ name: string; id: string } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const title = { create: "新建 Bot", clone: "克隆 Bot", rename: "重命名 Bot", delete: "删除 Bot" }[action.kind];
  const validName = [...name.trim()].length > 0 && [...name.trim()].length <= 60;
  const run = async () => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError(null);
    try {
      if (action.kind === "delete") await directory.delete(hostId, { botId: entry!.bot.botId, expectedRevision: entry!.bot.revision });
      else if (action.kind === "rename") await directory.update(hostId, { botId: entry!.bot.botId, expectedRevision: entry!.bot.revision, patch: { name: name.trim() } });
      else {
        // A retry of this form reuses its intent identity, including after a timeout.
        if (request.current?.name !== name.trim()) request.current = { name: name.trim(), id: crypto.randomUUID() };
        await directory.create(hostId, { clientRequestId: request.current.id, name: name.trim(),
          ...(action.kind === "clone" ? { templateId: entry!.bot.botId } : {}) });
      }
      if (mounted.current) onComplete();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { submitting.current = false; if (mounted.current) setBusy(false); }
  };
  if (action.kind === "delete") return <AlertDialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <AlertDialog.Portal container={portalContainer ?? undefined}><AlertDialog.Overlay className="modal-surface__scrim" data-layer="confirmation" data-appearance="utility" />
      <AlertDialog.Content className="modal-surface" data-layer="confirmation" data-appearance="utility" data-size="compact">
        <SettingsPanel title={<AlertDialog.Title asChild><span>{title}</span></AlertDialog.Title>} footer={<>
          <AlertDialog.Cancel asChild><SettingsButton disabled={busy}>取消</SettingsButton></AlertDialog.Cancel>
          <SettingsButton variant="primary" disabled={busy} onClick={() => void run()}>{busy ? "删除中…" : "删除"}</SettingsButton>
        </>}>
          <AlertDialog.Description>删除“{entry!.bot.name}”及其配置和会话数据？此操作无法撤销。</AlertDialog.Description>
          {error && <p role="alert" className="settings-control-notice">{error}</p>}
        </SettingsPanel>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
  return <ModalSurface portalContainer={portalContainer} label={title} size="compact" appearance="utility" dismissOnOutsidePress={!busy}
    onDismiss={() => { if (!busy) onClose(); }}>
    <SettingsPanel title={title} footer={<><SettingsButton disabled={busy} onClick={onClose}>取消</SettingsButton>
      <SettingsButton variant="primary" type="submit" form={formId} disabled={busy || !validName}>{busy ? "处理中…" : action.kind === "rename" ? "保存" : "创建"}</SettingsButton></>}>
      <form id={formId} onSubmit={event => { event.preventDefault(); if (validName) void run(); }}>
        {action.kind === "clone" && <p>从“{entry!.bot.name}”创建独立副本。</p>}
        <label htmlFor={`${formId}-name`}>Bot 名称</label>
        <SettingsTextInput id={`${formId}-name`} autoFocus value={name} disabled={busy} aria-invalid={!validName && name.length > 0}
          onChange={event => setName(event.target.value)} />
        {[...name.trim()].length > 60 && <p role="alert">名称最多 60 个字符。</p>}
        {error && <p role="alert" className="settings-control-notice">{error}</p>}
      </form>
    </SettingsPanel>
  </ModalSurface>;
}

function BotConfigurationOperation({ entry, conversations, directory, onClose, onComplete }: {
  entry: AppServerBotDirectoryEntry;
  conversations: AppServerBotConversationService;
  directory: Directory;
  onClose(): void;
  onComplete(): void;
}) {
  const portalContainer = useWorkbenchPresentationRoot();
  const formId = useId();
  const [options, setOptions] = useState<AppServerBotConfigurationOptions | null>(null);
  const [provider, setProvider] = useState(entry.bot.model?.provider ?? "");
  const [model, setModel] = useState(entry.bot.model?.model ?? "");
  const [configurationLoading, setConfigurationLoading] = useState(true);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [optionsAttempt, setOptionsAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    setConfigurationLoading(true);
    setOptionsLoading(true);
    setOptionsError(null);
    void conversations.readBotConfiguration(entry.hostId, entry.bot.botId).then(({ configuration: next }) => {
      if (!mounted.current) return;
      if (next.model !== null) {
        setProvider(next.model.provider);
        setModel(next.model.model);
      }
      setConfigurationLoading(false);
    }).catch(cause => {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setConfigurationLoading(false);
    });
    void conversations.readBotConfigurationOptions(entry.hostId, entry.bot.botId).then(next => {
      if (!mounted.current) return;
      setOptions(next);
      const fallback = next.providers.find(candidate => candidate.authenticated);
      if (fallback !== undefined) {
        setProvider(previous => previous || fallback.provider);
        setModel(previous => previous || fallback.models[0] || "");
      }
      setOptionsLoading(false);
    }).catch(cause => {
      if (!mounted.current) return;
      setOptionsError(cause instanceof Error ? cause.message : String(cause));
      setOptionsLoading(false);
    });
    return () => { mounted.current = false; };
  }, [conversations, entry.bot.botId, entry.hostId, optionsAttempt]);
  const providerOptions = options?.providers ?? [];
  const selectedProvider = providerOptions.find(candidate => candidate.provider === provider);
  const displayedProviderOptions = selectedProvider || provider === ""
    ? providerOptions
    : [...providerOptions, { provider, name: `${provider}（当前）`, models: model ? [model] : [], authenticated: true }];
  const providerModels = selectedProvider?.models ?? (provider === "" || model === "" ? [] : [model]);
  const displayedModelOptions = model === "" || providerModels.includes(model)
    ? providerModels
    : [model, ...providerModels];
  const catalogHasProvider = providerOptions.length > 0;
  const catalogHasModels = selectedProvider !== undefined && displayedModelOptions.length > 0;
  const valid = provider.trim() !== "" && model.trim() !== "";
  const controls = botConfigurationControlState({
    optionsLoading,
    busy,
    provider,
    model,
    hasProviderCatalog: catalogHasProvider,
    hasModelCatalog: catalogHasModels,
  });
  const headerState = botConfigurationHeaderState({
    configurationLoading,
    optionsLoading,
    optionsError,
  });
  const changeProvider = (next: string) => {
    setProvider(next);
    setModel(options?.providers.find(candidate => candidate.provider === next)?.models[0] ?? "");
    setConfirmation(null);
  };
  const changeModel = (next: string) => { setModel(next); setConfirmation(null); };
  const retryOptions = () => {
    if (optionsLoading || busy) return;
    setOptionsAttempt(attempt => attempt + 1);
  };
  const save = async (confirmed: boolean) => {
    if (busy || !valid) return;
    setBusy(true); setError(null);
    try {
      const result = await conversations.updateBotConfiguration(entry.hostId, {
        botId: entry.bot.botId,
        expectedRevision: entry.bot.revision,
        model: { provider: provider.trim(), model: model.trim() },
        ...(confirmed ? { confirmExpensiveModel: true } : {}),
      });
      if (!result.applied && result.confirmationRequired) {
        if (mounted.current) setConfirmation(result.confirmationRequired.message);
        return;
      }
      await directory.refresh(entry.hostId);
      if (mounted.current) onComplete();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return <ModalSurface portalContainer={portalContainer} label={`${entry.bot.name} 模型设置`} size="compact" appearance="utility"
    dismissOnOutsidePress={!busy} onDismiss={() => { if (!busy) onClose(); }}>
    <SettingsPanel title="模型设置" actions={<span className="bot-management__configuration-status">
      {headerState === "loading" ? <LoaderCircle aria-label="正在读取模型配置" className="is-spinning" size={16} />
        : headerState === "retry" ? <SettingsIconButton label="重试读取可用模型" onClick={retryOptions}><RefreshCw size={16} /></SettingsIconButton>
          : null}
    </span>} footer={<><SettingsButton disabled={busy} onClick={onClose}>取消</SettingsButton>
      <SettingsButton variant="primary" type="submit" form={formId} disabled={controls.saveDisabled}>
        {busy ? "保存中…" : confirmation ? "确认并保存" : "保存"}
      </SettingsButton></>}>
      <form id={formId} onSubmit={event => { event.preventDefault(); void save(confirmation !== null); }}>
        <p>设置“{entry.bot.name}”后续会话与群聊执行使用的默认模型。</p>
        <label htmlFor={`${formId}-provider`}>模型服务</label>
        {controls.providerControl === "select" ? <SettingsSelect id={`${formId}-provider`} value={provider} disabled={controls.inputsDisabled}
          onChange={event => changeProvider(event.target.value)}>
          <option value="" disabled>选择模型服务</option>
          {displayedProviderOptions.map(option => <option key={option.provider} value={option.provider}>{option.name}</option>)}
        </SettingsSelect> : <SettingsTextInput id={`${formId}-provider`} value={provider} disabled={controls.inputsDisabled}
          placeholder="provider" onChange={event => changeProvider(event.target.value)} />}
        <label htmlFor={`${formId}-model`}>模型</label>
        {controls.modelControl === "select" ? <SettingsSelect id={`${formId}-model`} value={model} disabled={controls.inputsDisabled}
          onChange={event => changeModel(event.target.value)}>
          <option value="" disabled>选择模型</option>
          {displayedModelOptions.map(option => <option key={option} value={option}>{option}</option>)}
        </SettingsSelect> : <SettingsTextInput id={`${formId}-model`} value={model} disabled={controls.inputsDisabled}
          placeholder="model" onChange={event => changeModel(event.target.value)} />}
        {selectedProvider?.warning ? <SettingsNotice>{selectedProvider.warning}</SettingsNotice> : null}
        {confirmation ? <SettingsNotice>{confirmation}</SettingsNotice> : null}
        {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
      </form>
    </SettingsPanel>
  </ModalSurface>;
}

export function createBotManagementView(directory: Directory, conversations: AppServerBotConversationService,
  connect: (hostId: string) => Promise<void>) {
  return function BotManagement({ host, activation }: ExtensionSettingsViewProps) {
    const portalContainer = useWorkbenchPresentationRoot();
    const snapshot = useSyncExternalStore(directory.subscribe, directory.getSnapshot, directory.getSnapshot);
    const [action, setAction] = useState<Action | null>(null);
    const [creatingGroup, setCreatingGroup] = useState(false);
    const [groups, setGroups] = useState<readonly AppServerBotConversationDescriptor[]>([]);
    const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const cloudProfiles = host.profiles.filter(profile => profile.enabled && profile.providerId === "lightvela.hermes");
    const hostId = resolveCloudHermesBotHost(host.profiles, snapshot.hosts) ?? "";
    const state = snapshot.hosts.find(candidate => candidate.hostId === hostId);
    const stateReason = useRef<string | null>(null);
    stateReason.current = state?.error ?? null;
    const entries = snapshot.entries.filter(entry => entry.hostId === hostId);
    const canManage = state?.phase === "ready" && state.canManageBots;
    const canConfigure = state?.phase === "ready"
      && conversations.capability(hostId)?.features.configuration === true;
    const canCreateGroup = state?.phase === "ready"
      && conversations.capability(hostId)?.topologies.includes("group") === true
      && entries.filter(entry => entry.availability === "available" && entry.bot.status === "available").length >= 2;
    const refreshGroups = async () => {
      if (!hostId || conversations.capability(hostId)?.topologies.includes("group") !== true) {
        if (mounted.current) setGroups([]);
        return;
      }
      const page = await conversations.listConversations(hostId, { limit: 200, archived: false });
      if (mounted.current) setGroups(page.data.filter(conversation => conversation.topology === "group"));
    };
    const attemptedHost = useRef<string | null>(null);
    const handledActivation = useRef<string | null>(null);
    useEffect(() => {
      if (activation.resourceUri?.startsWith("create:") && handledActivation.current !== activation.resourceUri && canManage) {
        handledActivation.current = activation.resourceUri;
        setAction({ kind: "create", hostId });
      }
    }, [activation.resourceUri, canManage, hostId]);
    const refresh = async () => {
      if (busy || !hostId) return;
      setBusy(true); setError(null);
      try {
        await connectCloudHermesBotHost((async () => {
          await connect(hostId);
          await directory.refresh(hostId);
          await refreshGroups();
        })(), 15_000, () => stateReason.current ?? "正在读取 Bot 列表…");
      }
      catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (mounted.current) setBusy(false); }
    };
    useEffect(() => {
      if (!hostId || attemptedHost.current === hostId) return;
      attemptedHost.current = hostId;
      void refresh();
    }, [hostId]);
    useEffect(() => {
      if (state?.phase === "ready") void refreshGroups().catch(() => undefined);
    }, [hostId, state?.phase]);
    const actions = (entry: AppServerBotDirectoryEntry) => [
      { kind: "configure" as const, label: "模型设置", enabled: canConfigure && entry.availability === "available" },
      { kind: "clone" as const, label: "克隆", enabled: canManage && entry.bot.management?.clone === true },
      { kind: "rename" as const, label: "重命名", enabled: canManage && entry.bot.management?.rename === true },
      { kind: "delete" as const, label: "删除", enabled: canManage && entry.bot.management?.delete === true },
    ];
    return <section className="bot-management" aria-label="Bot 管理">
      <SettingsPanel title="Bots" actions={<><SettingsIconButton label="刷新 Bot" disabled={busy || !hostId} onClick={() => void refresh()}><RefreshCw size={16} /></SettingsIconButton>
        <SettingsButton disabled={!canCreateGroup || busy} onClick={() => setCreatingGroup(true)}><MessagesSquare aria-hidden="true" size={16} />新建群聊</SettingsButton>
        <SettingsButton disabled={!canManage || busy} onClick={() => setAction({ kind: "create", hostId })}><Plus aria-hidden="true" size={16} />新建 Bot</SettingsButton></>}>
        {(error || (!busy && state?.phase !== "unsupported" && state?.error)) && <p role="alert" className="settings-control-notice">{error || state?.error}</p>}
        {busy && !entries.length ? <div className="bot-management__loading" role="status">
          <span className="bot-management__loading-line" />
          <p>{state?.error || "正在读取 Bots…"}</p>
        </div> : null}
        {!entries.length && !busy && !error && <div className="bot-management__empty"><Bot aria-hidden="true" size={28} /><p>{
          cloudProfiles.length === 0 ? "登录并创建云端 Agent 后，可在此管理 Bots。"
            : cloudProfiles.length > 1 && !hostId ? "当前账号存在多个云端 Agent，暂时无法确定 Bot 所属实例。"
              : state?.phase === "unsupported" ? "当前云端 Agent 不支持 Bot 管理。"
                : canManage ? "还没有 Bot，创建一个开始使用。" : "暂时无法读取 Bot 列表，请刷新重试。"
        }</p></div>}
        <ul className="bot-management__list">{entries.map(entry => <li key={`${entry.hostId}:${entry.bot.botId}`}>
          <ContextMenu.Root><ContextMenu.Trigger asChild><div className="bot-management__row">
            <SettingsButton variant="quiet" disabled={entry.availability !== "available"} onClick={() => host.openView("vela.bot-chat.view", botSelectionResourceUri(entry.hostId, entry.bot.botId))}>
              <Bot aria-hidden="true" size={18} /><span>{entry.bot.name}</span>
            </SettingsButton>
            <DropdownMenu.Root><DropdownMenu.Trigger asChild><SettingsIconButton label={`${entry.bot.name} 的操作`}><MoreHorizontal size={18} /></SettingsIconButton></DropdownMenu.Trigger>
              <DropdownMenu.Portal container={portalContainer}><DropdownMenu.Content className="workbench-context-menu" align="end" sideOffset={4}>
                {actions(entry).map(item => <DropdownMenu.Item key={item.kind} disabled={!item.enabled} onSelect={() => setAction({ kind: item.kind, entry })}>{item.label}</DropdownMenu.Item>)}
              </DropdownMenu.Content></DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div></ContextMenu.Trigger><ContextMenu.Portal container={portalContainer}><ContextMenu.Content className="workbench-context-menu">
            {actions(entry).map(item => <ContextMenu.Item key={item.kind} disabled={!item.enabled} onSelect={() => setAction({ kind: item.kind, entry })}>{item.label}</ContextMenu.Item>)}
          </ContextMenu.Content></ContextMenu.Portal></ContextMenu.Root>
        </li>)}</ul>
        {groups.length > 0 && <div className="bot-management__groups">
          <h3>群聊</h3>
          <ul className="bot-management__list">{groups.map(group => <li key={group.conversationId}>
            <div className="bot-management__row"><SettingsButton variant="quiet" onClick={() =>
              host.openView("vela.bot-chat.view", botConversationResourceUri(createConversationKey(hostId, group.conversationId)))}>
              <MessagesSquare aria-hidden="true" size={18} /><span>{group.title}</span>
            </SettingsButton></div>
          </li>)}</ul>
        </div>}
      </SettingsPanel>
      {creatingGroup && <GroupOperation hostId={hostId} entries={entries} conversations={conversations}
        onClose={() => setCreatingGroup(false)} onCreated={conversationId => {
          setCreatingGroup(false);
          void refreshGroups().catch(() => undefined);
          host.openView("vela.bot-chat.view", botConversationResourceUri(createConversationKey(hostId, conversationId)));
        }} />}
      {action?.kind === "configure" ? <BotConfigurationOperation entry={action.entry} conversations={conversations}
        directory={directory} onClose={() => setAction(null)} onComplete={() => setAction(null)} /> : null}
      {action && action.kind !== "configure" ? <BotOperation action={action} directory={directory}
        onClose={() => setAction(null)} onComplete={() => setAction(null)} /> : null}
    </section>;
  };
}
