// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
"use client";

import {
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AgentSectionHeader } from "../../../components/domain/agent-section-header";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { OptionGroup } from "../../../components/ui/option-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { useT } from "../../../i18n/t";
import { toast } from "../../../lib/toast";
import { cn } from "../../../lib/utils";
import { resolveAgentConsoleCollectionLabel } from "../agent-provider-locale";

import type {
  HermesConnectionProbeResult,
  HermesConfiguredModel,
  HermesModelConfigExecDebugCommand,
  ModelProviderOption,
} from "./model-config-client";
import { ModelActionTooltip } from "./model-action-tooltip";
import {
  getHermesModelIdentity,
  type HermesModelIdentityInput,
  useModelConfig,
} from "./use-model-config";

type ProviderCategory = "coding_plan" | "api" | "custom";
type ConfigurePurpose = "primary" | "fallback" | "idle";
type ModelOption = { id: string; name: string; source: "live" | "catalog" };
type ModelOptionsOrigin = ModelOption["source"];
type ConfiguredModelListItem = HermesConfiguredModel & {
  catalogName?: string;
  catalogOnly?: true;
};
type ConfiguredProviderGroup = {
  key: string;
  providerName: string;
  models: ConfiguredModelListItem[];
};

const PROVIDER_CATEGORIES: Array<{ id: ProviderCategory; label: string }> = [
  { id: "coding_plan", label: "模型 Coding Plan" },
  { id: "api", label: "模型 API" },
  { id: "custom", label: "自定义模型" },
];

/**
 * 自定义供应商的凭据作用域。Provider 名称、Base URL、兼容协议都在同一份草稿里逐字符编辑，
 * 若按端点指纹隔离凭据，用户每敲一个字符就会丢失已输入的 API Key。
 */
const CUSTOM_CREDENTIAL_SCOPE = "custom-draft";

const CUSTOM_MODEL_SUGGESTION_LIST_ID = "custom-model-suggestions";

const MODEL_FIELD_CLASS = "grid gap-y-2";
const MODEL_CONTROL_CLASS = "lv-model-control h-12";
const MODEL_COMPOUND_CONTROL_BASE_CLASS = "min-w-0 overflow-hidden rounded-md border border-black/10 bg-white shadow-none transition-colors focus-within:border-[#2F6BFF]";
const MODEL_COMPOUND_FIELD_BASE_CLASS = "min-w-0 rounded-none border-0 bg-transparent shadow-none outline-none focus:border-0 focus:outline-none focus:ring-0 focus-visible:border-0 focus-visible:outline-none focus-visible:ring-0";
const MODEL_COMPOUND_ACTION_BASE_CLASS = "shrink-0 whitespace-nowrap rounded-none border-0 bg-white px-3 shadow-none hover:translate-y-0 hover:border-black/10 hover:bg-black/[0.025] focus-visible:ring-inset";
const MODEL_SELECT_CONTENT_CLASS = "lv-model-select-content max-h-80 w-[var(--radix-select-trigger-width)] min-w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)]";
const MODEL_RADIO_CLASS = "lv-radio shrink-0";
const MODEL_SELECT_CONTENT_STYLE = {
  width: "var(--radix-select-trigger-width)",
  minWidth: "var(--radix-select-trigger-width)",
} as const;

function ModelCompoundActionContent({
  idleLabel,
  loadingLabel,
  loading,
}: {
  idleLabel: string;
  loadingLabel: string;
  loading: boolean;
}) {
  return (
    <span className="relative grid place-items-center">
      <span
        aria-hidden="true"
        data-slot="model-compound-action-width-label"
        className="invisible whitespace-nowrap"
      >
        {idleLabel}
      </span>
      <span className="absolute inset-0 inline-flex items-center justify-center gap-2 whitespace-nowrap">
        {loading ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
        {loading ? loadingLabel : idleLabel}
      </span>
    </span>
  );
}

function captureAgentSidebarPosition() {
  const sidebar = document.querySelector<HTMLElement>(".lv-agents-sidebar-scroll-isolated");
  if (sidebar) {
    sidebar.style.setProperty("--lv-agents-sidebar-locked-top", `${sidebar.getBoundingClientRect().top}px`);
  }
}

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
  left: HermesModelIdentityInput | null | undefined,
  right: HermesModelIdentityInput | null | undefined,
) {
  return !!left && !!right && getHermesModelIdentity(left) === getHermesModelIdentity(right);
}

function normalizeProviderEndpoint(value: string) {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

function getConfiguredProviderGroupKey(model: HermesConfiguredModel) {
  const routeBaseUrl = normalizeProviderEndpoint(model.routeBaseUrl || model.baseUrl);
  return JSON.stringify([model.providerKey.trim().toLowerCase(), routeBaseUrl]);
}

function modelMatchesProductProvider(model: HermesConfiguredModel, provider: ModelProviderOption) {
  const configuredKey = model.providerKey.trim().toLowerCase();
  const productKey = provider.providerKey.trim().toLowerCase();
  return (configuredKey === productKey || configuredKey === managedProviderKey(productKey))
    && normalizeProviderEndpoint(model.routeBaseUrl || model.baseUrl) === normalizeProviderEndpoint(provider.baseUrl)
    && model.apiMode.trim().toLowerCase() === provider.apiMode.trim().toLowerCase();
}

function isBuiltInProviderGroup(group: ConfiguredProviderGroup) {
  return group.providerName.trim().toLowerCase() === "custom"
    && group.models.some((model) => displayConfiguredModelId(model.id) === "Auto");
}

function groupConfiguredModelsByProvider(
  models: HermesConfiguredModel[],
  providers: ModelProviderOption[],
) {
  const groups = new Map<string, ConfiguredProviderGroup>();
  for (const model of models) {
    const key = getConfiguredProviderGroupKey(model);
    const group = groups.get(key);
    if (group) {
      group.models.push(model);
    } else {
      groups.set(key, { key, providerName: model.providerName, models: [model] });
    }
  }
  for (const group of groups.values()) {
    const matchingProviders = providers.filter((provider) => (
      provider.catalogModels?.length
      && group.models.every((model) => modelMatchesProductProvider(model, provider))
      && new Set(group.models.map((model) => model.keyEnv.trim())).size === 1
    ));
    if (matchingProviders.length !== 1) continue;
    const provider = matchingProviders[0];
    const representative = group.models[0];
    if (!provider || !representative) continue;
    const catalogNames = new Map(
      (provider.catalogModels ?? []).map(({ id, name }) => [id.trim(), name.trim() || id.trim()]),
    );
    group.models = group.models.map((model) => ({
      ...model,
      catalogName: catalogNames.get(model.id.trim()),
    }));
    const identities = new Set(group.models.map(getHermesModelIdentity));
    for (const catalogModel of provider.catalogModels ?? []) {
      const id = catalogModel.id.trim();
      if (!id) continue;
      const candidate: ConfiguredModelListItem = {
        ...representative,
        id,
        catalogName: catalogModel.name.trim() || id,
        catalogOnly: true,
      };
      const identity = getHermesModelIdentity(candidate);
      if (identities.has(identity)) continue;
      identities.add(identity);
      group.models.push(candidate);
    }
  }
  const orderedGroups = [...groups.values()];
  return [
    ...orderedGroups.filter(isBuiltInProviderGroup),
    ...orderedGroups.filter((group) => !isBuiltInProviderGroup(group)),
  ];
}

function displayConfiguredModelId(modelId: string, autoLabel = "Auto") {
  return !modelId.trim() || ["auto", "default", "自动"].includes(modelId.trim().toLowerCase()) ? autoLabel : modelId;
}

function displayConfiguredModelName(model: ConfiguredModelListItem, autoLabel = "Auto") {
  return model.catalogName?.trim() || displayConfiguredModelId(model.id, autoLabel);
}

function displayError(message: string, localizedFallback: string) {
  if (/^(Model configuration|Hermes model config response)/.test(message)) {
    return localizedFallback;
  }
  return message;
}

function supportsModelRequestProbe(apiMode: string) {
  return apiMode === "chat_completions" || apiMode === "anthropic_messages";
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
  profileId,
  execDebugCommand,
  providers,
  isGlobalRegion = false,
}: {
  botId: string;
  profileId?: string;
  execDebugCommand: HermesModelConfigExecDebugCommand;
  providers: ModelProviderOption[];
  isGlobalRegion?: boolean;
}) {
  const t = useT();
  const { i18n } = useTranslation();
  const autoModelDisplayName = t("自动");
  const controller = useModelConfig({ botId, profileId, execDebugCommand });
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
  const modelOptionsOriginRef = useRef<ModelOptionsOrigin>("catalog");
  const [selectedModelId, setSelectedModelId] = useState("");
  const [purpose, setPurpose] = useState<ConfigurePurpose>("primary");
  const [connectionResult, setConnectionResult] = useState<HermesConnectionProbeResult | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HermesConfiguredModel | null>(null);
  const [expandedConfiguredProviderKey, setExpandedConfiguredProviderKey] = useState<string | null>(null);
  const [selectedConfiguredModelByProvider, setSelectedConfiguredModelByProvider] = useState<Record<string, string>>({});
  const probeUiRevision = useRef(0);

  const providerOptions = useMemo(
    () => providers.filter((provider) => provider.category === category),
    [category, providers],
  );
  const activeProvider = category === "custom"
    ? null
    : providerOptions.find((provider) => provider.providerKey === providerKey) ?? null;
  const fixedModelOptions = useMemo<ModelOption[]>(
    () => activeProvider?.fixedModelSelection
      ? (activeProvider.catalogModels ?? []).map(({ id, name }) => ({ id, name, source: "catalog" }))
      : [],
    [activeProvider],
  );
  /** Coding Plan 由 fixedModelSelection 接管；这里只为 `api` 分类预置七彩石目录，自定义分类恒为空。 */
  const catalogModelOptions = useMemo<ModelOption[]>(
    () => category === "custom" || activeProvider?.fixedModelSelection
      ? []
      : (activeProvider?.catalogModels ?? []).map(({ id, name }) => ({ id, name, source: "catalog" as const })),
    [activeProvider, category],
  );
  const catalogModelFingerprint = JSON.stringify(
    catalogModelOptions.map(({ id, name }) => [id, name]),
  );
  const availableModelOptions = activeProvider?.fixedModelSelection ? fixedModelOptions : modelOptions;
  const effectiveSelectedModelId = activeProvider?.fixedModelSelection
    ? fixedModelOptions.some((model) => model.id === selectedModelId)
      ? selectedModelId
      : fixedModelOptions[0]?.id ?? ""
    : selectedModelId;
  const canRefreshModels = !activeProvider?.fixedModelSelection
    && (category === "custom" || (activeProvider?.supportsLiveModelRefresh ?? true));

  const compoundControlClassName = cn(
    MODEL_COMPOUND_CONTROL_BASE_CLASS,
    isGlobalRegion
      ? "grid h-auto grid-cols-1 sm:h-12 sm:grid-cols-[minmax(0,1fr)_max-content]"
      : "flex h-12",
  );
  const compoundFieldClassName = cn(
    MODEL_COMPOUND_FIELD_BASE_CLASS,
    isGlobalRegion ? "h-12 w-full sm:h-full" : "h-full flex-1",
  );
  const compoundActionClassName = cn(
    MODEL_COMPOUND_ACTION_BASE_CLASS,
    isGlobalRegion
      ? "h-12 w-full border-t border-black/10 sm:h-full sm:w-auto sm:min-w-max sm:border-l sm:border-t-0 sm:px-4"
      : "h-full min-w-max border-l border-black/10 px-4",
  );

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

  const restoreCatalogModelOptions = () => {
    probeUiRevision.current += 1;
    modelOptionsOriginRef.current = "catalog";
    setModelOptions(catalogModelOptions);
    setSelectedModelId(catalogModelOptions[0]?.id ?? "");
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
  const previousCatalogModelFingerprintRef = useRef(catalogModelFingerprint);
  providerFingerprintRef.current = providerFingerprint;
  const credentialScope = category === "custom" ? CUSTOM_CREDENTIAL_SCOPE : providerFingerprint;
  const previousCredentialScopeRef = useRef(credentialScope);
  const selectedModel = providerDraft && effectiveSelectedModelId
    ? { ...providerDraft, id: effectiveSelectedModelId, keyEnv: "" }
    : null;
  const selectedModelIsPrimary = sameModel(controller.snapshot?.primary, selectedModel);
  const customCredentialIsUnbound = category === "custom" && apiKeyTarget === CUSTOM_CREDENTIAL_SCOPE;
  const credentialMatchesProvider = category === "custom"
    ? customCredentialIsUnbound || (!!providerFingerprint && apiKeyTarget === providerFingerprint)
    : !!credentialScope && apiKeyTarget === credentialScope;
  const canProbe = !!providerDraft?.providerName && !!providerDraft.baseUrl && !!apiKey.trim() && credentialMatchesProvider;
  const busy = controller.operation !== null;
  const snapshot = controller.snapshot ?? { primary: null, fallbacks: [], configuredModels: [] };
  const configuredModels = useMemo(
    () => (controller.snapshot?.configuredModels ?? []).filter((model) => model.id.trim() && model.requiresSetup !== true),
    [controller.snapshot?.configuredModels],
  );
  const configuredProviderGroups = useMemo(
    () => groupConfiguredModelsByProvider(configuredModels, providers),
    [configuredModels, providers],
  );
  const effectiveExpandedConfiguredProviderKey = expandedConfiguredProviderKey !== null
    && configuredProviderGroups.some((group) => group.key === expandedConfiguredProviderKey)
    ? expandedConfiguredProviderKey
    : null;
  const pageHeader = (
    <AgentSectionHeader
      title={resolveAgentConsoleCollectionLabel("model", i18n.language, t)}
      description={t("模型是智能体的“大脑”，在此可配置智能体使用的主模型与备用模型")}
    />
  );

  // 离开当前凭据作用域即作废凭据，确保为某个供应商输入的 API Key 不会流向另一个 endpoint。
  useEffect(() => {
    if (previousCredentialScopeRef.current === credentialScope) return;
    previousCredentialScopeRef.current = credentialScope;
    setApiKey("");
    setApiKeyTarget("");
    setShowApiKey(false);
  }, [credentialScope]);

  useEffect(() => {
    const providerChanged = previousProviderFingerprintRef.current !== providerFingerprint;
    const catalogChanged = previousCatalogModelFingerprintRef.current !== catalogModelFingerprint;
    if (!providerChanged && !catalogChanged) return;
    previousProviderFingerprintRef.current = providerFingerprint;
    previousCatalogModelFingerprintRef.current = catalogModelFingerprint;
    providerFingerprintRef.current = providerFingerprint;
    if (!providerChanged && modelOptionsOriginRef.current === "live") return;
    probeUiRevision.current += 1;
    controller.cancelProbe();
    controller.clearOperationError();
    modelOptionsOriginRef.current = "catalog";
    setModelOptions(catalogModelOptions);
    setSelectedModelId(catalogModelOptions[0]?.id ?? "");
    setConnectionResult(null);
  }, [
    catalogModelFingerprint,
    catalogModelOptions,
    controller.cancelProbe,
    controller.clearOperationError,
    providerFingerprint,
  ]);

  useEffect(() => {
    setPurpose(selectedModelIsPrimary ? "primary" : controller.snapshot?.primary ? "idle" : "primary");
  }, [controller.snapshot?.primary, selectedModelIsPrimary]);

  const handleCategoryChange = (nextCategory: ProviderCategory) => {
    setCategory(nextCategory);
    setProviderKey("");
    setApiKey("");
    setApiKeyTarget("");
    setShowApiKey(false);
    setPurpose(controller.snapshot?.primary ? "idle" : "primary");
    restoreCatalogModelOptions();
  };

  const bindCustomCredentialToProvider = () => {
    if (customCredentialIsUnbound) setApiKeyTarget(providerFingerprint);
  };

  const handleProbe = async () => {
    if (!providerDraft || !canProbe) return;
    const requestFingerprint = providerFingerprint;
    const revision = probeUiRevision.current;
    setConnectionResult(null);
    controller.clearOperationError();
    // 探测结果整体替换当前列表，不与七彩石目录合并，也不用目录补空。
    const applyModelOptions = (nextOptions: ModelOption[], origin: ModelOptionsOrigin) => {
      modelOptionsOriginRef.current = origin;
      setModelOptions(nextOptions);
      setSelectedModelId(nextOptions[0]?.id ?? "");
      if (nextOptions.length > 0) {
        setPurpose("primary");
        toast.success(t("已获取可用模型"));
      } else {
        toast.error(t("未获取到可用模型，请检查API Key是否正确或有效"));
      }
    };
    if (activeProvider?.discoveryStrategy === "catalog") {
      applyModelOptions(catalogModelOptions, "catalog");
      return;
    }
    bindCustomCredentialToProvider();
    const probeResult = await controller.probe({
      apiKey: apiKey.trim(),
      baseUrl: providerDraft.baseUrl,
      apiMode: providerDraft.apiMode,
    });
    if (revision !== probeUiRevision.current || requestFingerprint !== providerFingerprintRef.current) return;
    // 失败时保留请求前的列表和选择，只反馈错误。
    if (!probeResult) {
      toast.error(t("模型配置操作失败，请重试。"));
      return;
    }
    if (!probeResult.succeeded) {
      toast.error(t("未获取到可用模型，请检查API Key是否正确或有效"));
      return;
    }
    applyModelOptions(probeResult.models.map((id) => ({ id, name: id, source: "live" as const })), "live");
  };

  const handleAdd = async () => {
    const normalizedApiKey = apiKey.trim();
    if (!selectedModel || !normalizedApiKey || !credentialMatchesProvider) return;
    bindCustomCredentialToProvider();
    const nextSnapshot = await controller.add({
      apiKey: normalizedApiKey,
      model: selectedModel,
      purpose,
      // 手输的模型 ID 未经探测验证，写入 discover_models=false 让 Hermes 以配置内列表为权威。
      discoverModels: category === "custom"
        ? modelOptions.some((modelOption) => modelOption.id === selectedModelId)
        : activeProvider?.discoveryStrategy !== "catalog",
    });
    if (!nextSnapshot) return;
    setApiKey("");
    setApiKeyTarget("");
    setShowApiKey(false);
    restoreCatalogModelOptions();
    toast.success(t("模型已添加"));
  };

  const handleConnectivityTest = async () => {
    if (!selectedModel || !apiKey.trim() || !credentialMatchesProvider) return;
    bindCustomCredentialToProvider();
    const requestFingerprint = providerFingerprint;
    const revision = probeUiRevision.current;
    const selectedCustomModelWasDiscovered = category === "custom"
      && modelOptions.some((modelOption) => modelOption.id === selectedModelId);
    setConnectionResult(null);
    const result = await controller.testConnection({
      apiKey: apiKey.trim(),
      model: selectedModel,
      strategy: activeProvider?.discoveryStrategy === "catalog"
        || (category === "custom"
          && !selectedCustomModelWasDiscovered
          && supportsModelRequestProbe(providerDraft?.apiMode ?? ""))
        ? "model_request"
        : "model_list",
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

  if (controller.loading && !controller.snapshot) {
    return (
      <div className="space-y-5 pb-12 md:pb-16">
        {pageHeader}
        <ModelConfigLoading />
      </div>
    );
  }

  if (controller.loadError && !controller.snapshot) {
    return (
      <div className="space-y-5 pb-12 md:pb-16">
        {pageHeader}
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
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-12 md:pb-16" aria-busy={busy || controller.loading}>
      {pageHeader}
      <section className="overflow-hidden rounded-md border border-black/[0.06] bg-white shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
        <div className="flex items-start justify-between gap-4 border-b border-black/[0.06] px-5 py-4">
          <div className="flex items-center gap-1.5">
            <h2 ref={configuredHeadingRef} tabIndex={-1} className="text-base font-semibold text-black/85 focus:outline-none">
              {t("已配置模型")}
            </h2>
            <ModelActionTooltip content={t("你可以配置一个主模型，并可同时设置多个备用模型。")}>
              <CircleHelp className="size-3.5 text-black/35" aria-hidden="true" />
            </ModelActionTooltip>
          </div>
        </div>

        {controller.operationError && ["assign-primary", "assign-fallback", "remove-fallback"].includes(controller.operationErrorOperation ?? "") ? (
          <div className="mx-5 mt-4 rounded-md border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {displayError(controller.operationError, t("模型配置操作失败，请重试。"))}
          </div>
        ) : null}

        {configuredModels.length === 0 ? (
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
            {configuredProviderGroups.map((group, groupIndex) => {
              const expanded = effectiveExpandedConfiguredProviderKey === group.key;
              const primaryModel = group.models.find((model) => sameModel(snapshot.primary, model)) ?? null;
              const fallbackModels = group.models.filter((model) => (
                snapshot.fallbacks.some((candidate) => sameModel(candidate, model))
              ));
              const legacyCustomProvider = group.providerName.trim().toLowerCase() === "custom";
              const providerDisplayName = legacyCustomProvider
                ? (isBuiltInProviderGroup(group) ? t("内置模型") : t("自定义模型"))
                : group.providerName;
              const retainedSelectedModel = group.models.find(
                (model) => getHermesModelIdentity(model) === selectedConfiguredModelByProvider[group.key],
              );
              const selectedConfiguredModel = retainedSelectedModel
                ?? group.models.find((model) => sameModel(snapshot.primary, model))
                ?? group.models[0]
                ?? null;
              const selectedIdentity = selectedConfiguredModel
                ? getHermesModelIdentity(selectedConfiguredModel)
                : null;
              const groupPanelId = `configured-provider-${groupIndex}`;
              return (
                <li key={group.key}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 px-5 py-4 text-left hover:bg-black/[0.015] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#2F6BFF]"
                    aria-expanded={expanded}
                    aria-controls={groupPanelId}
                    onClick={() => setExpandedConfiguredProviderKey(expanded ? null : group.key)}
                  >
                    <ChevronDown
                      className={cn("size-4 shrink-0 text-black/35", !expanded && "-rotate-90")}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-black/85">
                      {providerDisplayName}
                    </span>
                    {primaryModel || fallbackModels.length > 0 ? (
                      <span className="flex max-w-[60%] shrink-0 flex-row flex-wrap items-center justify-end gap-1">
                        {primaryModel ? (
                          <Badge
                            variant="success"
                            className="justify-end whitespace-normal break-all text-right leading-tight"
                          >
                            {t("主模型：{{model}}", {
                              model: displayConfiguredModelName(primaryModel, autoModelDisplayName),
                            })}
                          </Badge>
                        ) : null}
                        {fallbackModels.length > 0 ? (
                          <Badge
                            variant="neutral"
                            className="justify-end whitespace-normal break-all border border-[var(--border-subtle)] text-right leading-tight"
                          >
                            {t("备用模型：{{models}}", {
                              models: fallbackModels
                                .map((model) => displayConfiguredModelName(model, autoModelDisplayName))
                                .join("、"),
                            })}
                          </Badge>
                        ) : null}
                      </span>
                    ) : null}
                  </button>

                  {expanded ? (
                    <div
                      id={groupPanelId}
                      role="group"
                      aria-label={`${providerDisplayName} ${t("已配置模型")}`}
                      className="border-t border-black/[0.06] bg-black/[0.015] px-4 py-4 sm:px-5"
                    >
                      <ul className="overflow-hidden rounded-md border border-black/[0.06] bg-white divide-y divide-black/[0.06]">
                        {group.models.map((model) => {
                          const primary = sameModel(snapshot.primary, model);
                          const fallback = snapshot.fallbacks.some((candidate) => sameModel(candidate, model));
                          const role = primary ? "primary" : fallback ? "fallback" : "idle";
                          const modelIdentity = getHermesModelIdentity(model);
                          return (
                            <li
                              key={modelIdentity}
                              className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                            >
                              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                                <input
                                  type="radio"
                                  name={`configured-model-${groupIndex}`}
                                  aria-label={displayConfiguredModelName(model, autoModelDisplayName)}
                                  value={modelIdentity}
                                  checked={selectedIdentity === modelIdentity}
                                  disabled={busy}
                                  onChange={() => setSelectedConfiguredModelByProvider((current) => ({
                                    ...current,
                                    [group.key]: modelIdentity,
                                  }))}
                                  className={cn(MODEL_RADIO_CLASS, "size-4")}
                                />
                                <span className="min-w-0">
                                  <span className="flex flex-wrap items-center gap-2">
                                    <span className="break-all text-sm font-normal text-black/85">
                                      {displayConfiguredModelName(model, autoModelDisplayName)}
                                    </span>
                                    {!model.catalogOnly ? (
                                      <Badge
                                        variant={primary ? "success" : "neutral"}
                                        className={cn("text-xs", fallback && "border border-[var(--border-subtle)]")}
                                      >
                                        {role === "primary"
                                          ? t("主模型")
                                          : role === "fallback"
                                            ? t("备用模型")
                                            : t("已添加")}
                                      </Badge>
                                    ) : null}
                                  </span>
                                </span>
                              </label>

                              <div className="flex flex-wrap items-center gap-2 pl-7 sm:pl-0">
                                <ModelActionTooltip content={primary ? t("当前模型已经是主模型") : undefined}>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="rounded-md text-xs font-normal"
                                  disabled={busy || model.requiresSetup === true || primary}
                                  onClick={() => void controller.assign(model, "primary")}
                                >
                                    {t("设为主模型")}
                                  </Button>
                                </ModelActionTooltip>
                                <ModelActionTooltip content={primary ? t("主模型不能同时设为备用模型") : undefined}>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="rounded-md text-xs font-normal"
                                    disabled={busy || primary}
                                    onClick={() => void (fallback
                                      ? controller.removeFallback(model)
                                      : controller.assign(model, "fallback"))}
                                  >
                                    {fallback ? t("取消备用") : t("设为备用模型")}
                                  </Button>
                                </ModelActionTooltip>
                                {!model.catalogOnly ? (
                                  <ModelActionTooltip content={primary ? t("无法删除主模型，请先切换至其他模型") : undefined}>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      className="size-8 rounded-md p-0 font-normal enabled:cursor-pointer"
                                      aria-label={t("删除")}
                                      disabled={busy || primary}
                                      onClick={() => {
                                        controller.clearOperationError();
                                        setDeleteTarget(model);
                                      }}
                                    >
                                      <Trash2 className="size-3.5" aria-hidden="true" />
                                    </Button>
                                  </ModelActionTooltip>
                                ) : null}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : null}
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
                    restoreCatalogModelOptions();
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
                    restoreCatalogModelOptions();
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
                    restoreCatalogModelOptions();
                  }}
                >
                  <SelectTrigger
                    id="custom-api-mode"
                    aria-label={t("兼容协议")}
                    className={MODEL_CONTROL_CLASS}
                    onPointerDownCapture={captureAgentSidebarPosition}
                    onKeyDownCapture={captureAgentSidebarPosition}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    position="popper"
                    className={MODEL_SELECT_CONTENT_CLASS}
                    style={MODEL_SELECT_CONTENT_STYLE}
                  >
                    <SelectItem value="chat_completions">
                      OpenAI Chat Completions
                    </SelectItem>
                    <SelectItem value="anthropic_messages">
                      Anthropic Messages
                    </SelectItem>
                    <SelectItem value="codex_responses">
                      OpenAI Responses
                    </SelectItem>
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
                  restoreCatalogModelOptions();
                }}
              >
                <SelectTrigger
                  ref={providerTriggerRef}
                  id="model-provider"
                  aria-label={category === "coding_plan" ? t("Coding Plan 套餐") : t("模型服务商")}
                  className={MODEL_CONTROL_CLASS}
                  onPointerDownCapture={captureAgentSidebarPosition}
                  onKeyDownCapture={captureAgentSidebarPosition}
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
            <label id="model-api-key-label" className="text-sm font-medium text-black/70" htmlFor="model-api-key">API Key</label>
            <div data-slot="model-api-key-control" className={compoundControlClassName}>
              <div className={cn("relative min-w-0", isGlobalRegion ? "h-12 w-full sm:h-full" : "flex-1")}>
                <Input
                  id="model-api-key"
                  type={showApiKey ? "text" : "password"}
                  autoComplete="new-password"
                  value={apiKey}
                  disabled={busy}
                  placeholder={t("请输入 API Key")}
                  className={cn(compoundFieldClassName, "pr-11")}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    setApiKeyTarget(credentialScope);
                    restoreCatalogModelOptions();
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
              {canRefreshModels ? (
                <Button
                  type="button"
                  variant="outline"
                  className={compoundActionClassName}
                  disabled={!canProbe || busy}
                  onClick={() => void handleProbe()}
                >
                  <ModelCompoundActionContent
                    idleLabel={t("获取可用模型")}
                    loadingLabel={t("获取中...")}
                    loading={controller.operation === "probe"}
                  />
                </Button>
              ) : null}
            </div>
            {activeProvider?.apiKeyUrl ? (
              <a
                className="inline-flex w-fit items-center gap-1 text-sm font-medium text-black/55 underline-offset-4 hover:text-black/80 hover:underline"
                href={activeProvider.apiKeyUrl}
                target="_blank"
                rel="noreferrer"
              >
                {t("点此获取 API Key")}
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            ) : null}
          </div>

          <div className={MODEL_FIELD_CLASS}>
            <label id="detected-model-label" className="text-sm font-medium text-black/70" htmlFor="detected-model">
              {t("模型")}
            </label>
            <div data-slot="model-option-control" className={compoundControlClassName}>
              {category === "custom" ? (
                // 自定义 endpoint 常常没有实现 /v1/models，探测结果只能作为建议，必须允许手动填写。
                <>
                  <Input
                    id="detected-model"
                    list={CUSTOM_MODEL_SUGGESTION_LIST_ID}
                    autoComplete="off"
                    value={selectedModelId}
                    disabled={busy}
                    placeholder={t("输入或选择模型")}
                    className={compoundFieldClassName}
                    onChange={(event) => {
                      setSelectedModelId(event.target.value);
                      setConnectionResult(null);
                      controller.clearOperationError();
                    }}
                  />
                  <datalist id={CUSTOM_MODEL_SUGGESTION_LIST_ID}>
                    {modelOptions.map((modelOption) => (
                      <option key={modelOption.id} value={modelOption.id}>{modelOption.name}</option>
                    ))}
                  </datalist>
                </>
              ) : (
                <Select
                  value={effectiveSelectedModelId}
                  disabled={busy || availableModelOptions.length === 0}
                  onValueChange={(value) => {
                    setSelectedModelId(value);
                    setConnectionResult(null);
                    controller.clearOperationError();
                  }}
                >
                  <SelectTrigger
                    id="detected-model"
                    aria-label={t("模型")}
                    className={compoundFieldClassName}
                    onPointerDownCapture={captureAgentSidebarPosition}
                    onKeyDownCapture={captureAgentSidebarPosition}
                  >
                    <SelectValue placeholder={availableModelOptions.length > 0 ? t("请选择模型") : t("暂无可用模型")} />
                  </SelectTrigger>
                  <SelectContent
                    position="popper"
                    className={MODEL_SELECT_CONTENT_CLASS}
                    style={MODEL_SELECT_CONTENT_STYLE}
                  >
                    {availableModelOptions.map((modelOption) => (
                      <SelectItem key={modelOption.id} value={modelOption.id}>
                        {modelOption.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button
                type="button"
                variant="outline"
                className={compoundActionClassName}
                disabled={!selectedModel || !apiKey.trim() || !credentialMatchesProvider || busy}
                onClick={() => void handleConnectivityTest()}
              >
                <ModelCompoundActionContent
                  idleLabel={t("检测模型状态")}
                  loadingLabel={t("检测中...")}
                  loading={controller.operation === "connectivity-probe"}
                />
              </Button>
            </div>
          </div>

          <OptionGroup<ConfigurePurpose>
            label={t("选择用途")}
            name="model-purpose"
            value={purpose}
            onValueChange={setPurpose}
            optionsClassName="sm:grid-cols-3"
            options={([
              { value: "primary", label: t("设为主模型"), disabled: busy },
              {
                value: "fallback",
                label: t("设为备用模型"),
                disabled: busy || selectedModelIsPrimary,
                describedBy: selectedModelIsPrimary ? "fallback-purpose-help" : undefined,
              },
              {
                value: "idle",
                label: t("仅添加"),
                disabled: busy || selectedModelIsPrimary,
                describedBy: selectedModelIsPrimary ? "primary-idle-purpose-help" : undefined,
              },
            ] satisfies Array<{
              value: ConfigurePurpose;
              label: string;
              disabled: boolean;
              describedBy?: string;
            }>)}
            help={selectedModelIsPrimary ? (
              <>
                <p id="fallback-purpose-help" className="lv-option-group__help">
                  {t("主模型不能同时设为备用模型。")}
                </p>
                <p id="primary-idle-purpose-help" className="sr-only">
                  {t("当前模型已经是主模型")}
                </p>
              </>
            ) : null}
          />

          {controller.operationError && ["connectivity-probe", "add"].includes(controller.operationErrorOperation ?? "") ? (
            <div aria-live="polite">
              <p className="mb-3 rounded-md border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                {displayError(controller.operationError, t("模型配置操作失败，请重试。"))}
              </p>
            </div>
          ) : null}

          <div className="flex justify-end border-t border-black/[0.06] pt-5">
            <Button
              type="button"
              className="rounded-md"
              disabled={!selectedModel || !apiKey.trim() || !credentialMatchesProvider || busy || (selectedModelIsPrimary && purpose !== "primary")}
              onClick={() => void handleAdd()}
            >
              {controller.operation === "add"
                ? <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                : null}
              {t("确认配置")}
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
              {deleteTarget && snapshot.fallbacks.some((model) => sameModel(model, deleteTarget))
                ? t("删除后将移除该备用模型配置。若这是该模型服务商下最后一个已添加模型，将同时移除该模型服务商。")
                : t("删除后将移除此模型配置。若这是该模型服务商下最后一个已添加模型，将同时移除该模型服务商。")}
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
