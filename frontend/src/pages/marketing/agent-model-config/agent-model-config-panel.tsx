"use client";

import {
  Activity,
  Check,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useT } from "@/i18n/t";
import { cn } from "@/lib/utils";

import type {
  HermesConnectionProbeResult,
  HermesConfiguredModel,
  HermesModelConfigExecDebugCommand,
  ModelProviderOption,
} from "./model-config-client";
import { ModelActionTooltip } from "./model-action-tooltip";
import { getHermesModelIdentity, useModelConfig } from "./use-model-config";

type ProviderCategory = "coding_plan" | "api" | "custom";
type ConfigurePurpose = "primary" | "fallback" | "idle";
type ModelOption = { id: string; name: string; source: "live" | "catalog" };

const PROVIDER_CATEGORIES: Array<{ id: ProviderCategory; label: string }> = [
  { id: "coding_plan", label: "模型 Coding Plan" },
  { id: "api", label: "模型 API" },
  { id: "custom", label: "自定义模型" },
];

const MODEL_FIELD_CLASS = "grid gap-y-2";
const MODEL_CONTROL_CLASS = "h-12 rounded-md border-black/10 bg-white shadow-none outline-none transition-colors focus:border-[#2F6BFF] focus:outline-none focus:ring-0 focus-visible:border-[#2F6BFF] focus-visible:outline-none focus-visible:ring-0";
const MODEL_SELECT_CONTENT_CLASS = "max-h-80 w-[var(--radix-select-trigger-width)] min-w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)] rounded-md";
const MODEL_SELECT_CONTENT_STYLE = {
  width: "var(--radix-select-trigger-width)",
  minWidth: "var(--radix-select-trigger-width)",
} as const;

function managedProviderKey(value: string) {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.startsWith("lightvela-") ? slug : `lightvela-${slug || "provider"}`;
}

function stableProviderHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function customManagedProviderKey(name: string, baseUrl: string) {
  const endpointHash = stableProviderHash(baseUrl.trim().toLowerCase());
  return managedProviderKey(`custom-${name}-${endpointHash}`);
}

function sameModel(
  left: Pick<HermesConfiguredModel, "providerKey" | "id"> | null | undefined,
  right: Pick<HermesConfiguredModel, "providerKey" | "id"> | null | undefined,
) {
  return !!left && !!right && getHermesModelIdentity(left) === getHermesModelIdentity(right);
}

function displayConfiguredModelId(modelId: string) {
  return ["auto", "default", "自动"].includes(modelId.trim().toLowerCase()) ? "Auto" : modelId;
}

function displayError(message: string, localizedFallback: string) {
  if (/^(Model configuration|Hermes model config response)/.test(message)) {
    return localizedFallback;
  }
  return message;
}

function ModelConfigLoading() {
  const t = useT();
  return (
    <div
      className="flex min-h-48 items-center justify-center rounded-md border border-black/[0.06] bg-white text-sm text-black/50"
      aria-busy="true"
    >
      <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
      {t("正在读取模型配置")}
    </div>
  );
}

export function AgentModelConfigPanel({
  botId,
  execDebugCommand,
  providers,
}: {
  botId: string;
  execDebugCommand: HermesModelConfigExecDebugCommand;
  providers: ModelProviderOption[];
}) {
  const t = useT();
  const controller = useModelConfig({ botId, execDebugCommand });
  const addSectionRef = useRef<HTMLElement>(null);
  const configuredHeadingRef = useRef<HTMLHeadingElement>(null);
  const providerTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusAfterDelete = useRef(false);
  const [category, setCategory] = useState<ProviderCategory>("coding_plan");
  const [providerKey, setProviderKey] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyTarget, setApiKeyTarget] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [customProviderName, setCustomProviderName] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customApiMode, setCustomApiMode] = useState("chat_completions");
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [purpose, setPurpose] = useState<ConfigurePurpose>("primary");
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [connectionResult, setConnectionResult] = useState<HermesConnectionProbeResult | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HermesConfiguredModel | null>(null);
  const probeUiRevision = useRef(0);

  const providerOptions = useMemo(
    () => providers.filter((provider) => provider.category === category),
    [category, providers],
  );
  const activeProvider = category === "custom"
    ? null
    : providerOptions.find((provider) => provider.providerKey === providerKey) ?? null;

  useEffect(() => {
    if (category === "custom") return;
    if (providerOptions.length === 0 && providers.length > 0) {
      setCategory(providers.some((provider) => provider.category === "coding_plan") ? "coding_plan" : "api");
      return;
    }
    if (!providerOptions.some((provider) => provider.providerKey === providerKey)) {
      setProviderKey(providerOptions[0]?.providerKey ?? "");
    }
  }, [category, providerKey, providerOptions, providers]);

  const resetProbeResult = () => {
    probeUiRevision.current += 1;
    setModelOptions([]);
    setSelectedModelId("");
    setSuccessMessage(null);
    setConnectionResult(null);
    controller.clearOperationError();
  };

  const providerDraft = category === "custom"
    ? {
        providerKey: customManagedProviderKey(customProviderName, customBaseUrl),
        providerName: customProviderName.trim(),
        baseUrl: customBaseUrl.trim(),
        apiMode: customApiMode,
      }
    : activeProvider
      ? {
          providerKey: managedProviderKey(activeProvider.providerKey),
          providerName: activeProvider.providerName,
          baseUrl: activeProvider.baseUrl,
          apiMode: activeProvider.apiMode,
        }
      : null;
  const providerFingerprint = providerDraft
    ? [providerDraft.providerKey, providerDraft.baseUrl, providerDraft.apiMode].join("\n")
    : "";
  const providerFingerprintRef = useRef(providerFingerprint);
  const previousProviderFingerprintRef = useRef(providerFingerprint);
  providerFingerprintRef.current = providerFingerprint;
  const selectedModel = providerDraft && selectedModelId
    ? { ...providerDraft, id: selectedModelId, keyEnv: "" }
    : null;
  const fallbackPurposeDisabled = sameModel(controller.snapshot?.primary, selectedModel);
  const credentialMatchesProvider = !!providerFingerprint && apiKeyTarget === providerFingerprint;
  const canProbe = !!providerDraft?.providerName && !!providerDraft.baseUrl && !!apiKey.trim() && credentialMatchesProvider;
  const busy = controller.operation !== null;

  useEffect(() => {
    if (previousProviderFingerprintRef.current === providerFingerprint) return;
    previousProviderFingerprintRef.current = providerFingerprint;
    providerFingerprintRef.current = providerFingerprint;
    probeUiRevision.current += 1;
    controller.cancelProbe();
    controller.clearOperationError();
    setApiKey("");
    setApiKeyTarget("");
    setShowApiKey(false);
    setModelOptions([]);
    setSelectedModelId("");
    setSuccessMessage(null);
    setConnectionResult(null);
  }, [controller.cancelProbe, controller.clearOperationError, providerFingerprint]);

  useEffect(() => {
    setPurpose(controller.snapshot?.primary ? "idle" : "primary");
  }, [controller.snapshot?.primary]);

  const handleCategoryChange = (nextCategory: ProviderCategory) => {
    setCategory(nextCategory);
    setProviderKey("");
    setApiKey("");
    setApiKeyTarget("");
    setShowApiKey(false);
    setPurpose(controller.snapshot?.primary ? "idle" : "primary");
    resetProbeResult();
  };

  const handleProbe = async () => {
    if (!providerDraft || !canProbe) return;
    const requestFingerprint = providerFingerprint;
    resetProbeResult();
    const revision = probeUiRevision.current;
    const catalogModels = category === "custom" ? [] : activeProvider?.catalogModels ?? [];
    const probeResult = await controller.probe({
      apiKey: apiKey.trim(),
      baseUrl: providerDraft.baseUrl,
      apiMode: providerDraft.apiMode,
    });
    if (!probeResult || revision !== probeUiRevision.current || requestFingerprint !== providerFingerprintRef.current) return;
    const nextOptions: ModelOption[] = probeResult.models.length > 0
      ? probeResult.models.map((id) => ({ id, name: id, source: "live" }))
      : probeResult.succeeded
        ? catalogModels.map(({ id, name }) => ({ id, name, source: "catalog" }))
        : [];
    setModelOptions(nextOptions);
    setSelectedModelId(nextOptions[0]?.id ?? "");
    setSuccessMessage(nextOptions.length > 0
      ? t("已获取可用模型")
      : t("未检测到可用模型"));
  };

  const handleAdd = async () => {
    if (!selectedModel || !apiKey.trim()) return;
    const nextSnapshot = await controller.add({
      apiKey: apiKey.trim(),
      model: selectedModel,
      purpose,
    });
    if (!nextSnapshot) return;
    setApiKey("");
    setApiKeyTarget("");
    setShowApiKey(false);
    setModelOptions([]);
    setSelectedModelId("");
    setSuccessMessage(t("模型已添加"));
    setConnectionResult(null);
  };

  const handleConnectivityTest = async () => {
    if (!selectedModel || !apiKey.trim() || !credentialMatchesProvider) return;
    const requestFingerprint = providerFingerprint;
    const revision = probeUiRevision.current;
    setConnectionResult(null);
    const result = await controller.testConnection({
      apiKey: apiKey.trim(),
      model: selectedModel,
    });
    if (result && revision === probeUiRevision.current && requestFingerprint === providerFingerprintRef.current) {
      setConnectionResult(result);
    }
  };

  const focusAddSection = () => {
    if (typeof addSectionRef.current?.scrollIntoView === "function") {
      addSectionRef.current.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    providerTriggerRef.current?.focus();
  };

  if (controller.loading && !controller.snapshot) return <ModelConfigLoading />;

  if (controller.loadError && !controller.snapshot) {
    return (
      <div className="rounded-md border border-red-100 bg-red-50 px-5 py-5 text-sm text-red-700" role="alert">
        <p className="font-medium">{t("读取模型配置失败")}</p>
        <p className="mt-1 text-pretty text-red-600/80">{displayError(controller.loadError, t("模型配置操作失败，请重试。"))}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-4 rounded-md"
          onClick={() => void controller.reload()}
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {t("重试")}
        </Button>
      </div>
    );
  }

  const snapshot = controller.snapshot ?? { primary: null, fallbacks: [], configuredModels: [] };

  return (
    <div className="space-y-5 pb-12 md:pb-16" aria-busy={busy || controller.loading}>
      <section className="overflow-hidden rounded-md border border-black/[0.06] bg-white shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
        <div className="flex items-start justify-between gap-4 border-b border-black/[0.06] px-5 py-4">
          <div>
            <h2 ref={configuredHeadingRef} tabIndex={-1} className="text-base font-semibold text-black/85 focus:outline-none">
              {t("已配置模型")}
            </h2>
            <p className="mt-1 text-pretty text-sm text-black/45">
              {t("选择一个主模型，并可设置多个备用模型。配置将在新会话中生效。")}
            </p>
          </div>
          <span className="shrink-0 text-xs font-medium text-black/35">
            {t("共 {{count}} 个", { count: snapshot.configuredModels.length })}
          </span>
        </div>

        {controller.operationError && ["assign-primary", "assign-fallback", "remove-fallback"].includes(controller.operationErrorOperation ?? "") ? (
          <div className="mx-5 mt-4 rounded-md border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {displayError(controller.operationError, t("模型配置操作失败，请重试。"))}
          </div>
        ) : null}

        {snapshot.configuredModels.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm font-medium text-black/65">{t("暂未配置模型")}</p>
            <p className="mt-1 text-pretty text-sm text-black/40">
              {t("选择 Provider 并探测可用模型后即可添加。")}
            </p>
            <Button type="button" size="sm" className="mt-4 rounded-md" onClick={focusAddSection}>
              <Plus className="size-3.5" aria-hidden="true" />
              {t("添加第一个模型")}
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-black/[0.06]">
            {snapshot.configuredModels.map((model) => {
              const primary = sameModel(snapshot.primary, model);
              const fallback = snapshot.fallbacks.some((candidate) => sameModel(candidate, model));
              const role = primary ? "primary" : fallback ? "fallback" : "idle";
              return (
                <li
                  key={getHermesModelIdentity(model)}
                  className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-all text-sm font-semibold text-black/85">{displayConfiguredModelId(model.id)}</span>
                      <Badge variant={primary ? "success" : fallback ? "warning" : "neutral"}>
                        {role === "primary" ? t("主模型") : role === "fallback" ? t("备用模型") : t("未启用")}
                      </Badge>
                    </div>
                    <p className="mt-1 break-all text-xs text-black/45">{model.providerName}</p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <ModelActionTooltip content={primary ? t("当前模型已经是主模型") : undefined}>
                      <Button
                        type="button"
                        size="sm"
                        variant={primary ? "secondary" : "outline"}
                        className="rounded-md"
                        disabled={busy || primary}
                        onClick={() => void controller.assign(model, "primary")}
                      >
                        <Check className="size-3.5" aria-hidden="true" />
                        {t("设为主模型")}
                      </Button>
                    </ModelActionTooltip>
                    <ModelActionTooltip content={primary ? t("主模型不能同时设为备用模型") : undefined}>
                      <Button
                        type="button"
                        size="sm"
                        variant={fallback ? "secondary" : "outline"}
                        className="rounded-md"
                        disabled={busy || primary}
                        onClick={() => void (fallback
                          ? controller.removeFallback(model)
                          : controller.assign(model, "fallback"))}
                      >
                        {fallback ? t("取消备用") : t("设为备用模型")}
                      </Button>
                    </ModelActionTooltip>
                    <ModelActionTooltip content={primary ? t("请先切换主模型后再删除") : undefined}>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="rounded-md"
                        disabled={busy || primary}
                        onClick={() => {
                          controller.clearOperationError();
                          setDeleteTarget(model);
                        }}
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                        {t("删除")}
                      </Button>
                    </ModelActionTooltip>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section
        ref={addSectionRef}
        className="overflow-hidden rounded-md border border-black/[0.06] bg-white shadow-[0_10px_30px_rgba(15,23,42,0.04)]"
      >
        <Tabs value={category} onValueChange={(value) => handleCategoryChange(value as ProviderCategory)}>
          <div className="overflow-x-auto bg-white px-5 pt-4 sm:px-6">
            <TabsList
              className="flex h-auto w-full justify-start gap-4 rounded-none border-0 border-b border-black/[0.06] bg-transparent p-0 shadow-none sm:gap-10"
              aria-label={t("模型配置方式")}
            >
              {PROVIDER_CATEGORIES.map((item) => {
                return (
                  <TabsTrigger
                    key={item.id}
                    value={item.id}
                    disabled={busy}
                    className="relative min-w-0 flex-none rounded-none border-0 bg-transparent px-0 pb-4 pt-1 text-sm font-normal text-black/60 shadow-none transition-none after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-transparent after:content-[''] hover:text-black/85 data-[state=active]:bg-transparent data-[state=active]:font-semibold data-[state=active]:text-black data-[state=active]:shadow-none data-[state=active]:after:bg-black sm:text-base"
                  >
                    {item.id === "coding_plan"
                      ? t("模型 Coding Plan")
                      : item.id === "api"
                        ? t("模型 API")
                        : t("自定义模型")}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </div>

          <TabsContent value={category} forceMount className="m-0 grid gap-5 bg-white px-5 py-6 sm:px-6">
          {category === "custom" ? (
            <div className="grid gap-4 md:grid-cols-2">
              <label className={cn(MODEL_FIELD_CLASS, "text-sm font-medium text-black/70")}>
                <span>{t("Provider 名称")}</span>
                <Input
                  value={customProviderName}
                  disabled={busy}
                  className={MODEL_CONTROL_CLASS}
                  onChange={(event) => {
                    setCustomProviderName(event.target.value);
                    resetProbeResult();
                  }}
                />
              </label>
              <label className={cn(MODEL_FIELD_CLASS, "text-sm font-medium text-black/70")}>
                <span>Base URL</span>
                <Input
                  value={customBaseUrl}
                  disabled={busy}
                  placeholder="https://api.example.com/v1"
                  className={MODEL_CONTROL_CLASS}
                  onChange={(event) => {
                    setCustomBaseUrl(event.target.value);
                    resetProbeResult();
                  }}
                />
              </label>
              <div className={cn(MODEL_FIELD_CLASS, "md:col-span-2")}>
                <label className="text-sm font-medium text-black/70" htmlFor="custom-api-mode">
                  {t("兼容协议")}
                </label>
                <Select
                  value={customApiMode}
                  disabled={busy}
                  onValueChange={(value) => {
                    setCustomApiMode(value);
                    resetProbeResult();
                  }}
                >
                  <SelectTrigger id="custom-api-mode" aria-label={t("兼容协议")} className={MODEL_CONTROL_CLASS}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    position="popper"
                    className={MODEL_SELECT_CONTENT_CLASS}
                    style={MODEL_SELECT_CONTENT_STYLE}
                  >
                    <SelectItem value="chat_completions">OpenAI Chat Completions</SelectItem>
                    <SelectItem value="anthropic_messages">Anthropic Messages</SelectItem>
                    <SelectItem value="codex_responses">OpenAI Responses</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : (
            <div className={MODEL_FIELD_CLASS}>
              <label className="text-sm font-medium text-black/70" htmlFor="model-provider">
                {category === "coding_plan" ? t("Coding Plan 套餐") : t("模型服务商")}
              </label>
              <Select
                value={providerKey}
                disabled={busy || providerOptions.length === 0}
                onValueChange={(value) => {
                  setProviderKey(value);
                  setApiKey("");
                  setApiKeyTarget("");
                  setShowApiKey(false);
                  resetProbeResult();
                }}
              >
                <SelectTrigger
                  ref={providerTriggerRef}
                  id="model-provider"
                  aria-label={category === "coding_plan" ? t("Coding Plan 套餐") : t("模型服务商")}
                  className={MODEL_CONTROL_CLASS}
                >
                  <SelectValue placeholder={t("请选择 Provider")} />
                </SelectTrigger>
                <SelectContent
                  position="popper"
                  className={MODEL_SELECT_CONTENT_CLASS}
                  style={MODEL_SELECT_CONTENT_STYLE}
                >
                  {providerOptions.map((provider) => (
                    <SelectItem key={provider.providerKey} value={provider.providerKey}>
                      {provider.providerName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {activeProvider?.description ? (
                <p className="text-pretty text-sm leading-6 text-black/45">{activeProvider.description}</p>
              ) : null}
            </div>
          )}

          <div className={MODEL_FIELD_CLASS}>
            <label className="text-sm font-medium text-black/70" htmlFor="model-api-key">API Key</label>
            <div className="relative min-w-0">
              <Input
                id="model-api-key"
                type={showApiKey ? "text" : "password"}
                autoComplete="new-password"
                value={apiKey}
                disabled={busy}
                placeholder={t("请输入 API Key")}
                className={cn(MODEL_CONTROL_CLASS, "pr-11")}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setApiKeyTarget(providerFingerprint);
                  resetProbeResult();
                }}
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-black/35 hover:bg-black/[0.04] hover:text-black/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                aria-label={showApiKey ? t("隐藏 API Key") : t("显示 API Key")}
                onClick={() => setShowApiKey((visible) => !visible)}
              >
                {showApiKey ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
              </button>
            </div>
            {activeProvider?.apiKeyUrl ? (
              <a
                className="w-fit text-sm font-medium text-black/55 underline-offset-4 hover:text-black/80 hover:underline"
                href={activeProvider.apiKeyUrl}
                target="_blank"
                rel="noreferrer"
              >
                {t("获取 API Key")}
              </a>
            ) : null}
          </div>

          <div className={MODEL_FIELD_CLASS}>
            <label className="text-sm font-medium text-black/70" htmlFor="detected-model">
              {t("模型")}
            </label>
            <div className={cn(modelOptions.length > 0 && "flex flex-col gap-2 sm:flex-row sm:items-center")}>
              <Select
                value={selectedModelId}
                disabled={busy || modelOptions.length === 0}
                onValueChange={(value) => {
                  setSelectedModelId(value);
                  setConnectionResult(null);
                  controller.clearOperationError();
                }}
              >
                <SelectTrigger
                  id="detected-model"
                  aria-label={t("模型")}
                  className={cn(MODEL_CONTROL_CLASS, modelOptions.length > 0 && "min-w-0 flex-1")}
                >
                  <SelectValue placeholder={modelOptions.length > 0 ? t("请选择模型") : t("请先获取可用模型")} />
                </SelectTrigger>
                <SelectContent
                  position="popper"
                  className={MODEL_SELECT_CONTENT_CLASS}
                  style={MODEL_SELECT_CONTENT_STYLE}
                >
                  {modelOptions.map((modelOption) => (
                    <SelectItem key={modelOption.id} value={modelOption.id}>{modelOption.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {modelOptions.length > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full shrink-0 rounded-md sm:min-w-36 sm:w-auto"
                  disabled={!canProbe || busy}
                  onClick={() => void handleProbe()}
                >
                  {controller.operation === "probe"
                    ? <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    : <Search className="size-4" aria-hidden="true" />}
                  {controller.operation === "probe" ? t("获取中...") : t("获取可用模型")}
                </Button>
              ) : null}
            </div>
            {modelOptions.length === 0 ? (
              <Button
                type="button"
                variant="outline"
                className="w-full rounded-md sm:min-w-36 sm:w-auto"
                disabled={!canProbe || busy}
                onClick={() => void handleProbe()}
              >
                {controller.operation === "probe"
                  ? <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  : <Search className="size-4" aria-hidden="true" />}
                {controller.operation === "probe" ? t("获取中...") : t("获取可用模型")}
              </Button>
            ) : null}
          </div>

          <fieldset>
            <legend className="text-sm font-medium text-black/70">{t("选择用途")}</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {([
                { value: "primary", label: "设为主模型" },
                { value: "fallback", label: "设为备用模型" },
                { value: "idle", label: "仅添加" },
              ] satisfies Array<{ value: ConfigurePurpose; label: string }>).map((item) => {
                const disabled = busy || (item.value === "fallback" && fallbackPurposeDisabled);
                const active = purpose === item.value;
                return (
                  <label
                    key={item.value}
                    className={cn(
                      "flex min-h-10 items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                      active ? "border-black/70 bg-black/[0.035] text-black/85" : "border-black/[0.08] text-black/60",
                      disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer hover:border-black/20",
                    )}
                  >
                    <input
                      type="radio"
                      name="model-purpose"
                      className="size-3.5"
                      value={item.value}
                      checked={active}
                      disabled={disabled}
                      aria-describedby={item.value === "fallback" && fallbackPurposeDisabled ? "fallback-purpose-help" : undefined}
                      onChange={() => setPurpose(item.value)}
                    />
                    {item.value === "primary"
                      ? t("设为主模型")
                      : item.value === "fallback"
                        ? t("设为备用模型")
                        : t("仅添加")}
                  </label>
                );
              })}
            </div>
            {fallbackPurposeDisabled ? (
              <p id="fallback-purpose-help" className="text-xs text-black/45">
                {t("主模型不能同时设为备用模型。")}
              </p>
            ) : null}
          </fieldset>

          <div aria-live="polite">
            {controller.operationError && ["probe", "connectivity-probe", "add"].includes(controller.operationErrorOperation ?? "") ? (
              <p className="mb-3 rounded-md border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                {displayError(controller.operationError, t("模型配置操作失败，请重试。"))}
              </p>
            ) : null}
            {successMessage ? (
              <p className="rounded-md border border-black/[0.06] bg-black/[0.025] px-3 py-2 text-sm text-black/60">
                {successMessage}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2 border-t border-black/[0.06] pt-5 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="w-full rounded-md sm:w-auto"
              disabled={!selectedModel || !apiKey.trim() || !credentialMatchesProvider || busy}
              onClick={() => void handleConnectivityTest()}
            >
              {controller.operation === "connectivity-probe"
                ? <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                : <Activity className="size-4" aria-hidden="true" />}
              {controller.operation === "connectivity-probe" ? t("检测中...") : t("模型检测")}
            </Button>
            <Button
              type="button"
              className="w-full rounded-md sm:w-auto"
              disabled={!selectedModel || !apiKey.trim() || !credentialMatchesProvider || busy || (purpose === "fallback" && fallbackPurposeDisabled)}
              onClick={() => void handleAdd()}
            >
              {controller.operation === "add"
                ? <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                : <Plus className="size-4" aria-hidden="true" />}
              {t("添加模型")}
            </Button>
          </div>
          </TabsContent>
        </Tabs>
      </section>

      <Dialog
        open={connectionResult !== null}
        onOpenChange={(open) => {
          if (!open) setConnectionResult(null);
        }}
      >
        <DialogContent className="rounded-md md:rounded-md">
          <DialogHeader className="mb-5">
            <DialogTitle className="flex items-center gap-2">
              {connectionResult?.success
                ? <CheckCircle2 className="size-5 text-emerald-600" aria-hidden="true" />
                : <XCircle className="size-5 text-red-600" aria-hidden="true" />}
              {connectionResult?.success ? t("模型可用性检测通过") : t("模型可用性检测未通过")}
            </DialogTitle>
            <DialogDescription>
              {connectionResult?.success
                ? t("当前凭据可以访问该模型。")
                : t("未能确认当前凭据可以访问该模型，请检查配置后重试。")}
            </DialogDescription>
          </DialogHeader>
          {connectionResult ? (
            <dl className="grid gap-3 rounded-md border border-black/[0.06] bg-black/[0.02] p-4 text-sm">
              <div className="grid gap-1 sm:grid-cols-[6rem_minmax(0,1fr)]">
                <dt className="text-black/45">Provider</dt>
                <dd className="break-all text-black/75">{connectionResult.provider}</dd>
              </div>
              <div className="grid gap-1 sm:grid-cols-[6rem_minmax(0,1fr)]">
                <dt className="text-black/45">{t("模型")}</dt>
                <dd className="break-all text-black/75">{connectionResult.model}</dd>
              </div>
              <div className="grid gap-1 sm:grid-cols-[6rem_minmax(0,1fr)]">
                <dt className="text-black/45">Base URL</dt>
                <dd className="break-all text-black/75">{connectionResult.baseUrl}</dd>
              </div>
              {connectionResult.timeMs !== undefined ? (
                <div className="grid gap-1 sm:grid-cols-[6rem_minmax(0,1fr)]">
                  <dt className="text-black/45">{t("响应时间")}</dt>
                  <dd className="text-black/75">{connectionResult.timeMs} ms</dd>
                </div>
              ) : null}
              {connectionResult.errorCode !== undefined ? (
                <div className="grid gap-1 sm:grid-cols-[6rem_minmax(0,1fr)]">
                  <dt className="text-black/45">{t("错误码")}</dt>
                  <dd className="break-all text-black/75">{connectionResult.errorCode}</dd>
                </div>
              ) : null}
              {connectionResult.errorMessage ? (
                <div className="grid gap-1 sm:grid-cols-[6rem_minmax(0,1fr)]">
                  <dt className="text-black/45">{t("失败原因")}</dt>
                  <dd className="break-words text-red-700">{connectionResult.errorMessage}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          <div className="flex justify-end pt-2">
            <DialogClose asChild>
              <Button type="button" className="rounded-md">{t("确定")}</Button>
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            controller.clearOperationError();
          }
        }}
      >
        <DialogContent
          className="rounded-md md:rounded-md"
          onCloseAutoFocus={(event) => {
            if (!restoreFocusAfterDelete.current) return;
            event.preventDefault();
            restoreFocusAfterDelete.current = false;
            configuredHeadingRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("删除模型")}</DialogTitle>
            <DialogDescription>
              {t("删除后将移除此模型配置；如果 Provider 下没有其他模型，也会移除对应凭据。")}
            </DialogDescription>
          </DialogHeader>
          {controller.operationError && controller.operationErrorOperation === "remove" ? (
            <div className="rounded-md border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {displayError(controller.operationError, t("模型配置操作失败，请重试。"))}
            </div>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <DialogClose asChild>
              <Button type="button" variant="outline" className="rounded-md">{t("取消")}</Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              className="rounded-md"
              disabled={busy}
              onClick={async () => {
                if (!deleteTarget) return;
                const removed = await controller.remove(deleteTarget);
                if (removed) {
                  restoreFocusAfterDelete.current = true;
                  setDeleteTarget(null);
                }
              }}
            >
              {t("确认删除")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
