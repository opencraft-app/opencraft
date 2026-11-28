import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "@opencraft/i18n/react";
import type { ModelServicesSurfaceProps } from "@opencraft/design-system-web/valdi";
import { formatContextWindow, recognizeVendorFromUrl, type RecognizedProtocol } from "./vendor-recognition";

export interface AssetsModelGatewayConnection {
  id: string;
  name: string;
  catalogId?: string;
  kind: "api-key" | "subscription" | "platform";
  protocol?: string;
  baseUrl?: string;
  scope: "personal" | "team";
  owned: boolean;
  enabled: boolean;
  template: boolean;
  revision: number;
  models: { id: string; name: string; enabled: boolean; contextWindow?: number; maxTokens?: number }[];
}

export interface AssetsModelGatewayDocument {
  subscriptionAvailable?: boolean;
  actor: string;
  period: string;
  usedTokens: number;
  heldTokens: number;
  canManage: boolean;
  limit: { monthlyTokens: number; requestTokens: number; concurrency: number } | null;
  personalLimit: { monthlyTokens: number | null; revision: number };
  directory: AssetsModelGatewayConnection[];
}

const GATEWAY_PATH = "/__opencraft_model_gateway";
const gatewayReplicaByFetcher = new WeakMap<typeof fetch, AssetsModelGatewayDocument>();

export async function warmAssetsModelGateway(fetcher: typeof fetch = globalThis.fetch): Promise<void> {
  try {
    const response = await fetcher(GATEWAY_PATH, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) return;
    const next = (await response.json()) as AssetsModelGatewayDocument;
    if (typeof next.actor === "string" && Array.isArray(next.directory) && next.personalLimit) {
      gatewayReplicaByFetcher.set(fetcher, next);
    }
  } catch {
    /* Optional gateway warm-up; errors are handled on explicit interaction. */
  }
}

export function useAssetsModelGateway(fetcher: typeof fetch = globalThis.fetch, onManagePlatform?: () => void) {
  const intl = useIntl();
  const cached = gatewayReplicaByFetcher.get(fetcher) ?? null;
  const [available, setAvailable] = useState(() => cached !== null);
  const [doc, setDoc] = useState<AssetsModelGatewayDocument | null>(() => cached);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [protocol, setProtocol] = useState<RecognizedProtocol>("openai-completions");
  const [protocolTouched, setProtocolTouched] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<
    { id: string; name: string; contextWindow?: number; maxTokens?: number }[]
  >([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoverHint, setDiscoverHint] = useState("");
  const [customModelId, setCustomModelId] = useState("");
  const [contextWindowInput, setContextWindowInput] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [modelId, setModelId] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scope, setScope] = useState<"personal" | "team">("personal");
  const [consent, setConsent] = useState(false);
  const [connectionType, setConnectionType] = useState<"api-key" | "subscription">("api-key");
  const [login, setLogin] = useState<{
    sessionId: string;
    verificationUrl: string;
    userCode: string;
    expiresAt: number;
  } | null>(null);
  const [limitDraft, setLimitDraft] = useState("");
  const [limitOpen, setLimitOpen] = useState(false);
  const lifetime = useRef(0);
  const identity = useRef<string | null>(null);
  const pending = useRef(false);

  const apply = useCallback(
    (next: AssetsModelGatewayDocument) => {
      if (identity.current !== null && identity.current !== next.actor) {
        setLogin(null);
        setKey("");
        setName("");
        setAdding(false);
        setSelected(null);
        setScopeOpen(false);
        setLimitOpen(false);
      }
      identity.current = next.actor;
      gatewayReplicaByFetcher.set(fetcher, next);
      setDoc(next);
    },
    [fetcher],
  );

  const refresh = useCallback(async () => {
    const epoch = lifetime.current;
    try {
      const response = await fetcher(GATEWAY_PATH, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) {
        if (epoch === lifetime.current) {
          setAvailable(false);
        }
        return;
      }
      const next = (await response.json()) as AssetsModelGatewayDocument;
      if (typeof next.actor !== "string" || !Array.isArray(next.directory) || !next.personalLimit) {
        if (epoch === lifetime.current) setAvailable(false);
        return;
      }
      if (epoch === lifetime.current) {
        setAvailable(true);
        apply(next);
        setError("");
      }
    } catch {
      if (epoch === lifetime.current) setAvailable(false);
    }
  }, [apply, fetcher]);

  useEffect(() => {
    void refresh();
    return () => {
      lifetime.current++;
    };
  }, [refresh]);

  const write = useCallback(
    async (body: Record<string, unknown>, success?: (result: Record<string, unknown>) => void) => {
      if (pending.current) return;
      pending.current = true;
      setBusy(true);
      setError("");
      setMessage("");
      const epoch = lifetime.current;
      const actor = identity.current;
      try {
        const response = await fetcher(GATEWAY_PATH, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const result = (await response.json()) as Record<string, unknown>;
        if (!response.ok) {
          throw new Error(typeof result.error === "string" ? result.error : "Save failed");
        }
        const getResp = await fetcher(GATEWAY_PATH, { credentials: "same-origin", cache: "no-store" });
        const next = (await getResp.json()) as AssetsModelGatewayDocument;
        if (epoch !== lifetime.current) return;
        apply(next);
        if (next.actor !== actor) {
          setError(intl.formatMessage({ id: "modelServices.personal.tryAgain", defaultMessage: "Try again" }));
          return;
        }
        success?.(result);
        setMessage(intl.formatMessage({ id: "modelServices.personal.save", defaultMessage: "Save" }));
      } catch (err) {
        if (epoch === lifetime.current) setError((err as Error).message);
      } finally {
        pending.current = false;
        if (epoch === lifetime.current) setBusy(false);
      }
    },
    [apply, fetcher, intl],
  );

  const subscriptionResult = useCallback(
    (result: Record<string, unknown>) => {
      if (result.status === "complete") {
        setLogin(null);
        if (typeof result.providerId === "string") setSelected(result.providerId);
        setAdding(false);
      } else if (result.login && typeof result.login === "object") {
        setLogin(result.login as { sessionId: string; verificationUrl: string; userCode: string; expiresAt: number });
      } else if (result.status === "error") {
        setLogin(null);
        setError(intl.formatMessage({ id: "modelServices.personal.tryAgain", defaultMessage: "Try again" }));
      }
    },
    [intl],
  );

  useEffect(() => {
    if (!login) return;
    const timer = setInterval(() => {
      if (Date.now() >= login.expiresAt) {
        setLogin(null);
        return;
      }
      void write({ action: "subscription", operation: "poll", sessionId: login.sessionId }, subscriptionResult);
    }, 3000);
    return () => clearInterval(timer);
  }, [login, subscriptionResult, write]);

  const connections = doc?.directory ?? [];
  const templates = connections.filter((c) => c.template && c.models.length);
  const connection = connections.find((c) => c.id === selected) ?? connections.find((c) => c.owned) ?? connections[0];
  const template = templates.find((c) => c.id === templateId) ?? templates[0];
  const model = template?.models.find((m) => m.id === modelId) ?? template?.models[0];
  const visible = connections.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));

  const startAdd = () => {
    setAdding(true);
    setScopeOpen(false);
    setError("");
    setMessage("");
    setName("");
    setNameTouched(false);
    setBaseUrl("");
    setProtocol("openai-completions");
    setProtocolTouched(false);
    setDiscoveredModels([]);
    setDiscoverHint("");
    setCustomModelId("");
    setContextWindowInput("");
    setKey("");
  };

  const recognizedVendor = recognizeVendorFromUrl(baseUrl);
  const handleBaseUrlChange = (nextUrl: string) => {
    setBaseUrl(nextUrl);
    setDiscoverHint("");
    const recognized = recognizeVendorFromUrl(nextUrl);
    if (recognized) {
      if (!nameTouched) setName(recognized.vendorName);
      if (!protocolTouched) setProtocol(recognized.protocol);
    }
  };

  const discoverModels = async () => {
    if (discovering || !baseUrl.trim()) return;
    setDiscovering(true);
    setError("");
    setDiscoverHint("");
    try {
      const response = await fetcher(GATEWAY_PATH, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "discover", baseUrl, protocol, apiKey: key }),
      });
      const result = (await response.json()) as {
        models?: { id: string; name: string; contextWindow?: number; maxTokens?: number }[];
        note?: string;
        error?: string;
      };
      if (!response.ok) throw new Error(result.error ?? "Discovery failed");
      const found = result.models ?? [];
      setDiscoveredModels(found);
      if (found.length > 0) {
        const first = found[0]!;
        setCustomModelId(first.id);
        setContextWindowInput(first.contextWindow ? String(first.contextWindow) : "");
        setDiscoverHint(
          intl.formatMessage({ id: "modelServices.capabilities.metadata", defaultMessage: "Get known capabilities" }) +
            ` (${found.length})`,
        );
      } else {
        setDiscoverHint(
          result.note ??
            intl.formatMessage({
              id: "modelServices.personal.noModelServicesAreCurrentlyAvailable",
              defaultMessage: "No model services are currently available.",
            }),
        );
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDiscovering(false);
    }
  };

  const scopeLabel = (c: AssetsModelGatewayConnection) => {
    const vendor = c.baseUrl ? recognizeVendorFromUrl(c.baseUrl)?.vendorName : undefined;
    const access = c.owned
      ? c.scope === "personal"
        ? intl.formatMessage({ id: "modelServices.personal.onlyMe", defaultMessage: "Only me" })
        : intl.formatMessage({ id: "modelServices.personal.sharedForUse", defaultMessage: "Shared for use" })
      : intl.formatMessage({ id: "modelServices.personal.providedByPlatform", defaultMessage: "Provided by platform" });
    return vendor ? `${vendor} · ${access}` : access;
  };

  const urlRegisterMode = Boolean(doc?.canManage);
  const canAdd = Boolean(doc && !busy && (urlRegisterMode || templates.length > 0 || doc.subscriptionAvailable));

  const viewModel: ModelServicesSurfaceProps = {
    hideHeader: true,
    title: intl.formatMessage({ id: "modelServices.personal.modelServices", defaultMessage: "Model services" }),
    addLabel: intl.formatMessage({ id: "modelServices.personal.add", defaultMessage: "Add" }),
    addDisabled: !canAdd,
    managePlatformLabel: intl.formatMessage({
      id: "modelServices.personal.managePlatformConnections",
      defaultMessage: "Manage platform connections",
    }),
    showManagePlatform: Boolean(doc?.canManage && onManagePlatform),
    loading: !doc && !error,
    loadingText: intl.formatMessage({
      id: "modelServices.personal.loadingModelConnections",
      defaultMessage: "Loading model connections…",
    }),
    tryAgainLabel: intl.formatMessage({ id: "modelServices.personal.tryAgain", defaultMessage: "Try again" }),
    errorMessage: error || undefined,
    statusMessage: message || undefined,
    busy,
    savingText: intl.formatMessage({ id: "modelServices.personal.saving", defaultMessage: "Saving…" }),
    searchQuery: query,
    searchPlaceholder: intl.formatMessage({
      id: "modelServices.personal.searchConnections",
      defaultMessage: "Search connections",
    }),
    clearSearchLabel: intl.formatMessage({ id: "settings.remoteAccess.clearInput", defaultMessage: "Clear" }),
    myModelsTitle: intl.formatMessage({ id: "modelServices.personal.myModels", defaultMessage: "My models" }),
    noPersonalConnectionsText: intl.formatMessage({
      id: "modelServices.personal.noPersonalConnectionsYet",
      defaultMessage: "No personal connections yet",
    }),
    platformModelsTitle: intl.formatMessage({
      id: "modelServices.personal.providedByPlatform",
      defaultMessage: "Provided by platform",
    }),
    personalConnections: visible
      .filter((c) => c.owned)
      .map((c) => ({
        id: c.id,
        name: c.name,
        scopeLabel: scopeLabel(c),
        owned: true,
        selected: !adding && connection?.id === c.id,
      })),
    platformConnections: visible
      .filter((c) => !c.owned)
      .map((c) => ({
        id: c.id,
        name: c.name,
        scopeLabel: scopeLabel(c),
        owned: false,
        selected: !adding && connection?.id === c.id,
      })),
    adding,
    addTitle: intl.formatMessage({ id: "modelServices.personal.addMyConnection", defaultMessage: "Add my connection" }),
    subscriptionAvailable: doc?.subscriptionAvailable,
    connectionMethodLabel: intl.formatMessage({
      id: "modelServices.personal.connectionMethod",
      defaultMessage: "Connection method",
    }),
    connectionType,
    connectionTypeOptions: [
      {
        id: "api-key",
        title: intl.formatMessage({ id: "modelServices.personal.enterAnAPIKey", defaultMessage: "Enter an API key" }),
      },
      {
        id: "subscription",
        title: intl.formatMessage({
          id: "modelServices.personal.signInToACodexSubscription",
          defaultMessage: "Sign in to a Codex subscription",
        }),
      },
    ],
    subscriptionTitle: intl.formatMessage({
      id: "modelServices.personal.myCodexSubscription",
      defaultMessage: "My Codex subscription",
    }),
    subscriptionDescription: intl.formatMessage({
      id: "modelServices.personal.onlyYouAndYourAssistantsCanUse",
      defaultMessage:
        "Only you and your assistants can use this subscription. Available allowance is determined by the provider.",
    }),
    subscriptionLoginCode: login?.userCode,
    subscriptionLoginHint: login
      ? intl.formatMessage({
          id: "modelServices.personal.connectsAutomaticallyAfterSignIn",
          defaultMessage: "Connects automatically after sign-in.",
        })
      : undefined,
    signInAndConnectLabel: intl.formatMessage({
      id: "modelServices.personal.signInAndConnect",
      defaultMessage: "Sign in and connect",
    }),
    nameLabel: intl.formatMessage({ id: "modelServices.personal.name", defaultMessage: "Name" }),
    namePlaceholder: intl.formatMessage({
      id: "modelServices.personal.forExampleMyCodingModel",
      defaultMessage: "For example: My coding model",
    }),
    nameValue: name,
    urlRegisterMode,
    baseUrlLabel: intl.formatMessage({
      id: "modelServices.personal.serviceAddress",
      defaultMessage: "Service address",
    }),
    baseUrlPlaceholder: "https://api.deepseek.com",
    baseUrlValue: baseUrl,
    recognizedVendorText: recognizedVendor
      ? `${recognizedVendor.vendorName} · ${recognizedVendor.protocol}${recognizedVendor.normalizedBaseUrl ? ` · ${recognizedVendor.normalizedBaseUrl}` : ""}`
      : undefined,
    protocolLabel: intl.formatMessage({
      id: "modelServices.personal.connectionMethod",
      defaultMessage: "Connection method",
    }),
    protocolValue: protocol,
    protocolOptions: [
      { id: "openai-completions", title: "OpenAI Completions" },
      { id: "openai-responses", title: "OpenAI Responses" },
      { id: "anthropic-messages", title: "Anthropic Messages" },
    ],
    discoverLabel: intl.formatMessage({
      id: "modelServices.capabilities.metadata",
      defaultMessage: "Get known capabilities",
    }),
    discovering,
    discoverHint: discoverHint || undefined,
    modelIdLabel: intl.formatMessage({ id: "modelServices.personal.model", defaultMessage: "Model" }),
    modelIdPlaceholder: "deepseek-chat / gpt-4.1 / claude-sonnet-4-5",
    modelIdValue: customModelId,
    contextWindowLabel: intl.formatMessage({
      id: "modelServices.capabilities.context",
      defaultMessage: "Context window",
    }),
    contextWindowPlaceholder: "128000",
    contextWindowValue: contextWindowInput,
    serviceLabel: intl.formatMessage({ id: "modelServices.personal.service", defaultMessage: "Service" }),
    serviceValue: template?.id ?? "",
    serviceOptions: templates.map((c) => ({ id: c.id, title: c.name })),
    modelLabel: intl.formatMessage({ id: "modelServices.personal.model", defaultMessage: "Model" }),
    modelValue: urlRegisterMode ? customModelId : (model?.id ?? ""),
    modelOptions: urlRegisterMode
      ? discoveredModels.map((m) => ({
          id: m.id,
          title: m.contextWindow ? `${m.name} (${formatContextWindow(m.contextWindow)})` : m.name,
        }))
      : (template?.models ?? []).map((m) => ({ id: m.id, title: m.name })),
    apiKeyLabel: intl.formatMessage({ id: "modelServices.personal.apiKey", defaultMessage: "API key" }),
    apiKeyBaseUrl: template?.baseUrl,
    apiKeyValue: key,
    availableToLabel: intl.formatMessage({ id: "modelServices.personal.availableTo", defaultMessage: "Available to" }),
    availableToHint: intl.formatMessage({
      id: "modelServices.personal.youAndYourAssistantsCanUseThis",
      defaultMessage: "You and your assistants can use this connection, but other people's tasks cannot.",
    }),
    onlyMeLabel: intl.formatMessage({ id: "modelServices.personal.onlyMe", defaultMessage: "Only me" }),
    saveLabel: intl.formatMessage({ id: "modelServices.personal.save", defaultMessage: "Save" }),
    saveDisabled: urlRegisterMode
      ? busy || !name.trim() || !key.trim() || !recognizedVendor || !customModelId.trim()
      : busy || !name.trim() || !key.trim() || !template || !model,
    cancelLabel: intl.formatMessage({ id: "modelServices.personal.cancel", defaultMessage: "Cancel" }),
    hasSelectedConnection: Boolean(doc && connection),
    selectedConnectionName: connection?.name,
    selectedConnectionStatus: connection
      ? `${connection.owned ? intl.formatMessage({ id: "modelServices.personal.connectionConfigured", defaultMessage: "Connection configured" }) : intl.formatMessage({ id: "modelServices.personal.providedByPlatform", defaultMessage: "Provided by platform" })} · ${connection.enabled ? intl.formatMessage({ id: "modelServices.personal.enabled", defaultMessage: "Enabled" }) : intl.formatMessage({ id: "modelServices.personal.notEnabled", defaultMessage: "Not enabled" })}`
      : undefined,
    selectedConnectionOwned: connection?.owned,
    selectedConnectionSubscription: connection?.kind === "subscription",
    selectedConnectionScopeText: connection
      ? connection.scope === "personal"
        ? intl.formatMessage({ id: "modelServices.personal.onlyMe", defaultMessage: "Only me" })
        : intl.formatMessage({
            id: "modelServices.personal.usersOnThisPlatform",
            defaultMessage: "Users on this platform",
          })
      : undefined,
    scopeOpen,
    scopeDraft: scope,
    scopeOptions: [
      { id: "personal", title: intl.formatMessage({ id: "modelServices.personal.onlyMe", defaultMessage: "Only me" }) },
      {
        id: "team",
        title: intl.formatMessage({
          id: "modelServices.personal.usersOnThisPlatform",
          defaultMessage: "Users on this platform",
        }),
      },
    ],
    scopeConsent: consent,
    scopeTeamWarning: intl.formatMessage({
      id: "modelServices.personal.otherPeopleCanSelectThisConnectionUpstream",
      defaultMessage:
        "Other people can select this connection. Upstream API charges are still billed to the account that owns your key.",
    }),
    scopeAllowOthersLabel: intl.formatMessage({
      id: "modelServices.personal.allowOthersToUse",
      defaultMessage: "Allow others to use",
    }),
    scopeSaveDisabled: busy || !connection || scope === connection.scope || (scope === "team" && !consent),
    changeLabel: intl.formatMessage({ id: "modelServices.personal.change", defaultMessage: "Change" }),
    modelsTitle: intl.formatMessage({ id: "modelServices.personal.model", defaultMessage: "Model" }),
    selectedModels: (connection?.models ?? []).map((m) => {
      const ctx = formatContextWindow(m.contextWindow);
      const status =
        connection?.enabled && m.enabled
          ? intl.formatMessage({ id: "modelServices.personal.available", defaultMessage: "Available" })
          : intl.formatMessage({ id: "modelServices.personal.notEnabled", defaultMessage: "Not enabled" });
      return {
        id: m.id,
        name: m.name,
        statusLabel: ctx ? `${ctx} · ${status}` : status,
      };
    }),
    advancedTitle: intl.formatMessage({
      id: "modelServices.personal.advancedSettings",
      defaultMessage: "Advanced settings",
    }),
    endpointLabel:
      connection?.kind === "subscription"
        ? intl.formatMessage({ id: "modelServices.personal.connectionMethod", defaultMessage: "Connection method" })
        : intl.formatMessage({ id: "modelServices.personal.serviceAddress", defaultMessage: "Service address" }),
    endpointValue: connection
      ? connection.kind === "subscription"
        ? intl.formatMessage({
            id: "modelServices.personal.subscriptionSignInOnlyMe",
            defaultMessage: "Subscription sign-in · Only me",
          })
        : connection.baseUrl
      : undefined,
    disableLabel: intl.formatMessage({
      id: "modelServices.personal.disableConnection",
      defaultMessage: "Disable connection",
    }),
    disableDescription: intl.formatMessage({
      id: "modelServices.personal.stopsFutureCallsRequestsAlreadySentWill",
      defaultMessage: "Stops future calls. Requests already sent will still be billed.",
    }),
    disableActionLabel: intl.formatMessage({ id: "modelServices.personal.disable", defaultMessage: "Disable" }),
    emptyDirectoryText: intl.formatMessage({
      id: "modelServices.personal.noModelServicesAreCurrentlyAvailable",
      defaultMessage: "No model services are currently available.",
    }),
    usageTitle: intl.formatMessage({
      id: "modelServices.personal.myConnectionUsage",
      defaultMessage: "My connection usage",
    }),
    usedThisMonthLabel: intl.formatMessage({
      id: "modelServices.personal.usedThisMonth",
      defaultMessage: "Used this month",
    }),
    usedThisMonthValue: doc
      ? `${doc.usedTokens.toLocaleString()} ${intl.formatMessage({ id: "modelServices.personal.tokens", defaultMessage: "tokens" })}`
      : "0",
    heldTokensLabel: intl.formatMessage({
      id: "modelServices.personal.processingOrUnconfirmed",
      defaultMessage: "Processing or unconfirmed",
    }),
    heldTokensValue:
      doc && doc.heldTokens > 0
        ? `${doc.heldTokens.toLocaleString()} ${intl.formatMessage({ id: "modelServices.personal.tokens", defaultMessage: "tokens" })}`
        : undefined,
    usageLimitLabel: intl.formatMessage({ id: "modelServices.personal.usageLimit", defaultMessage: "Usage limit" }),
    usageLimitDescription: intl.formatMessage({
      id: "modelServices.personal.controlsFutureRequestsByTokenCountNot",
      defaultMessage:
        "Controls future requests by token count, not by monetary amount. A single request may exceed its reservation.",
    }),
    usageLimitValue: doc?.limit
      ? intl.formatMessage(
          { id: "modelServices.personal.monthlyTokens", defaultMessage: "{count} tokens / month" },
          { count: Math.min(doc.limit.monthlyTokens, doc.personalLimit.monthlyTokens ?? Infinity).toLocaleString() },
        )
      : intl.formatMessage({
          id: "modelServices.personal.noPlatformAllowanceConfigured",
          defaultMessage: "No platform allowance configured",
        }),
    canEditLimit: Boolean(doc?.limit),
    limitOpen,
    limitDraft,
    limitMaxLabel: intl.formatMessage({
      id: "modelServices.personal.maximumMonthlyUsage",
      defaultMessage: "Maximum monthly usage",
    }),
    limitSaveLabel: intl.formatMessage({ id: "modelServices.personal.saveLimit", defaultMessage: "Save limit" }),
    limitSaveDisabled:
      busy || limitDraft.trim() === "" || !Number.isSafeInteger(Number(limitDraft)) || Number(limitDraft) < 0,
    onSearchChange: setQuery,
    onStartAdd: startAdd,
    onCancelAdd: () => {
      if (login) {
        void write({ action: "subscription", operation: "cancel", sessionId: login.sessionId }, () => {
          setLogin(null);
          setAdding(false);
        });
      } else {
        setAdding(false);
        setKey("");
      }
    },
    onManagePlatform,
    onRefresh: () => void refresh(),
    onSelectConnection: (id) => {
      setSelected(id);
      setAdding(false);
      setScopeOpen(false);
      setError("");
      setMessage("");
    },
    onConnectionTypeChange: setConnectionType,
    onStartSubscription: () => void write({ action: "subscription", operation: "start" }, subscriptionResult),
    onNameChange: (nextName) => {
      setNameTouched(true);
      setName(nextName);
    },
    onBaseUrlChange: handleBaseUrlChange,
    onProtocolChange: (nextProtocol) => {
      setProtocolTouched(true);
      setProtocol(nextProtocol as RecognizedProtocol);
    },
    onDiscoverModels: () => void discoverModels(),
    onModelIdChange: setCustomModelId,
    onContextWindowChange: setContextWindowInput,
    onServiceChange: (nextId) => {
      setTemplateId(nextId);
      setModelId("");
      setKey("");
    },
    onModelChange: (nextModel) => {
      if (urlRegisterMode) {
        setCustomModelId(nextModel);
        const found = discoveredModels.find((m) => m.id === nextModel);
        if (found?.contextWindow) setContextWindowInput(String(found.contextWindow));
      } else {
        setModelId(nextModel);
      }
    },
    onApiKeyChange: setKey,
    onSaveConnection: () => {
      if (urlRegisterMode) {
        if (!recognizedVendor || !customModelId.trim()) return;
        const parsedCtx = Number(contextWindowInput.trim());
        const ctx = Number.isSafeInteger(parsedCtx) && parsedCtx > 0 ? parsedCtx : undefined;
        const modelEntry = discoveredModels.find((m) => m.id === customModelId.trim());
        void write(
          {
            action: "register",
            name: name.trim(),
            vendorId: recognizedVendor.vendorId,
            baseUrl: recognizedVendor.normalizedBaseUrl,
            protocol,
            apiKey: key,
            scope: "personal",
            models: [
              {
                id: customModelId.trim(),
                name: modelEntry?.name ?? customModelId.trim(),
                ...(ctx ? { contextWindow: ctx } : {}),
              },
            ],
          },
          (result) => {
            setKey("");
            setName("");
            if (typeof result.providerId === "string") setSelected(result.providerId);
            setAdding(false);
          },
        );
        return;
      }
      if (template && model) {
        void write(
          {
            action: "contribute",
            name,
            apiKey: key,
            baseUrl: template.baseUrl,
            protocol: template.protocol,
            model: model.id,
            scope: "personal",
          },
          (result) => {
            setKey("");
            setName("");
            if (typeof result.providerId === "string") setSelected(result.providerId);
            setAdding(false);
          },
        );
      }
    },
    onToggleScope: () => {
      if (busy || !connection) return;
      const next = !scopeOpen;
      setScopeOpen(next);
      if (next) {
        setScope(connection.scope);
        setConsent(false);
      }
    },
    onScopeDraftChange: (nextScope) => {
      setScope(nextScope);
      setConsent(false);
    },
    onScopeConsentChange: setConsent,
    onSaveScope: () =>
      connection &&
      void write(
        {
          action: "scope",
          provider: connection.id,
          scope,
          revision: connection.revision,
          shareWithTeam: scope === "team",
        },
        () => setScopeOpen(false),
      ),
    onDisableConnection: () =>
      connection && void write({ action: "withdraw", provider: connection.id }, () => setSelected(null)),
    onToggleLimit: () => {
      if (!doc) return;
      setLimitDraft(String(doc.personalLimit.monthlyTokens ?? doc.limit?.monthlyTokens ?? 0));
      setLimitOpen((v) => !v);
    },
    onLimitDraftChange: setLimitDraft,
    onSaveLimit: () =>
      doc &&
      void write(
        { action: "personalLimit", monthlyTokens: Number(limitDraft), revision: doc.personalLimit.revision },
        () => setLimitOpen(false),
      ),
  };

  return {
    available,
    canAdd,
    startAdd,
    refresh,
    viewModel,
  };
}
