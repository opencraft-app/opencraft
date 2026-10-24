import { ChevronDownIcon as ChevronDown, ChevronRightIcon as ChevronRight, ChevronUpIcon as ChevronUp, MoreIcon as Ellipsis, LoadingRingIcon as LoaderCircle, AddIcon as Plus, RefreshIcon as RefreshCw, SearchIcon as Search } from "@opencraft/design-system-web/action-icons";
import * as Popover from "@radix-ui/react-popover";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { EyeIcon as Eye, EyeOffIcon as EyeOff } from "@opencraft/design-system-web/action-icons";
import { useEffect, useState, useSyncExternalStore } from "react";
import { SettingsButton, SettingsIconButton, SettingsNotice, SettingsSelect, SettingsSwitch, SettingsTextInput, type ExtensionSettingsViewProps } from "@opencraft/extension-react";
import type { RuntimeProviderView, RuntimeModelView } from "@opencraft/appserver-protocol";
import { modelBaseUrlError } from "@opencraft/appserver-protocol";
import { ModelServicesController } from "./controller";
import { BrandMark } from "./brand-mark";

const REASONING_LEVELS = [
  ["minimal", "最少"], ["low", "低"], ["medium", "中"],
  ["high", "高"], ["xhigh", "很高"], ["max", "最高"],
] as const;

function MoreActions({ label, children }: { label: string; children: React.ReactNode }) {
  return <Popover.Root><Popover.Trigger asChild><SettingsIconButton label={label}><Ellipsis size={16} /></SettingsIconButton></Popover.Trigger>
    <Popover.Portal><Popover.Content className="model-services-actions" align="end" sideOffset={6} collisionPadding={12} aria-label={label}>{children}</Popover.Content></Popover.Portal>
  </Popover.Root>;
}

function ProviderDefaultAction({ provider, controller, disabled }: { provider: RuntimeProviderView; controller: ModelServicesController; disabled: boolean }) {
  if (provider.configuration?.modelType === "asr") return null;
  const snapshot = controller.service.getSnapshot();
  const availableModels = snapshot.models?.groups
    .find(group => group.id === provider.provider)?.models
    .filter(model => model.enabled !== false) ?? [];
  const defaults = snapshot.settings?.namespaces
    .find(entry => entry.ns === "agent-default-model")?.value as { provider?: string; model?: string } | undefined;
  const currentModel = defaults?.provider === provider.provider ? defaults.model : undefined;
  const unavailable = disabled || !provider.active || availableModels.length === 0;
  if (availableModels.length <= 1) {
    const model = availableModels[0];
    return <ContextMenu.Item disabled={unavailable || currentModel === model?.id} onSelect={() => { if (model) void controller.setDefault(provider, model.id); }}>设为默认</ContextMenu.Item>;
  }
  return <ContextMenu.Sub>
    <ContextMenu.SubTrigger className="model-services-context__sub-trigger" disabled={unavailable}>
      <span>设为默认</span><ChevronRight size={14} aria-hidden="true" />
    </ContextMenu.SubTrigger>
    <ContextMenu.Portal>
      <ContextMenu.SubContent className="model-services-context" sideOffset={4} collisionPadding={12}>
        {availableModels.map(model => <ContextMenu.Item
          key={model.id}
          aria-label={`设为默认：${model.id}`}
          disabled={currentModel === model.id}
          onSelect={() => { void controller.setDefault(provider, model.id); }}
        >
          <span>{model.name}</span>{currentModel === model.id ? <span className="model-services-context__current">当前</span> : null}
        </ContextMenu.Item>)}
      </ContextMenu.SubContent>
    </ContextMenu.Portal>
  </ContextMenu.Sub>;
}

function ProviderRow({ provider, controller }: { provider: RuntimeProviderView; controller: ModelServicesController }) {
  const [action, setAction] = useState<{ kind: "rename" | "delete"; revision: number } | null>(null);
  const [name, setName] = useState(""), [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false);
  const custom = provider.declared && provider.settingsNs === "llm-pi-ai";
  const disabled = controller.busy || controller.service.getSnapshot().settings?.writable !== true || controller.draft(provider).dirty;
  const canToggle = provider.configuration?.canToggle === true;
  const defaults = controller.service.getSnapshot().settings?.namespaces.find(entry => entry.ns === "agent-default-model")?.value as {provider?: string} | undefined;
  const defaultProtected = provider.enabled && defaults?.provider === provider.provider;
  const row = <div className="model-services__provider-row" data-selected={provider.provider === controller.selected}>
    <button className="model-services__provider" type="button" aria-pressed={provider.provider === controller.selected} onClick={() => controller.select(provider.provider)}><BrandMark kind="provider" id={provider.provider} size={22} /><span>{provider.displayName}</span></button>
    <SettingsSwitch label={`启用提供商：${provider.displayName}`} checked={provider.enabled === true}
      title={defaultProtected ? "请先选择其他提供商的默认模型" : !canToggle ? "由运行时管理" : undefined}
      disabled={!canToggle || disabled || defaultProtected || (!provider.enabled && !provider.configured)}
      onCheckedChange={value => { void controller.toggle(provider, value); }} />
  </div>;
  const begin = (kind: "rename" | "delete") => { setName(provider.displayName); setError(null); setAction({kind, revision: controller.revision(provider)}); };
  const submit = async () => {
    if (!action || saving) return;
    setSaving(true); setError(null);
    try {
      if (action.kind === "rename") await controller.renameProvider(provider, name, action.revision);
      else await controller.deleteProvider(provider, action.revision);
      if (controller.error) setError(controller.error); else setAction(null);
    } finally { setSaving(false); }
  };
  return <><ContextMenu.Root><ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger><ContextMenu.Portal>
    <ContextMenu.Content className="model-services-context" onCloseAutoFocus={event => { if (action) event.preventDefault(); }}>
      <ProviderDefaultAction provider={provider} controller={controller} disabled={disabled} />
      {custom ? <ContextMenu.Separator className="model-services-context__separator" /> : null}
      {custom ? <><ContextMenu.Item disabled={disabled} onSelect={() => begin("rename")}>重命名</ContextMenu.Item>
      <ContextMenu.Item disabled={disabled} onSelect={() => begin("delete")}>删除</ContextMenu.Item></> : null}
      {controller.draft(provider).dirty ? <small>请先保存或取消配置修改</small> : null}
    </ContextMenu.Content>
  </ContextMenu.Portal></ContextMenu.Root>
  <AlertDialog.Root open={action !== null} onOpenChange={open => { if (!open && !saving) setAction(null); }}><AlertDialog.Portal>
    <AlertDialog.Overlay className="model-services-dialog-overlay" />
    <AlertDialog.Content className="model-services-dialog" onEscapeKeyDown={event => { if (saving) event.preventDefault(); }}>
      <AlertDialog.Title>{action?.kind === "rename" ? "重命名提供商" : "删除提供商"}</AlertDialog.Title>
      <AlertDialog.Description>{action?.kind === "rename" ? "仅修改显示名称，不改变连接 ID、模型或凭据。" : `删除“${provider.displayName}”及其模型配置？凭据会保留，已有会话的记录不会删除，但继续使用此连接可能失败。`}</AlertDialog.Description>
      {action?.kind === "rename" ? <label>提供商名称<SettingsTextInput autoFocus value={name} disabled={saving} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && name.trim()) { event.preventDefault(); void submit(); } }} /></label> : null}
      {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
      <footer><AlertDialog.Cancel asChild><SettingsButton disabled={saving}>取消</SettingsButton></AlertDialog.Cancel>
        <SettingsButton variant={action?.kind === "delete" ? "danger" : "primary"} disabled={saving || controller.busy || (action?.kind === "rename" && !name.trim())} onClick={() => { void submit(); }}>{saving ? "处理中…" : action?.kind === "rename" ? "保存名称" : "确认删除"}</SettingsButton>
      </footer>
    </AlertDialog.Content>
  </AlertDialog.Portal></AlertDialog.Root></>;
}

function CreatePopover({ label, disabled, allowSpeech = false, onCreate }: { label: string; disabled: boolean; allowSpeech?: boolean; onCreate(name: string, type: "chat" | "asr"): Promise<void> }) {
  const [open, setOpen] = useState(false), [name, setName] = useState(""), [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false);
  const [type, setType] = useState<"chat" | "asr">("chat");
  return <Popover.Root open={open} onOpenChange={value => { if (!saving) { setOpen(value); setName(""); setError(null); } }}>
    <Popover.Trigger asChild><SettingsIconButton label={label} disabled={disabled}><Plus size={16} /></SettingsIconButton></Popover.Trigger>
    <Popover.Portal><Popover.Content className="model-services-create" align="end" sideOffset={6} collisionPadding={12} aria-label={label}>
      <form onSubmit={event => { event.preventDefault(); if (!name.trim() || saving) return; setSaving(true); setError(null);
        void onCreate(name.trim(), type).then(() => setOpen(false)).catch(cause => setError(cause instanceof Error ? cause.message : "创建失败")).finally(() => setSaving(false)); }}>
        {allowSpeech ? <label>用途<SettingsSelect aria-label="提供商用途" value={type} disabled={saving} onChange={event => setType(event.target.value as "chat" | "asr")}><option value="chat">聊天</option><option value="asr">混元语音转写</option></SettingsSelect></label> : null}
        <label>{label}<SettingsTextInput value={name} disabled={saving} placeholder={label === "添加模型" ? "模型 ID" : "提供商名称"} onChange={event => setName(event.target.value)} required /></label>
        {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
        <div><Popover.Close asChild><SettingsButton disabled={saving}>取消</SettingsButton></Popover.Close><SettingsButton variant="primary" type="submit" disabled={saving || !name.trim()}>{saving ? "添加中…" : "添加"}</SettingsButton></div>
      </form>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}

function ProviderDetail({ controller, provider }: { controller: ModelServicesController; provider: RuntimeProviderView }) {
  const { service } = controller;
  const snapshot = service.getSnapshot();
  const draft = controller.draft(provider);
  const speech = provider.configuration?.modelType === "asr";
  const [showKey, setShowKey] = useState(false);
  const [searchVisible, setSearchVisible] = useState(false);
  const revision = controller.revision(provider);
  const conflict = draft.dirty && revision !== draft.revision;
  const baseUrlIssue = modelBaseUrlError(draft.config.baseURL);
  const editable = snapshot.settings?.writable === true && !controller.busy && !conflict && provider.provider !== "openai-codex";
  useEffect(() => { void controller.inspectCredential(provider); }, [controller, provider.provider, revision]);
  const models = new Map<string, RuntimeModelView>((snapshot.models?.groups.find(group => group.id === provider.provider)?.models ?? []).map(model => [model.id, model]));
  for (const model of draft.config.models) if (!models.has(model.id)) models.set(model.id, { ...model, name: model.name ?? model.id });
  const declarations = new Map(draft.config.models.map(model => [model.id, model]));
  const filtered = [...models.values()].filter(model => `${model.name} ${model.id}`.toLowerCase().includes(controller.modelQuery.toLowerCase()));
  const defaults = snapshot.settings?.namespaces.find(entry => entry.ns === "agent-default-model")?.value as { provider?: string; model?: string } | undefined;
  const isDefault = (model: string) => defaults?.provider === provider.provider && defaults.model === model;
  const testModel = models.has(draft.testModel) ? draft.testModel : models.keys().next().value ?? "";
  const change = (patch: Parameters<ModelServicesController["edit"]>[1], key?: string) => { controller.edit(provider, patch, key); };
  const credentialUnknown = !!draft.config.credentialRef && draft.credentialSet === null;
  const configured = provider.configured && (!draft.config.credentialRef || draft.credentialSet === true);
  const expanded = draft.dirty || (draft.connectionExpanded ?? (!configured && !credentialUnknown));
  const setExpanded = (value: boolean) => { draft.connectionExpanded = value; controller.notify(); };
  const rows = (enabled: boolean) => filtered.filter(model => (model.enabled !== false) === enabled).map(model => {
    const declared = declarations.get(model.id);
    // RuntimeModelView is the final resolved capability (native answer,
    // declaration fallback, then conservative text). Show what Chat will use.
    const supportsImages = model.input?.includes("image") === true;
    const capabilityEditable = !speech && provider.configuration?.modelDeclarations === true && declared !== undefined;
    const capabilityPending = controller.isModelCapabilityPending(provider.provider, model.id);
    const declaredEfforts = declared?.reasoningEfforts;
    const reasoningEditable = capabilityEditable && (declaredEfforts !== undefined || !model.reasoning?.efforts.length);
    const reasoningLabels = REASONING_LEVELS.filter(([level]) =>
      declaredEfforts
        ? Object.hasOwn(declaredEfforts, level)
        : model.reasoning?.efforts.some(effort => effort.id === level)).map(([, label]) => label);
    return <div className="model-services__model" key={model.id}>
    <BrandMark kind="model" id={model.id} size={32} />
    <div><strong>{model.name}</strong>{reasoningLabels.length ? <small>思考档位：{reasoningLabels.join("、")}</small> : null}</div>
    {isDefault(model.id) ? <span className="model-services__kind">默认</span> : null}
    {speech ? <span className="model-services__kind">语音转写</span> : null}
    {!speech ? <MoreActions label={`模型操作：${model.id}`}><small>{model.id}</small>
      {!speech ? <Popover.Close asChild><SettingsButton variant="quiet" aria-label={`设为默认：${model.id}`} disabled={!editable || draft.dirty || !provider.active || model.enabled === false || isDefault(model.id)} onClick={() => { void controller.setDefault(provider, model.id); }}>设为默认</SettingsButton></Popover.Close> : null}
      {capabilityEditable ? <div className="model-services-actions__toggle">
        <span><strong>图片输入</strong><small>允许在聊天时向该模型发送图片附件</small></span>
        {capabilityPending
          ? <span className="model-services-actions__pending" role="status" aria-label="正在保存图片输入设置"><LoaderCircle aria-hidden="true" className="is-spinning" size={15} /></span>
          : <SettingsSwitch label={`允许 ${model.name} 接收图片输入`} checked={supportsImages} disabled={!editable || draft.dirty}
            title={draft.dirty ? "请先保存或取消连接配置的修改" : undefined}
            onCheckedChange={value => { void controller.setModelImageInput(provider, model.id, value); }} />}
      </div> : null}
      {reasoningEditable ? <div className="model-services-actions__reasoning">
        <strong>思考档位</strong>
        <small>{provider.provider === "ollama-cloud" ? "获取模型会补齐已知档位；仅开启实际可用的档位" : "按模型接口实际支持的档位设置"}</small>
        <div className="model-services-actions__reasoning-levels">
          {REASONING_LEVELS.map(([level, label]) => <div key={level}>
            <span>{label}</span>
            <SettingsSwitch label={`${model.name}：${label}思考`}
              checked={declaredEfforts !== false && Object.hasOwn(declaredEfforts ?? {}, level)}
              disabled={!editable || draft.dirty || capabilityPending}
              onCheckedChange={value => { void controller.setModelReasoningLevel(provider, model.id, level, value); }} />
          </div>)}
        </div>
        {capabilityPending ? <small role="status">正在保存模型能力…</small> : null}
      </div> : null}
    </MoreActions> : null}
    <SettingsSwitch label={`启用 ${model.name}`} checked={model.enabled !== false} disabled={!editable || draft.dirty || isDefault(model.id)} onCheckedChange={value => { void controller.changeModel(provider, model.id, value); }} />
  </div>;
  });
  const canTest = !!provider.configuration?.canCheckSaved && !!(draft.config.api ?? provider.configuration.defaultApi);
  return <div className="model-services__detail">
    {conflict ? <SettingsNotice tone="error">配置已在其他位置更新，当前输入保留。<SettingsButton onClick={() => controller.discard(provider)}>放弃输入并刷新</SettingsButton></SettingsNotice> : null}
    <section className="model-services__config" aria-label="提供商配置">
      <header><BrandMark kind="provider" id={provider.provider} size={24} /><h2>{provider.displayName}</h2>
        <MoreActions label="提供商操作">{provider.configuration?.canToggle ? <Popover.Close asChild><SettingsButton variant="quiet" disabled={!editable || (!provider.enabled && !provider.configured) || draft.dirty} onClick={() => { void controller.toggle(provider, !provider.enabled); }}>{provider.enabled ? "停用" : "启用"}</SettingsButton></Popover.Close> : <span className="model-services__managed">运行时管理</span>}</MoreActions>
      </header>
      <div className="model-services__connection-summary"><span>{credentialUnknown ? "凭据状态待确认" : configured ? `连接已配置 · ${provider.enabled ? "已启用" : "未启用"}` : "尚未配置连接"}</span><div>
        {!provider.enabled && provider.configuration?.canToggle ? <SettingsButton className="model-services__enable-fallback" aria-label="启用提供商" disabled={!editable || !configured || draft.dirty} onClick={() => { void controller.toggle(provider, true); }}>启用</SettingsButton> : null}
        <SettingsButton variant="quiet" aria-expanded={expanded} aria-controls="model-service-connection" disabled={draft.dirty} onClick={() => setExpanded(!expanded)}>{expanded ? "收起" : "编辑"}{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</SettingsButton></div></div>
      <div id="model-service-connection" hidden={!expanded}>
      <div className="model-services__row"><div><label htmlFor="model-service-key">API Key</label><p>{draft.credentialSet ? "已保存；留空保持当前密钥" : "填入提供商的 API Key"}</p></div>
        <div className="model-services__secret"><SettingsTextInput id="model-service-key" type={showKey ? "text" : "password"} autoComplete="new-password" spellCheck={false} value={draft.key} disabled={!editable || provider.provider === "openai-codex"} placeholder={draft.credentialSet ? "••••••••••••" : "请输入 API Key"} onChange={event => change({}, event.target.value)} />
          <SettingsIconButton label={showKey ? "隐藏 API Key" : "显示 API Key"} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</SettingsIconButton>
        </div>
      </div>
      <div className="model-services__row"><div><label htmlFor="model-service-url">{speech ? "语音服务地址" : "API 基础地址（Base URL）"}</label><p>{speech ? "使用混元转写服务；保存并启用后，可在语音输入中选择模型。" : "例如 https://example.com/v1，不含 /chat/completions 或 /responses；留空使用默认地址"}</p></div><div><SettingsTextInput id="model-service-url" aria-invalid={!!baseUrlIssue} aria-describedby={baseUrlIssue ? "model-service-url-error" : undefined} value={draft.config.baseURL} disabled={!editable} readOnly={speech} placeholder={provider.configuration?.defaultBaseURL ?? "https://example.com/v1"} onChange={event => change({ baseURL: event.target.value })} />{baseUrlIssue ? <SettingsNotice id="model-service-url-error" tone="error">{baseUrlIssue}</SettingsNotice> : null}</div></div>
      {canTest ? <div className="model-services__row"><div><label htmlFor="model-service-test-model">连通性检查</label><p>{draft.dirty ? "请先保存修改，再检查连接" : "使用已保存的连接和密钥发送文本请求，可能计费"}</p></div>
        <div className="model-services__checker"><SettingsSelect id="model-service-test-model" value={testModel} disabled={!editable} onChange={event => { draft.testModel = event.target.value; draft.probe = null; controller.notify(); }}>
          {!testModel ? <option value="">暂无可用模型</option> : null}{[...models.values()].map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </SettingsSelect><SettingsButton disabled={!editable || !testModel || !!baseUrlIssue || draft.dirty} onClick={() => { void controller.test(provider, testModel); }}>检查</SettingsButton></div>
      </div> : null}
      {provider.configuration?.apis.includes("openai-responses") ? <details className="model-services__advanced">
        <summary className="ui-native-disclosure">高级设置{draft.config.api === "openai-responses" ? <span>协议：Responses API</span> : null}</summary>
        <div className="model-services__row"><div><label>Responses API</label><p>使用 Responses API 发送请求</p></div><div className="model-services__row-end"><SettingsSwitch label="Responses API" checked={draft.config.api === "openai-responses"} disabled={!editable} onCheckedChange={value => change({ api: value ? "openai-responses" : "openai-completions" })} /></div></div>
      </details> : null}
      <div className="model-services__connection-actions"><SettingsButton disabled={controller.busy} onClick={() => { controller.discard(provider); void controller.inspectCredential(provider); }}>取消</SettingsButton><SettingsButton variant="primary" disabled={!editable || !!baseUrlIssue} onClick={() => { void controller.save(provider).then(() => { if (!controller.error && !controller.draft(provider).dirty) { controller.draft(provider).connectionExpanded = false; controller.notify(); } }); }}>保存并收起</SettingsButton></div>
      </div>
    </section>
    {provider.provider === "openai-codex" ? <SettingsNotice>此适配器需要 OAuth 授权，API Key 不能启用它。</SettingsNotice> : null}
    {draft.probe ? <SettingsNotice tone={draft.probe.ok ? "neutral" : "error"}>{draft.probe.ok ? "已收到文本响应；不代表工具、图像或流式能力均已验证。" : draft.probe.error}</SettingsNotice> : null}
    <section className="model-services__models" aria-label="模型列表">
      <div className="model-services__model-heading"><h3>模型</h3><div>{searchVisible || controller.modelQuery ? <SettingsTextInput autoFocus aria-label="搜索模型" placeholder="搜索模型" value={controller.modelQuery} onChange={event => { controller.modelQuery = event.target.value; controller.notify(); }} /> : <SettingsIconButton label="搜索模型" onClick={() => setSearchVisible(true)}><Search size={16} /></SettingsIconButton>}
        {!speech ? <SettingsButton disabled={!editable || draft.dirty} onClick={() => { if (provider.configuration?.modelDeclarations) void controller.fetchModels(provider); else void controller.run(async () => { await service.refresh(); controller.message = "模型目录已刷新"; }); }}><RefreshCw size={14} />{provider.configuration?.modelDeclarations ? "获取模型" : "刷新模型"}</SettingsButton> : null}
        {provider.configuration?.modelDeclarations ? <CreatePopover label="添加模型" disabled={!editable || draft.dirty} onCreate={async name => { await controller.addModel(provider, { id: name }); if (controller.error) throw new Error(controller.error); }} /> : null}
      </div></div>
      {rows(true)}
      {filtered.some(model => model.enabled === false) ? <details><summary className="ui-native-disclosure">未启用模型</summary>{rows(false)}</details> : null}
      {!filtered.length ? <p className="model-services__muted">{models.size ? "没有匹配的模型" : "暂无模型"}</p> : null}
    </section>
    {controller.error ? <SettingsNotice tone="error">{controller.error}</SettingsNotice> : null}
    <p className="model-services__status" role="status">{controller.busy ? "处理中…" : draft.dirty ? "尚有未保存的配置" : controller.message ?? ""}</p>
  </div>;
}

export function createModelServicesView(controller: ModelServicesController) {
  return function ModelServicesView(_props: ExtensionSettingsViewProps) {
    const snapshot = useSyncExternalStore(controller.service.subscribe, controller.service.getSnapshot, controller.service.getSnapshot);
    useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    useEffect(() => { void controller.service.refresh(); }, []);
    const providers = snapshot.providers?.providers ?? [];
    useEffect(() => { if (!controller.initialized && providers.length) controller.select(providers.find(provider => provider.enabled)?.provider ?? providers[0]!.provider); }, [providers]);
    const selected = providers.find(provider => provider.provider === controller.selected);
    const visible = providers.filter(provider => provider.displayName.toLowerCase().includes(controller.query.toLowerCase()));
    const pick = (id: string | null) => controller.select(id);
    const providerRow = (provider: RuntimeProviderView) => <ProviderRow key={provider.provider} provider={provider} controller={controller} />;
    return <div className="model-services">
      <aside className="model-services__navigation" aria-label="提供商列表">
        <div className="model-services__search"><Search size={16} aria-hidden="true" /><SettingsTextInput aria-label="搜索提供商" placeholder="搜索提供商" value={controller.query} onChange={event => { controller.query = event.target.value; controller.notify(); }} />
          <CreatePopover label="添加提供商" allowSpeech={!!snapshot.providers?.creation?.speech} disabled={controller.busy || !snapshot.providers?.creation} onCreate={async (name, type) => { await controller.create(name, type); if (controller.error) throw new Error(controller.error); }} />
        </div>
        {([ ["已启用", (p: RuntimeProviderView) => p.enabled], ["自定义", (p: RuntimeProviderView) => !p.enabled && p.declared], ["未启用", (p: RuntimeProviderView) => !p.enabled && !p.declared] ] as const).map(([title, filter]) => <details open={title !== "未启用" || !!controller.query || !!(selected && filter(selected))} key={title} hidden={!visible.some(filter)}><summary className="ui-native-disclosure">{title}</summary>{visible.filter(filter).map(providerRow)}</details>)}
      </aside>
      <div className="model-services__main"><div className="model-services__mobile-select"><SettingsSelect aria-label="选择提供商" value={selected?.provider ?? ""} onChange={event => pick(event.target.value || null)}><option value="">全部提供商</option>{providers.map(provider => <option key={provider.provider} value={provider.provider}>{provider.displayName}</option>)}</SettingsSelect><CreatePopover label="添加提供商" allowSpeech={!!snapshot.providers?.creation?.speech} disabled={controller.busy || !snapshot.providers?.creation} onCreate={async (name, type) => { await controller.create(name, type); if (controller.error) throw new Error(controller.error); }} /></div>
        {snapshot.providers?.application?.state === "failed" ? <SettingsNotice tone="error">{snapshot.providers.application.error}<SettingsButton disabled={controller.busy} onClick={() => { void controller.run(()=>controller.service.reapply()); }}>重试应用</SettingsButton></SettingsNotice> : null}
        {snapshot.error ? <SettingsNotice tone="error">{snapshot.error}<SettingsButton onClick={() => { void controller.service.refresh(); }}>重试</SettingsButton></SettingsNotice> : null}
        {selected ? <ProviderDetail key={selected.provider} controller={controller} provider={selected} /> : <div className="model-services__overview"><h2>全部提供商</h2>{visible.map(providerRow)}{!providers.length ? snapshot.phase === "loading" ? <div className="model-services__pending" role="status" aria-label="正在加载提供商"><LoaderCircle aria-hidden="true" className="is-spinning" size={16} /></div> : <p>暂无提供商</p> : null}</div>}
      </div>
    </div>;
  };
}
