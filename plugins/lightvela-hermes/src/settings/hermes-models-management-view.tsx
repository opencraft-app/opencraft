import { Brain, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  SettingsActions,
  SettingsButton,
  SettingsGroup,
  SettingsListItem,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsTextInput,
} from "@opencraft/extension-react";

import type { LightVelaAccountService } from "../account/lightvela-account-service";
import type { HermesConfiguredModel } from "../management/models/model-config-client";
import { adaptProductModelProviders } from "../management/models/product-provider-adapter";
import { useModelProviders } from "../management/models/use-model-providers";
import { getHermesModelIdentity, useModelConfig } from "../management/models/use-model-config";

type Purpose = "primary" | "fallback" | "idle";

function stableProviderHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function customProviderKey(name: string, baseUrl: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `lightvela-custom-${slug || "provider"}-${stableProviderHash(baseUrl.trim().toLowerCase())}`;
}

function managedProviderKey(value: string) {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.startsWith("lightvela-") ? slug : `lightvela-${slug || "provider"}`;
}

function sameModel(left: HermesConfiguredModel | null | undefined, right: HermesConfiguredModel) {
  return !!left && getHermesModelIdentity(left) === getHermesModelIdentity(right);
}

export function HermesModelsManagementView({ account, botId }: {
  readonly account: LightVelaAccountService;
  readonly botId: string;
}) {
  const controller = useModelConfig({ botId, execDebugCommand: account.execDebugCommand.bind(account) });
  const region = account.getSnapshot().region;
  const liveProviderSource = useModelProviders({ isI18n: region === "intl", useEnglish: true });
  const providerOptions = useMemo(() => adaptProductModelProviders(liveProviderSource), [liveProviderSource]);
  const [providerSource, setProviderSource] = useState("custom");
  const [providerName, setProviderName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiMode, setApiMode] = useState("chat_completions");
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [purpose, setPurpose] = useState<Purpose>("primary");
  const [probeModels, setProbeModels] = useState<string[]>([]);
  const [probeMessage, setProbeMessage] = useState<string | null>(null);
  const activeProvider = providerSource === "custom" ? null : providerOptions.find((item) => item.providerKey === providerSource) ?? null;
  const busy = controller.operation !== null;
  const configured = useMemo(
    () => (controller.snapshot?.configuredModels ?? []).filter((model) => model.id.trim() && model.requiresSetup !== true),
    [controller.snapshot],
  );
  const model: HermesConfiguredModel | null = providerName.trim() && baseUrl.trim() && modelId.trim()
    ? {
        providerKey: activeProvider ? managedProviderKey(activeProvider.providerKey) : customProviderKey(providerName, baseUrl),
        providerName: providerName.trim(),
        baseUrl: baseUrl.trim(),
        routeBaseUrl: baseUrl.trim(),
        apiMode,
        id: modelId.trim(),
        keyEnv: "",
      }
    : null;

  useEffect(() => {
    setApiKey("");
    setProbeMessage(null);
    if (providerSource === "custom") {
      setProviderName("");
      setBaseUrl("");
      setApiMode("chat_completions");
      setProbeModels([]);
      setModelId("");
      return;
    }
    const provider = providerOptions.find((item) => item.providerKey === providerSource);
    if (!provider) return;
    setProviderName(provider.providerName);
    setBaseUrl(provider.baseUrl);
    setApiMode(provider.apiMode);
    setProbeModels((provider.catalogModels ?? []).map((item) => item.id));
    setModelId(provider.catalogModels?.[0]?.id ?? "");
  }, [providerOptions, providerSource]);

  const probe = async () => {
    setProbeMessage(null);
    if (activeProvider?.discoveryStrategy === "catalog") {
      const ids = (activeProvider.catalogModels ?? []).map((item) => item.id);
      setProbeModels(ids);
      if (!ids.includes(modelId) && ids[0]) setModelId(ids[0]);
      setProbeMessage(`${ids.length} catalogue models available.`);
      return;
    }
    const result = await controller.probe({ apiKey: apiKey.trim(), baseUrl: baseUrl.trim(), apiMode });
    if (!result) return;
    setProbeModels(result.models);
    if (result.models[0]) setModelId(result.models[0]);
    setProbeMessage(result.succeeded ? `${result.models.length} models discovered.` : "Provider probe failed.");
  };

  const add = async () => {
    if (!model || !apiKey.trim()) return;
    const result = await controller.add({ apiKey: apiKey.trim(), model, purpose, discoverModels: activeProvider?.discoveryStrategy !== "catalog" && probeModels.includes(model.id) });
    if (result) {
      setApiKey("");
      setProbeModels([]);
      setProbeMessage("Model added.");
    }
  };

  return (
    <>
      <SettingsSection
        title="Configured models"
        icon={<Brain size={16} />}
        description="One primary model and an ordered fallback set are owned by this Agent."
        action={<SettingsButton type="button" variant="ghost" disabled={controller.loading || busy} onClick={() => void controller.reload()}><RefreshCw size={14} /> Refresh</SettingsButton>}
      >
        {controller.loadError ? <SettingsNotice tone="error">{controller.loadError}</SettingsNotice> : null}
        {controller.operationError ? <SettingsNotice tone="error">{controller.operationError}</SettingsNotice> : null}
        {controller.loading && !controller.snapshot ? <SettingsNotice>Reading Hermes model configuration…</SettingsNotice> : null}
        <SettingsGroup>
          {configured.length === 0 && !controller.loading ? <SettingsNotice>No configured models.</SettingsNotice> : null}
          {configured.map((item) => {
            const primary = sameModel(controller.snapshot?.primary, item);
            const fallback = (controller.snapshot?.fallbacks ?? []).some((candidate) => sameModel(candidate, item));
            return (
              <SettingsListItem
                key={getHermesModelIdentity(item)}
                icon={<Brain size={15} />}
                label={item.id}
                description={`${item.providerName} · ${item.apiMode}`}
                metadata={`${primary ? "Primary" : fallback ? "Fallback" : "Available"} · ${item.routeBaseUrl ?? item.baseUrl}`}
                actions={(
                  <>
                    {!primary ? <SettingsButton type="button" variant="ghost" disabled={busy} onClick={() => void controller.assign(item, "primary")}>Primary</SettingsButton> : null}
                    {!fallback ? <SettingsButton type="button" variant="ghost" disabled={busy} onClick={() => void controller.assign(item, "fallback")}>Fallback</SettingsButton> : <SettingsButton type="button" variant="ghost" disabled={busy} onClick={() => void controller.removeFallback(item)}>Unfallback</SettingsButton>}
                    {item.canDelete !== false ? <SettingsButton aria-label={`Delete ${item.id}`} type="button" variant="ghost" disabled={busy || primary} onClick={() => void controller.remove(item)}><Trash2 size={14} /></SettingsButton> : null}
                  </>
                )}
              />
            );
          })}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Add model" description="Credentials are sealed in-browser before the Hermes configuration command receives them.">
        <SettingsGroup>
          <SettingsRow label="Provider catalogue" htmlFor="hermes-provider-source"><SettingsSelect id="hermes-provider-source" value={providerSource} onChange={(event) => setProviderSource(event.currentTarget.value)}><option value="custom">Custom provider</option>{providerOptions.map((provider) => <option key={provider.providerKey} value={provider.providerKey}>{provider.category === "coding_plan" ? "Coding Plan · " : "API · "}{provider.providerName}</option>)}</SettingsSelect></SettingsRow>
          <SettingsRow label="Provider name" htmlFor="hermes-provider-name"><SettingsTextInput id="hermes-provider-name" value={providerName} onChange={(event) => setProviderName(event.currentTarget.value)} placeholder="OpenAI-compatible provider" /></SettingsRow>
          <SettingsRow label="Base URL" htmlFor="hermes-provider-url"><SettingsTextInput id="hermes-provider-url" value={baseUrl} onChange={(event) => setBaseUrl(event.currentTarget.value)} placeholder="https://api.example.com/v1" /></SettingsRow>
          <SettingsRow label="Protocol" htmlFor="hermes-provider-mode"><SettingsSelect id="hermes-provider-mode" value={apiMode} onChange={(event) => setApiMode(event.currentTarget.value)}><option value="chat_completions">Chat Completions</option><option value="codex_responses">Responses</option><option value="anthropic_messages">Anthropic Messages</option><option value="bedrock_converse">Bedrock Converse</option></SettingsSelect></SettingsRow>
          <SettingsRow label="API key" htmlFor="hermes-provider-key"><SettingsTextInput id="hermes-provider-key" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.currentTarget.value)} /></SettingsRow>
          <SettingsRow label="Model" htmlFor="hermes-provider-model"><><SettingsTextInput id="hermes-provider-model" list="hermes-probed-models" value={modelId} onChange={(event) => setModelId(event.currentTarget.value)} placeholder="model-id" /><datalist id="hermes-probed-models">{probeModels.map((id) => <option key={id} value={id} />)}</datalist></></SettingsRow>
          <SettingsRow label="Purpose" htmlFor="hermes-provider-purpose"><SettingsSelect id="hermes-provider-purpose" value={purpose} onChange={(event) => setPurpose(event.currentTarget.value as Purpose)}><option value="primary">Primary model</option><option value="fallback">Fallback model</option><option value="idle">Add only</option></SettingsSelect></SettingsRow>
        </SettingsGroup>
        {probeMessage ? <SettingsNotice tone={probeModels.length ? "success" : "neutral"}>{probeMessage}</SettingsNotice> : null}
        <SettingsActions align="between">
          <SettingsButton type="button" disabled={busy || !apiKey.trim() || !baseUrl.trim()} onClick={() => void probe()}>{controller.operation === "probe" ? "Checking…" : "Check model status"}</SettingsButton>
          <SettingsButton type="button" variant="primary" disabled={busy || !model || !apiKey.trim()} onClick={() => void add()}>{controller.operation === "add" ? "Adding…" : "Confirm"}</SettingsButton>
        </SettingsActions>
      </SettingsSection>
    </>
  );
}
