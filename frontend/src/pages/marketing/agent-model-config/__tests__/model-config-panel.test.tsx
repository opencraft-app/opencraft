import { generateKeyPairSync } from "node:crypto";

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AgentModelConfigPanel } from "../agent-model-config-panel";
import {
  HERMES_MODEL_CONFIG_JSON_END,
  HERMES_MODEL_CONFIG_JSON_START,
} from "../hermes-model-config-command";
import {
  type HermesConfiguredModel,
  type HermesModelConfigAction,
  type HermesModelConfigSnapshot,
  type ModelProviderOption,
} from "../model-config-client";

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string, options?: Record<string, unknown>) =>
    text.replace(/\{\{\s*([\w$]+)\s*\}\}/g, (raw, name: string) => {
      const value = options?.[name];
      return value === undefined || value === null ? raw : String(value);
    }),
}));

vi.mock("@/lib/toast", () => ({ toast: toastMocks }));

beforeAll(() => {
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { configurable: true, value: () => false },
    releasePointerCapture: { configurable: true, value: () => undefined },
    scrollIntoView: { configurable: true, value: () => undefined },
    setPointerCapture: { configurable: true, value: () => undefined },
  });
});

const primaryModel: HermesConfiguredModel = {
  id: "model-primary",
  providerKey: "lightvela-alpha",
  providerName: "Alpha API",
  baseUrl: "https://alpha.example.com/v1",
  apiMode: "chat_completions",
  keyEnv: "HERMES_CUSTOM_LIGHTVELA_ALPHA_API_KEY",
};

const fallbackModel: HermesConfiguredModel = {
  id: "model-fallback",
  providerKey: "lightvela-beta",
  providerName: "Beta API",
  baseUrl: "https://beta.example.com/v1",
  apiMode: "chat_completions",
  keyEnv: "HERMES_CUSTOM_LIGHTVELA_BETA_API_KEY",
};

const secondBetaModel: HermesConfiguredModel = {
  ...fallbackModel,
  id: "model-beta-2",
  routeBaseUrl: "https://beta.example.com/v1/",
};

const secondAlphaModel: HermesConfiguredModel = {
  ...primaryModel,
  id: "model-alpha-2",
  routeBaseUrl: "HTTPS://ALPHA.EXAMPLE.COM/v1/",
};

const idleModel: HermesConfiguredModel = {
  id: "model-idle",
  providerKey: "lightvela-gamma",
  providerName: "Gamma API",
  baseUrl: "https://gamma.example.com/v1",
  apiMode: "anthropic_messages",
  keyEnv: "HERMES_CUSTOM_LIGHTVELA_GAMMA_API_KEY",
};

const autoModel: HermesConfiguredModel = {
  id: "auto",
  providerKey: "lightvela-auto",
  providerName: "Auto API",
  baseUrl: "https://auto.example.com/v1",
  apiMode: "chat_completions",
  keyEnv: "HERMES_CUSTOM_LIGHTVELA_AUTO_API_KEY",
};

const providers: [ModelProviderOption, ModelProviderOption] = [
  {
    providerKey: "alpha",
    providerName: "Alpha API",
    category: "api",
    baseUrl: "https://alpha.example.com/v1",
    apiMode: "chat_completions",
    discoveryStrategy: "live",
    apiKeyUrl: "https://alpha.example.com/keys",
  },
  {
    providerKey: "beta-plan",
    providerName: "Beta Coding Plan",
    category: "coding_plan",
    baseUrl: "https://beta.example.com/v1",
    apiMode: "chat_completions",
    discoveryStrategy: "live",
  },
];
const fixedHyProvider: ModelProviderOption = {
  providerKey: "tencent_hy_token_plan",
  providerName: "腾讯云 Hy Token Plan（个人版）",
  category: "coding_plan",
  baseUrl: "https://api.lkeap.cloud.tencent.com/plan/v3",
  apiMode: "chat_completions",
  discoveryStrategy: "catalog",
  fixedModelSelection: true,
  catalogModels: [
    { id: "hy4-preview", name: "Hy4 Preview" },
    { id: "hy-next", name: "Hy Next" },
  ],
};
const { publicKey: testPublicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const successOutput = (snapshot: HermesModelConfigSnapshot) => [
  "transport-noise",
  HERMES_MODEL_CONFIG_JSON_START,
  JSON.stringify({ ok: true, snapshot }),
  HERMES_MODEL_CONFIG_JSON_END,
].join("\n");
const connectionOutput = (snapshot: HermesModelConfigSnapshot, success = true) => [
  HERMES_MODEL_CONFIG_JSON_START,
  JSON.stringify({
    ok: true,
    snapshot,
    connection: {
      success,
      provider: "lightvela-beta-plan",
      model: "shared-model",
      baseUrl: "https://beta.example.com/v1",
      timeMs: success ? 128 : undefined,
      errorCode: success ? 0 : 401,
      errorMessage: success ? undefined : "认证失败",
    },
  }),
  HERMES_MODEL_CONFIG_JSON_END,
].join("\n");
const preparationOutput = [
  HERMES_MODEL_CONFIG_JSON_START,
  JSON.stringify({ ok: true, credentialEnvelope: { token: "a".repeat(48), publicKey: testPublicKey } }),
  HERMES_MODEL_CONFIG_JSON_END,
].join("\n");

function decodeAction(command: string): HermesModelConfigAction {
  const match = command.match(/\$HERMES_PYTHON" - "([A-Za-z0-9+/=]+)"/);
  const encodedAction = match?.[1];
  if (!encodedAction) throw new Error("Missing action payload");
  return JSON.parse(Buffer.from(encodedAction, "base64").toString("utf8")) as HermesModelConfigAction;
}

function createRemote(
  initial: HermesModelConfigSnapshot,
  probedModels = ["model-new", "shared-model"],
  probeSucceeded = true,
) {
  let snapshot = structuredClone(initial);
  let readFailure = false;
  let nextFailure: HermesModelConfigAction["type"] | null = null;
  const actions: HermesModelConfigAction[] = [];

  const execDebugCommand = vi.fn(async (_botId: string, command: string) => {
    const action = decodeAction(command);
    actions.push(action);
    if (action.type === "read" && readFailure) {
      readFailure = false;
      return { status: "Failed", exitCode: 1, output: "temporary read failure" };
    }
    if (action.type === nextFailure) {
      nextFailure = null;
      return { status: "Failed", exitCode: 1, output: "temporary operation failure" };
    }
    if (action.type === "prepareCredentialEnvelope") {
      return { status: "Succeeded", exitCode: 0, output: preparationOutput };
    }
    if (action.type === "probe") {
      return {
        status: "SUCCESS",
        exitCode: 0,
        output: successOutput({ ...snapshot, probedModels, probeSucceeded }),
      };
    }
    if ((action.type as string) === "connectivityProbe") {
      return {
        status: "SUCCESS",
        exitCode: 0,
        output: connectionOutput(snapshot),
      };
    }
    if (action.type === "add") {
      const nextModel = action.model;
      snapshot.configuredModels = [
        ...snapshot.configuredModels.filter(
          (model) => model.providerKey !== nextModel.providerKey || model.id !== nextModel.id,
        ),
        nextModel,
      ];
      if (action.purpose === "primary") {
        snapshot.primary = nextModel;
        snapshot.fallbacks = snapshot.fallbacks.filter(
          (model) => model.providerKey !== nextModel.providerKey || model.id !== nextModel.id,
        );
      }
      if (action.purpose === "fallback" && !snapshot.fallbacks.some(
        (model) => model.providerKey === nextModel.providerKey && model.id === nextModel.id,
      )) snapshot.fallbacks = [...snapshot.fallbacks, nextModel];
      if (action.purpose === "idle") {
        snapshot.fallbacks = snapshot.fallbacks.filter(
          (model) => model.providerKey !== nextModel.providerKey || model.id !== nextModel.id,
        );
      }
    }
    if (action.type === "assign") {
      const exactModel = snapshot.configuredModels.find(
        (model) => model.providerKey === action.providerKey && model.id === action.modelId,
      ) ?? null;
      const providerModel = snapshot.configuredModels.find((model) => (
        model.providerKey === action.providerKey
        && (model.routeBaseUrl ?? model.baseUrl).replace(/\/+$/, "").toLowerCase()
          === (action.routeBaseUrl ?? action.baseUrl ?? "").replace(/\/+$/, "").toLowerCase()
      )) ?? null;
      const nextModel = exactModel ?? (providerModel
        ? {
            ...providerModel,
            id: action.modelId,
            baseUrl: action.baseUrl ?? providerModel.baseUrl,
            routeBaseUrl: action.routeBaseUrl ?? providerModel.routeBaseUrl,
          }
        : null);
      if (nextModel && !exactModel) snapshot.configuredModels = [...snapshot.configuredModels, nextModel];
      if (action.purpose === "primary") {
        snapshot.primary = nextModel;
        snapshot.fallbacks = snapshot.fallbacks.filter(
          (model) => model.providerKey !== action.providerKey || model.id !== action.modelId,
        );
      }
      if (action.purpose === "fallback" && nextModel && !snapshot.fallbacks.some(
        (model) => model.providerKey === action.providerKey && model.id === action.modelId,
      )) snapshot.fallbacks = [...snapshot.fallbacks, nextModel];
      if (action.purpose === "idle") {
        snapshot.fallbacks = snapshot.fallbacks.filter(
          (model) => model.providerKey !== action.providerKey || model.id !== action.modelId,
        );
      }
    }
    if (action.type === "removeFallback") {
      snapshot.fallbacks = snapshot.fallbacks.filter(
        (model) => model.providerKey !== action.providerKey || model.id !== action.modelId,
      );
    }
    if (action.type === "remove") {
      snapshot.configuredModels = snapshot.configuredModels.filter(
        (model) => model.providerKey !== action.providerKey || model.id !== action.modelId,
      );
      snapshot.fallbacks = snapshot.fallbacks.filter(
        (model) => model.providerKey !== action.providerKey || model.id !== action.modelId,
      );
    }
    return { status: "Succeeded", exitCode: 0, output: successOutput(snapshot) };
  });

  return {
    actions,
    execDebugCommand,
    failNextRead: () => {
      readFailure = true;
    },
    failNext: (type: HermesModelConfigAction["type"]) => {
      nextFailure = type;
    },
  };
}

function renderPanel(
  remote: ReturnType<typeof createRemote>,
  isGlobalRegion = false,
  providerOptions: ModelProviderOption[] = providers,
) {
  return render(
    <AgentModelConfigPanel
      botId="bot-1"
      execDebugCommand={remote.execDebugCommand}
      providers={providerOptions}
      isGlobalRegion={isGlobalRegion}
    />,
  );
}

async function selectOption(comboboxName: string, optionName: string) {
  await userEvent.click(screen.getByRole("combobox", { name: comboboxName }));
  await userEvent.click(await screen.findByRole("option", { name: optionName }));
}

describe("AgentModelConfigPanel", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("groups configured models by Provider and switches the primary model without re-adding credentials", async () => {
    const remote = createRemote({
      primary: primaryModel,
      fallbacks: [fallbackModel],
      configuredModels: [primaryModel, fallbackModel, secondBetaModel],
    });
    renderPanel(remote);

    const alphaTrigger = await screen.findByRole("button", { name: /Alpha API/ });
    const betaTrigger = screen.getByRole("button", { name: /Beta API/ });
    expect(alphaTrigger).toHaveAttribute("aria-expanded", "true");
    expect(alphaTrigger.closest("li")).toHaveTextContent("当前生效");
    expect(betaTrigger).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(betaTrigger);
    const betaGroup = screen.getByRole("group", { name: "Beta API 已配置模型" });
    expect(within(betaGroup).getByRole("radio", { name: "model-fallback" })).toBeChecked();
    await userEvent.click(within(betaGroup).getByRole("radio", { name: "model-beta-2" }));
    const secondBetaRow = screen.getByText("model-beta-2").closest("li") as HTMLElement;
    await userEvent.click(within(secondBetaRow).getByRole("button", { name: "设为主模型" }));

    await waitFor(() => expect(screen.getByRole("button", { name: /Beta API/ }).closest("li")).toHaveTextContent("当前生效"));
    expect(within(screen.getByRole("group", { name: "Beta API 已配置模型" })).getByText("model-beta-2").closest("li")).toHaveTextContent("主模型");
    expect(remote.actions.filter((action) => action.type === "assign")).toEqual([
      expect.objectContaining({
        type: "assign",
        providerKey: secondBetaModel.providerKey,
        modelId: secondBetaModel.id,
        baseUrl: secondBetaModel.baseUrl,
        routeBaseUrl: secondBetaModel.routeBaseUrl,
        purpose: "primary",
      }),
    ]);
    expect(remote.actions.some((action) => ["add", "probe", "connectivityProbe"].includes(action.type))).toBe(false);
  });

  it("keeps models with the same Provider identity in one radio group", async () => {
    const remote = createRemote({
      primary: primaryModel,
      fallbacks: [],
      configuredModels: [primaryModel, secondAlphaModel],
    });
    renderPanel(remote, true);

    expect(await screen.findAllByRole("button", { name: /Alpha API/ })).toHaveLength(1);
    const alphaGroup = screen.getByRole("group", { name: "Alpha API 已配置模型" });
    const primaryRow = screen.getByText("model-primary").closest("li") as HTMLElement;
    const secondAlphaRow = screen.getByText("model-alpha-2").closest("li") as HTMLElement;
    expect(within(primaryRow).getByRole("radio", { name: "model-primary" })).toBeChecked();
    expect(within(primaryRow).getByRole("button", { name: "设为主模型" })).toBeDisabled();
    expect(within(secondAlphaRow).getByRole("button", { name: "设为主模型" })).toBeEnabled();

    await userEvent.click(within(alphaGroup).getByRole("radio", { name: "model-alpha-2" }));
    expect(within(secondAlphaRow).getByRole("radio", { name: "model-alpha-2" })).toBeChecked();
  });

  it("shows catalog models inside an already configured Provider and assigns them without credentials", async () => {
    const savedHyModel: HermesConfiguredModel = {
      id: "hy4-preview",
      providerKey: "lightvela-tencent-hy-token-plan",
      providerName: fixedHyProvider.providerName,
      baseUrl: fixedHyProvider.baseUrl,
      routeBaseUrl: fixedHyProvider.baseUrl,
      apiMode: fixedHyProvider.apiMode,
      keyEnv: "KEY_lightvela_tencent_hy_token_plan",
    };
    const remote = createRemote({
      primary: savedHyModel,
      fallbacks: [],
      configuredModels: [savedHyModel],
    });
    renderPanel(remote, false, [fixedHyProvider]);

    expect(await screen.findByText("共 2 个")).toBeInTheDocument();
    const providerGroup = screen.getByRole("group", {
      name: `${fixedHyProvider.providerName} 已配置模型`,
    });
    expect(within(providerGroup).getByText("Hy4 Preview")).toBeInTheDocument();
    expect(within(providerGroup).queryByText("hy4-preview")).not.toBeInTheDocument();
    const catalogRow = within(providerGroup).getByText("Hy Next").closest("li") as HTMLElement;
    expect(within(catalogRow).getByText("可选模型")).toBeInTheDocument();
    expect(within(catalogRow).getByRole("button", { name: "设为主模型" })).toBeEnabled();
    expect(within(catalogRow).getByRole("button", { name: "设为备用模型" })).toBeEnabled();
    expect(within(catalogRow).queryByRole("button", { name: "删除" })).not.toBeInTheDocument();

    await userEvent.click(within(catalogRow).getByRole("button", { name: "设为主模型" }));

    await waitFor(() => expect(within(catalogRow).getByText("主模型")).toBeInTheDocument());
    const assignActions = remote.actions.filter((action) => action.type === "assign");
    expect(assignActions).toEqual([{
      type: "assign",
      providerKey: savedHyModel.providerKey,
      modelId: "hy-next",
      baseUrl: savedHyModel.baseUrl,
      routeBaseUrl: savedHyModel.routeBaseUrl,
      purpose: "primary",
    }]);
    expect(assignActions[0]).not.toHaveProperty("apiKey");
    expect(assignActions[0]).not.toHaveProperty("credentialEnvelope");
    expect(remote.actions.some((action) => ["add", "probe", "connectivityProbe"].includes(action.type))).toBe(false);
  });

  it.each([
    ["different endpoint", "https://proxy.example.com/v1", fixedHyProvider.apiMode],
    ["different API mode", fixedHyProvider.baseUrl, "anthropic_messages"],
  ])("does not merge catalog models into a configured Provider with a %s", async (_case, baseUrl, apiMode) => {
    const mismatchedHyModel: HermesConfiguredModel = {
      id: "hy4-preview",
      providerKey: "lightvela-tencent-hy-token-plan",
      providerName: fixedHyProvider.providerName,
      baseUrl,
      apiMode,
      keyEnv: "KEY_proxy_hy",
    };
    const remote = createRemote({
      primary: mismatchedHyModel,
      fallbacks: [],
      configuredModels: [mismatchedHyModel],
    });
    renderPanel(remote, false, [fixedHyProvider]);

    expect(await screen.findByText("共 1 个")).toBeInTheDocument();
    expect(screen.queryByText("hy-next")).not.toBeInTheDocument();
  });

  it("renders three role-aware actions with custom disabled-state tooltips", async () => {
    const remote = createRemote({
      primary: primaryModel,
      fallbacks: [fallbackModel],
      configuredModels: [primaryModel, fallbackModel, idleModel],
    });
    renderPanel(remote);

    expect(screen.getByRole("heading", { name: "模型" })).toBeInTheDocument();
    expect(screen.getByText("模型是智能体的“大脑”，在此可配置智能体使用的主模型与备用模型。")).toBeInTheDocument();
    expect(screen.getByText("正在读取模型配置")).toBeInTheDocument();
    expect(await screen.findByText("model-primary")).toBeInTheDocument();

    const primaryRow = screen.getByText("model-primary").closest("li") as HTMLElement;
    expect(primaryRow).not.toHaveClass("bg-black/[0.015]");
    expect(within(primaryRow).getByText("主模型")).toBeInTheDocument();
    expect(within(primaryRow).getAllByRole("button")).toHaveLength(3);
    expect(within(primaryRow).getByRole("button", { name: "设为主模型" })).toBeDisabled();
    expect(within(primaryRow).getByRole("button", { name: "设为备用模型" })).toBeDisabled();
    expect(within(primaryRow).getByRole("button", { name: "删除" })).toBeDisabled();
    const primaryTooltipTrigger = within(primaryRow).getByRole("group", { name: "当前模型已经是主模型" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await userEvent.hover(primaryTooltipTrigger);
    const primaryTooltip = await screen.findByRole("tooltip");
    expect(primaryTooltip).toHaveTextContent("当前模型已经是主模型");
    expect(primaryTooltip.parentElement).toBe(document.body);
    expect(within(primaryRow).queryByRole("tooltip")).not.toBeInTheDocument();
    expect(primaryTooltip).toHaveClass("fixed", "pointer-events-auto", "select-text");
    await userEvent.hover(primaryTooltip);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await userEvent.unhover(primaryTooltip);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());

    primaryTooltipTrigger.focus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("当前模型已经是主模型");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    expect(within(primaryRow).getByRole("group", { name: "主模型不能同时设为备用模型" })).toBeInTheDocument();
    expect(within(primaryRow).getByRole("group", { name: "无法删除主模型，请先切换至其他模型" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Beta API/ }));
    const fallbackRow = screen.getByText("model-fallback").closest("li") as HTMLElement;
    expect(within(fallbackRow).getByText("备用模型")).toBeInTheDocument();
    expect(within(fallbackRow).getAllByRole("button")).toHaveLength(3);
    expect(within(fallbackRow).getByRole("button", { name: "设为主模型" })).toBeEnabled();
    expect(within(fallbackRow).getByRole("button", { name: "取消备用" })).toBeEnabled();
    expect(primaryRow.querySelector("[title]")).toBeNull();
    expect(screen.queryByRole("button", { name: /上移|下移/ })).not.toBeInTheDocument();
  });

  it("displays the default configured model as Auto", async () => {
    const remote = createRemote({
      primary: autoModel,
      fallbacks: [],
      configuredModels: [autoModel],
    });
    renderPanel(remote);

    const autoRow = (await screen.findByText("Auto")).closest("li") as HTMLElement;
    expect(autoRow).toBeInTheDocument();
    expect(within(autoRow).queryByText("auto")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "设为主模型" }));
    expect(remote.actions).not.toContainEqual(expect.objectContaining({ type: "assign" }));
  });

  it("does not render an incomplete default custom configuration as a configured model", async () => {
    const incompleteCustom = {
      ...idleModel,
      id: "",
      providerKey: "custom",
      providerName: "Custom",
      baseUrl: "",
      routeBaseUrl: "",
      keyEnv: "",
      requiresSetup: true,
    };
    const remote = createRemote({
      primary: null,
      fallbacks: [],
      configuredModels: [incompleteCustom],
    });
    renderPanel(remote);

    expect(await screen.findByText("暂未配置模型")).toBeInTheDocument();
    expect(screen.queryByText("Auto")).not.toBeInTheDocument();
    expect(screen.queryByText("Custom")).not.toBeInTheDocument();
  });

  it("allows deletion for a complete model regardless of its legacy ownership flag", async () => {
    const importedModel = {
      ...idleModel,
      id: "manual-model",
      providerKey: "manual",
      providerName: "Manual Provider",
      canDelete: false,
    };
    const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [importedModel] });
    renderPanel(remote);

    const importedRow = (await screen.findByText("manual-model")).closest("li") as HTMLElement;
    expect(screen.getByRole("button", { name: "设为主模型" })).toBeEnabled();
    expect(within(importedRow).getByRole("button", { name: "设为备用模型" })).toBeEnabled();
    expect(within(importedRow).getByRole("button", { name: "删除" })).toBeEnabled();
    expect(within(importedRow).queryByRole("group", { name: /Hermes 中管理/ })).not.toBeInTheDocument();
  });

  it("uses the production-style lower form without changing the configured-model list", async () => {
    const remote = createRemote({
      primary: primaryModel,
      fallbacks: [fallbackModel],
      configuredModels: [primaryModel, fallbackModel],
    });
    renderPanel(remote);
    await screen.findByText("model-primary");

    expect(screen.getByRole("heading", { name: "模型" })).toBeInTheDocument();
    expect(screen.getByText("模型是智能体的“大脑”，在此可配置智能体使用的主模型与备用模型。")).toBeInTheDocument();
    const configuredHelp = screen.getByRole("group", { name: "选择一个主模型，并可设置多个备用模型。" });
    expect(configuredHelp).not.toHaveAttribute("title");
    expect(screen.queryByText("选择一个主模型，并可设置多个备用模型。")).not.toBeInTheDocument();
    await userEvent.hover(configuredHelp);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("选择一个主模型，并可设置多个备用模型。");
    await userEvent.unhover(configuredHelp);
    expect(screen.queryByText("选择一个主模型，并可设置多个备用模型。配置将在新会话中生效。")).not.toBeInTheDocument();
    const configuredSection = screen.getByRole("heading", { name: "已配置模型" }).closest("section");
    expect(configuredSection).toHaveClass("bg-white", "shadow-[0_10px_30px_rgba(15,23,42,0.04)]");
    expect(configuredSection?.parentElement).toHaveClass("pb-12", "md:pb-16");
    await userEvent.click(screen.getByRole("button", { name: /Beta API/ }));
    expect(within(configuredSection as HTMLElement).getByText("model-fallback")).toBeInTheDocument();

    const tabList = screen.getByRole("tablist", { name: "模型配置方式" });
    const codingPlanTab = screen.getByRole("tab", { name: "模型 Coding Plan" });
    const modelFormPanel = screen.getByRole("tabpanel", { name: "模型 Coding Plan" });
    expect(tabList).toHaveClass("w-full", "gap-4", "rounded-none", "border-b", "bg-transparent");
    expect(tabList).not.toHaveClass("min-w-max");
    expect(codingPlanTab).toHaveClass("rounded-none", "text-sm", "sm:text-base", "data-[state=active]:after:bg-black");
    expect(modelFormPanel).toHaveClass("bg-white");
    expect(modelFormPanel).not.toHaveClass("bg-black/[0.025]");
    expect(screen.queryByText("推荐")).not.toBeInTheDocument();

    const provider = screen.getByRole("combobox", { name: "Coding Plan 套餐" });
    const apiKey = screen.getByLabelText("API Key");
    const model = screen.getByRole("combobox", { name: "模型" });
    const fetchModelsButton = screen.getByRole("button", { name: "获取可用模型" });
    const connectivityButton = screen.getByRole("button", { name: "检测模型状态" });
    const apiKeyControl = apiKey.closest('[data-slot="model-api-key-control"]');
    const modelControl = model.closest('[data-slot="model-option-control"]');
    const modelLabel = screen.getByText("模型", { selector: "label" });
    expect(provider.compareDocumentPosition(apiKey) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(apiKey.compareDocumentPosition(modelLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(model).toBeDisabled();
    expect(provider).toHaveClass(
      "border-black/10",
      "shadow-none",
      "outline-none",
      "focus:border-[#2F6BFF]",
      "focus-visible:border-[#2F6BFF]",
      "focus-visible:ring-0",
    );
    expect(apiKey).toHaveClass(
      "border-0",
      "shadow-none",
      "outline-none",
      "focus:border-0",
      "focus-visible:ring-0",
    );
    expect(provider.closest("div.grid")).toHaveClass("gap-y-2");
    expect(apiKey.closest("div.grid")).toHaveClass("gap-y-2");
    expect(modelLabel.closest("div.grid")).toHaveClass("gap-y-2");

    expect(apiKeyControl).toHaveClass("flex", "overflow-hidden", "focus-within:border-[#2F6BFF]");
    expect(apiKeyControl).toContainElement(apiKey);
    expect(apiKeyControl).toContainElement(screen.getByRole("button", { name: "显示 API Key" }));
    expect(apiKeyControl).toContainElement(fetchModelsButton);
    expect(fetchModelsButton).toHaveClass(
      "h-full",
      "min-w-max",
      "shrink-0",
      "whitespace-nowrap",
      "rounded-none",
      "border-l",
    );
    expect(fetchModelsButton).not.toHaveClass("w-28", "sm:w-36");
    expect(fetchModelsButton.querySelector('[data-slot="model-compound-action-width-label"]')).toHaveTextContent("获取可用模型");
    expect(fetchModelsButton.querySelector('[data-slot="model-compound-action-width-label"]')).toHaveClass("invisible");
    expect(fetchModelsButton.querySelector("svg")).toBeNull();

    expect(modelControl).toHaveClass("flex", "overflow-hidden", "focus-within:border-[#2F6BFF]");
    expect(modelControl).toContainElement(model);
    expect(modelControl).toContainElement(connectivityButton);
    expect(model).toHaveClass("min-w-0", "flex-1", "rounded-none", "border-0");
    expect(connectivityButton).toHaveClass(
      "h-full",
      "min-w-max",
      "shrink-0",
      "whitespace-nowrap",
      "rounded-none",
      "border-l",
    );
    expect(connectivityButton).not.toHaveClass("w-28", "sm:w-36");
    expect(connectivityButton.querySelector('[data-slot="model-compound-action-width-label"]')).toHaveTextContent("检测模型状态");
    expect(connectivityButton.querySelector('[data-slot="model-compound-action-width-label"]')).toHaveClass("invisible");
    expect(connectivityButton.querySelector("svg")).toBeNull();

    const addButton = screen.getByRole("button", { name: "添加模型" });
    expect(fetchModelsButton.parentElement).not.toContainElement(addButton);
    expect(connectivityButton.parentElement).not.toContainElement(addButton);
    expect(addButton.parentElement).toHaveClass("justify-start");
    expect(addButton).not.toHaveClass("w-full");

    const purposeGroup = screen.getByRole("group", { name: "选择用途" });
    const purposeOptions = within(purposeGroup).getByRole("radio", { name: "设为主模型" }).parentElement?.parentElement;
    expect(purposeOptions).toHaveClass("mt-2");

    const sidebar = document.createElement("aside");
    sidebar.className = "lv-agents-sidebar-scroll-isolated";
    vi.spyOn(sidebar, "getBoundingClientRect").mockReturnValue({ top: 96 } as DOMRect);
    document.body.appendChild(sidebar);
    await userEvent.click(provider);
    expect(sidebar.style.getPropertyValue("--lv-agents-sidebar-locked-top")).toBe("96px");
    sidebar.remove();
    const providerList = await screen.findByRole("listbox");
    expect(providerList).toHaveClass(
      "w-[var(--radix-select-trigger-width)]",
      "min-w-[var(--radix-select-trigger-width)]",
      "max-h-80",
    );
    expect(providerList).toHaveStyle({
      width: "var(--radix-select-trigger-width)",
      minWidth: "var(--radix-select-trigger-width)",
    });
    await userEvent.keyboard("{Escape}");
  });

  it("lets international model actions fit long localized labels", async () => {
    const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] });
    renderPanel(remote, true);
    await screen.findByRole("heading", { name: "已配置模型" });

    const apiKey = screen.getByLabelText("API Key");
    const model = screen.getByRole("combobox", { name: "模型" });
    const fetchButton = screen.getByRole("button", { name: "获取可用模型" });
    const statusButton = screen.getByRole("button", { name: "检测模型状态" });
    const apiKeyControl = apiKey.closest('[data-slot="model-api-key-control"]');
    const modelControl = model.closest('[data-slot="model-option-control"]');

    expect(apiKeyControl).toHaveClass(
      "grid",
      "h-auto",
      "grid-cols-1",
      "sm:h-12",
      "sm:grid-cols-[minmax(0,1fr)_max-content]",
    );
    expect(modelControl).toHaveClass("grid", "grid-cols-1");
    expect(fetchButton).toHaveClass(
      "h-12",
      "w-full",
      "border-t",
      "sm:h-full",
      "sm:w-auto",
      "sm:min-w-max",
    );
    expect(statusButton).toHaveClass(
      "h-12",
      "w-full",
      "border-t",
      "sm:h-full",
      "sm:w-auto",
      "sm:min-w-max",
    );
    expect(fetchButton).not.toHaveClass("w-28", "sm:w-36");
    expect(statusButton).not.toHaveClass("w-28", "sm:w-36");
  });

  it("shows a retryable read error and an actionable empty state", async () => {
    const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] });
    remote.failNextRead();
    renderPanel(remote);

    expect(await screen.findByRole("alert")).toHaveTextContent("读取模型配置失败");
    expect(screen.getByRole("heading", { name: "模型" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("暂未配置模型")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "添加第一个模型" }));
    expect(screen.getByRole("combobox", { name: "Coding Plan 套餐" })).toHaveFocus();
  });

  it("requires credentials, probes models, and invalidates stale results", async () => {
    const remote = createRemote({ primary: primaryModel, fallbacks: [], configuredModels: [primaryModel] });
    renderPanel(remote);
    await screen.findByText("model-primary");

    const probeButton = screen.getByRole("button", { name: "获取可用模型" });
    const connectivityButton = screen.getByRole("button", { name: "检测模型状态" });
    const apiKey = screen.getByLabelText("API Key");
    expect(probeButton).toBeDisabled();
    expect(connectivityButton).toBeDisabled();
    await userEvent.type(apiKey, "secret-value");
    expect(probeButton).toBeEnabled();

    await userEvent.click(probeButton);
    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith("已获取可用模型"));
    expect(screen.queryByText("已获取可用模型")).not.toBeInTheDocument();
    const model = await screen.findByRole("combobox", { name: "模型" });
    const modelLabel = screen.getByText("模型", { selector: "label" });
    expect(model).toBeEnabled();
    expect(apiKey.compareDocumentPosition(modelLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(modelLabel.closest("div.grid")).toHaveClass("gap-y-2");
    expect(model.parentElement).toContainElement(connectivityButton);
    expect(model).toHaveClass("border-0", "focus-visible:ring-0");
    expect(screen.getByRole("radio", { name: "设为主模型" })).toBeChecked();
    await selectOption("模型", "shared-model");
    expect(screen.getByRole("combobox", { name: "模型" })).toHaveTextContent("shared-model");
    expect(connectivityButton).toBeEnabled();

    await userEvent.click(connectivityButton);
    expect(await screen.findByRole("dialog", { name: "模型可用性检测通过" })).toBeInTheDocument();
    expect(screen.getByText("当前凭据可以访问该模型。")).toBeInTheDocument();
    expect(screen.queryByText("当前模型可以正常连接。")).not.toBeInTheDocument();
    expect(screen.getByText("128 ms")).toBeInTheDocument();
    expect(remote.actions.some((action) => (action.type as string) === "connectivityProbe")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "确定" }));

    await userEvent.clear(apiKey);
    expect(screen.getByRole("combobox", { name: "模型" })).toBeDisabled();
    expect(screen.queryByText("shared-model")).not.toBeInTheDocument();
  });

  it("keeps the full idle action width while model discovery is loading", async () => {
    const remote = createRemote({ primary: primaryModel, fallbacks: [], configuredModels: [primaryModel] });
    renderPanel(remote);
    await screen.findByText("model-primary");

    const execute = remote.execDebugCommand.getMockImplementation();
    if (!execute) throw new Error("Missing remote command implementation");
    remote.execDebugCommand.mockImplementation(async (botId, command) => {
      if (decodeAction(command).type === "probe") {
        return await new Promise<never>(() => undefined);
      }
      return execute(botId, command);
    });

    await userEvent.type(screen.getByLabelText("API Key"), "secret-value");
    await userEvent.click(screen.getByRole("button", { name: "获取可用模型" }));

    const loadingButton = await screen.findByRole("button", { name: "获取中..." });
    expect(loadingButton).toBeDisabled();
    expect(loadingButton).toHaveTextContent("获取中...");
    expect(loadingButton.querySelector("svg")).toHaveClass("animate-spin");
    expect(loadingButton.querySelector('[data-slot="model-compound-action-width-label"]')).toHaveTextContent("获取可用模型");
    expect(loadingButton.querySelector('[data-slot="model-compound-action-width-label"]')).toHaveClass("invisible");
  });

  it("renders the API Key destination as an external link", async () => {
    const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] });
    renderPanel(remote);
    await screen.findByText("暂未配置模型");

    await userEvent.click(screen.getByRole("tab", { name: "模型 API" }));
    const apiKeyLink = screen.getByRole("link", { name: "点此获取 API Key" });
    expect(apiKeyLink).toHaveAttribute("href", "https://alpha.example.com/keys");
    expect(apiKeyLink).toHaveAttribute("target", "_blank");
    expect(apiKeyLink.querySelector("svg")).not.toBeNull();
  });

  it("loads the MiniMax Provider catalog without calling live model discovery", async () => {
    const catalogProvider: ModelProviderOption = {
      ...providers[1],
      providerKey: "minimax-plan",
      providerName: "MiniMax Token Plan",
      discoveryStrategy: "catalog",
      catalogModels: [
        { id: "MiniMax-M2.1", name: "MiniMax M2.1" },
        { id: "MiniMax-M2.1-lightning", name: "MiniMax M2.1 Lightning" },
      ],
    };
    const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] }, [], false);
    render(
      <AgentModelConfigPanel
        botId="bot-1"
        execDebugCommand={remote.execDebugCommand}
        providers={[catalogProvider]}
      />,
    );
    await screen.findByText("暂未配置模型");

    await userEvent.type(screen.getByLabelText("API Key"), "catalog-secret");
    await userEvent.click(screen.getByRole("button", { name: "获取可用模型" }));

    const modelSelect = screen.getByRole("combobox", { name: "模型" });
    expect(modelSelect).toBeEnabled();
    expect(modelSelect).toHaveTextContent("MiniMax M2.1");
    expect(remote.actions.some((action) => action.type === "probe")).toBe(false);
    await selectOption("模型", "MiniMax M2.1 Lightning");
    await userEvent.click(screen.getByRole("button", { name: "添加模型" }));

    expect(remote.actions).toContainEqual(expect.objectContaining({
      type: "add",
      discoverModels: false,
      model: expect.objectContaining({
        id: "MiniMax-M2.1-lightning",
        providerName: "MiniMax Token Plan",
      }),
    }));
  });

  it("shows the first Coding Plan catalog model without model discovery", async () => {
    const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] });
    render(
      <AgentModelConfigPanel
        botId="bot-1"
        execDebugCommand={remote.execDebugCommand}
        providers={[fixedHyProvider]}
      />,
    );
    await screen.findByText("暂未配置模型");

    expect(screen.queryByRole("button", { name: "获取可用模型" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "模型" })).toHaveTextContent("Hy4 Preview");
    expect(remote.actions.some((action) => action.type === "probe")).toBe(false);
  });

  it("keeps standalone model validation for a Coding Plan catalog", async () => {
    const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] });
    render(
      <AgentModelConfigPanel
        botId="bot-1"
        execDebugCommand={remote.execDebugCommand}
        providers={[fixedHyProvider]}
      />,
    );
    await screen.findByText("暂未配置模型");

    const statusButton = screen.getByRole("button", { name: "检测模型状态" });
    expect(statusButton).toBeDisabled();
    await userEvent.type(screen.getByLabelText("API Key"), "hy-secret");
    expect(statusButton).toBeEnabled();
    await userEvent.click(statusButton);

    expect(await screen.findByRole("dialog", { name: "模型可用性检测通过" })).toBeInTheDocument();
    expect(remote.actions).toContainEqual(expect.objectContaining({
      type: "connectivityProbe",
      strategy: "model_request",
      model: expect.objectContaining({ id: "hy4-preview" }),
    }));
  });

  it("adds the selected Coding Plan model without automatic validation", async () => {
    const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] });
    render(
      <AgentModelConfigPanel
        botId="bot-1"
        execDebugCommand={remote.execDebugCommand}
        providers={[fixedHyProvider]}
      />,
    );
    await screen.findByText("暂未配置模型");

    await userEvent.type(screen.getByLabelText("API Key"), "hy-secret");
    await selectOption("模型", "Hy Next");
    await userEvent.click(screen.getByRole("button", { name: "添加模型" }));

    await waitFor(() => expect(toastMocks.success).toHaveBeenLastCalledWith("模型已添加"));
    expect(screen.queryByRole("dialog", { name: "模型可用性检测通过" })).not.toBeInTheDocument();
    expect(remote.actions.some((action) => action.type === "connectivityProbe")).toBe(false);
    expect(remote.actions).toContainEqual(expect.objectContaining({
      type: "add",
      purpose: "primary",
      discoverModels: false,
      model: expect.objectContaining({ id: "hy-next" }),
    }));
    expect(remote.actions.some((action) => action.type === "probe")).toBe(false);
  });

  it("keeps the current primary purpose when reconfiguring the same catalog model", async () => {
    const configuredHyModel: HermesConfiguredModel = {
      id: "hy4-preview",
      providerKey: "lightvela-tencent-hy-token-plan",
      providerName: fixedHyProvider.providerName,
      baseUrl: fixedHyProvider.baseUrl,
      apiMode: fixedHyProvider.apiMode,
      keyEnv: "HERMES_CUSTOM_LIGHTVELA_TENCENT_HY_TOKEN_PLAN_API_KEY",
    };
    const remote = createRemote({
      primary: configuredHyModel,
      fallbacks: [],
      configuredModels: [configuredHyModel],
    });
    render(
      <AgentModelConfigPanel
        botId="bot-1"
        execDebugCommand={remote.execDebugCommand}
        providers={[fixedHyProvider]}
      />,
    );
    expect(await screen.findAllByText("Hy4 Preview")).toHaveLength(2);

    expect(screen.getByRole("radio", { name: "设为主模型" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "仅添加" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "仅添加" })).toBeDisabled();

    await userEvent.type(screen.getByLabelText("API Key"), "hy-secret");
    await userEvent.click(screen.getByRole("button", { name: "添加模型" }));

    await waitFor(() => expect(toastMocks.success).toHaveBeenLastCalledWith("模型已添加"));
    expect(remote.actions).toContainEqual(expect.objectContaining({
      type: "add",
      purpose: "primary",
      model: expect.objectContaining({ id: "hy4-preview" }),
    }));

    expect(screen.getByRole("radio", { name: "设为主模型" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "仅添加" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "仅添加" })).toHaveAccessibleDescription("当前模型已经是主模型");

    await userEvent.type(screen.getByLabelText("API Key"), "updated-hy-secret");
    await userEvent.click(screen.getByRole("button", { name: "添加模型" }));

    await waitFor(() => expect(remote.actions.filter((action) => action.type === "add")).toHaveLength(2));
    expect(remote.actions.filter((action) => action.type === "add")).toEqual([
      expect.objectContaining({ purpose: "primary" }),
      expect.objectContaining({ purpose: "primary" }),
    ]);
  });

  it("does not present catalog models when Hermes model discovery fails", async () => {
    const catalogProvider: ModelProviderOption = {
      ...providers[1],
      discoveryStrategy: "live",
      catalogModels: [{ id: "catalog-only-model", name: "Catalog Only Model" }],
    };
    const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] }, [], false);
    render(
      <AgentModelConfigPanel
        botId="bot-1"
        execDebugCommand={remote.execDebugCommand}
        providers={[catalogProvider]}
      />,
    );
    await screen.findByText("暂未配置模型");

    await userEvent.type(screen.getByLabelText("API Key"), "invalid-secret");
    await userEvent.click(screen.getByRole("button", { name: "获取可用模型" }));

    expect(screen.getByRole("combobox", { name: "模型" })).toBeDisabled();
    expect(screen.queryByText("Catalog Only Model")).not.toBeInTheDocument();
    expect(toastMocks.error).toHaveBeenCalledWith("未获取到可用模型，请检查API Key是否正确或有效");
    expect(screen.queryByText("未获取到可用模型，请检查API Key是否正确或有效")).not.toBeInTheDocument();
  });

  it("keeps model selection disabled when neither live nor catalog models are available", async () => {
    const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] }, []);
    renderPanel(remote);
    await screen.findByText("暂未配置模型");

    await userEvent.type(screen.getByLabelText("API Key"), "empty-provider-secret");
    await userEvent.click(screen.getByRole("button", { name: "获取可用模型" }));

    expect(screen.getByRole("combobox", { name: "模型" })).toBeDisabled();
    expect(toastMocks.error).toHaveBeenCalledWith("未获取到可用模型，请检查API Key是否正确或有效");
    expect(screen.queryByText("未获取到可用模型，请检查API Key是否正确或有效")).not.toBeInTheDocument();
  });

  it("shows model discovery failures in a top message instead of the card", async () => {
    const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] });
    renderPanel(remote);
    await screen.findByText("暂未配置模型");

    await userEvent.type(screen.getByLabelText("API Key"), "invalid-secret");
    remote.failNext("probe");
    await userEvent.click(screen.getByRole("button", { name: "获取可用模型" }));

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("模型配置操作失败，请重试。"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not use a product catalog for a custom Provider", async () => {
    const catalogProvider: ModelProviderOption = {
      ...providers[1],
      catalogModels: [{ id: "catalog-only-model", name: "Catalog Only Model" }],
    };
    const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] }, []);
    render(
      <AgentModelConfigPanel
        botId="bot-1"
        execDebugCommand={remote.execDebugCommand}
        providers={[catalogProvider]}
      />,
    );
    await screen.findByText("暂未配置模型");

    await userEvent.click(screen.getByRole("tab", { name: "自定义模型" }));
    await userEvent.type(screen.getByLabelText("Provider 名称"), "Private Relay");
    await userEvent.type(screen.getByLabelText("Base URL"), "https://relay.example.com/v1");
    await userEvent.type(screen.getByLabelText("API Key"), "relay-secret");
    await userEvent.click(screen.getByRole("button", { name: "获取可用模型" }));

    expect(screen.getByRole("combobox", { name: "模型" })).toBeDisabled();
    expect(screen.queryByText("Catalog Only Model")).not.toBeInTheDocument();
  });

  it("adds a probed model with the selected purpose and clears the key", async () => {
    const remote = createRemote({ primary: primaryModel, fallbacks: [], configuredModels: [primaryModel] });
    renderPanel(remote);
    await screen.findByText("model-primary");

    await userEvent.type(screen.getByLabelText("API Key"), "secret-value");
    await userEvent.click(screen.getByRole("button", { name: "获取可用模型" }));
    await selectOption("模型", "model-new");
    await userEvent.click(screen.getByRole("radio", { name: "仅添加" }));
    await userEvent.click(screen.getByRole("button", { name: "添加模型" }));

    await waitFor(() => expect(toastMocks.success).toHaveBeenLastCalledWith("模型已添加"));
    expect(screen.queryByText("模型已添加")).not.toBeInTheDocument();
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    expect(remote.actions).toContainEqual(expect.objectContaining({
      type: "add",
      purpose: "idle",
      credentialEnvelope: expect.objectContaining({ token: "a".repeat(48) }),
      model: expect.objectContaining({ id: "model-new", providerName: "Beta Coding Plan" }),
    }));
    expect(JSON.stringify(remote.actions)).not.toContain("secret-value");
  });

  it("appends multiple fallbacks and cancels only the selected fallback", async () => {
    const remote = createRemote({
      primary: primaryModel,
      fallbacks: [fallbackModel],
      configuredModels: [primaryModel, fallbackModel, idleModel],
    });
    renderPanel(remote);
    await screen.findByText("model-primary");

    await userEvent.click(screen.getByRole("button", { name: /Gamma API/ }));
    let idleRow = screen.getByText("model-idle").closest("li") as HTMLElement;
    await userEvent.click(within(idleRow).getByRole("button", { name: "设为备用模型" }));
    await waitFor(() => expect(within(idleRow).getByText("备用模型")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Beta API/ }));
    expect(screen.getByText("model-fallback").closest("li")).toHaveTextContent("备用模型");

    await userEvent.click(screen.getByRole("button", { name: /Gamma API/ }));
    idleRow = screen.getByText("model-idle").closest("li") as HTMLElement;
    await userEvent.click(within(idleRow).getByRole("button", { name: "取消备用" }));
    await waitFor(() => expect(within(idleRow).getByText("未启用")).toBeInTheDocument());
    expect(remote.actions).toContainEqual({ type: "assign", providerKey: idleModel.providerKey, modelId: idleModel.id, baseUrl: idleModel.baseUrl, routeBaseUrl: idleModel.baseUrl, purpose: "fallback" });
    expect(remote.actions).toContainEqual({ type: "removeFallback", providerKey: idleModel.providerKey, modelId: idleModel.id, baseUrl: idleModel.baseUrl, routeBaseUrl: idleModel.baseUrl });
    await userEvent.click(screen.getByRole("button", { name: /Beta API/ }));
    expect(screen.getByText("model-fallback").closest("li")).toHaveTextContent("备用模型");
  });

  it("requires delete confirmation and leaves the primary protected", async () => {
    const remote = createRemote({
      primary: primaryModel,
      fallbacks: [],
      configuredModels: [primaryModel, idleModel],
    });
    renderPanel(remote);
    await screen.findByText("model-primary");

    await userEvent.click(screen.getByRole("button", { name: /Gamma API/ }));
    const idleRow = screen.getByText("model-idle").closest("li") as HTMLElement;
    await userEvent.click(within(idleRow).getByRole("button", { name: "删除" }));
    const dialog = screen.getByRole("dialog", { name: "删除模型" });
    expect(dialog).toHaveAccessibleDescription("删除后将移除此模型配置；如果 Provider 下没有其他模型，也会移除对应凭据。");
    await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(remote.actions.some((action) => action.type === "remove")).toBe(false);

    await userEvent.click(within(idleRow).getByRole("button", { name: "删除" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "删除模型" })).getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(screen.queryByText("model-idle")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("heading", { name: "已配置模型" })).toHaveFocus());
    expect(remote.actions).toContainEqual({ type: "remove", providerKey: idleModel.providerKey, modelId: idleModel.id, baseUrl: idleModel.baseUrl, routeBaseUrl: idleModel.baseUrl });
    const primaryRow = screen.getByText("model-primary").closest("li") as HTMLElement;
    expect(within(primaryRow).getByRole("button", { name: "删除" })).toBeDisabled();
  });

  it("blocks the primary model from fallback purpose and invalidates custom probe results", async () => {
    const remote = createRemote(
      { primary: primaryModel, fallbacks: [], configuredModels: [primaryModel] },
      [primaryModel.id, "another-model"],
    );
    renderPanel(remote);
    await screen.findByText("model-primary");

    await userEvent.click(screen.getByRole("tab", { name: "模型 API" }));
    await userEvent.type(screen.getByLabelText("API Key"), "secret-value");
    await userEvent.click(screen.getByRole("button", { name: "获取可用模型" }));
    expect(await screen.findByRole("radio", { name: "设为备用模型" })).toBeDisabled();
    expect(screen.getByText("主模型不能同时设为备用模型。")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "自定义模型" }));
    await userEvent.type(screen.getByLabelText("Provider 名称"), "Private Relay");
    await userEvent.type(screen.getByLabelText("Base URL"), "https://relay.example.com/v1");
    await userEvent.type(screen.getByLabelText("API Key"), "relay-secret");
    await userEvent.click(screen.getByRole("button", { name: "获取可用模型" }));
    expect(screen.getByRole("combobox", { name: "模型" })).toBeEnabled();

    await userEvent.type(screen.getByLabelText("Base URL"), "/new");
    expect(screen.getByRole("combobox", { name: "模型" })).toBeDisabled();
  });

  it("supports arrow-key navigation across Provider modes", async () => {
    const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] });
    renderPanel(remote);
    await screen.findByText("暂未配置模型");

    const codingPlanTab = screen.getByRole("tab", { name: "模型 Coding Plan" });
    codingPlanTab.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "模型 API" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("combobox", { name: "模型服务商" })).toBeInTheDocument();
  });

  it("binds credentials and deferred probe results to the selected Provider", async () => {
    const initialProvider = providers[1];
    const replacementProvider: ModelProviderOption = {
      ...initialProvider,
      providerKey: "replacement-plan",
      providerName: "Replacement Plan",
      baseUrl: "https://replacement.example.com/v1",
    };
    const initialSnapshot = { primary: primaryModel, fallbacks: [], configuredModels: [primaryModel] };
    let resolveFirstProbe: ((result: { status: string; exitCode: number; output: string }) => void) | undefined;
    const firstProbe = new Promise<{ status: string; exitCode: number; output: string }>((resolve) => {
      resolveFirstProbe = resolve;
    });
    const actions: HermesModelConfigAction[] = [];
    const execDebugCommand = vi.fn(async (_botId: string, command: string) => {
      const nextAction = decodeAction(command);
      actions.push(nextAction);
      if (nextAction.type === "prepareCredentialEnvelope") {
        return { status: "Succeeded", exitCode: 0, output: preparationOutput };
      }
      if (nextAction.type === "probe" && actions.filter((item) => item.type === "probe").length === 1) {
        return firstProbe;
      }
      if (nextAction.type === "probe") {
        return { status: "Succeeded", exitCode: 0, output: successOutput({ ...initialSnapshot, probedModels: ["replacement-model"] }) };
      }
      return { status: "Succeeded", exitCode: 0, output: successOutput(initialSnapshot) };
    });
    const view = render(
      <AgentModelConfigPanel botId="bot-1" execDebugCommand={execDebugCommand} providers={[initialProvider]} />,
    );
    await screen.findByText("model-primary");

    await userEvent.type(screen.getByLabelText("API Key"), "provider-a-secret");
    await userEvent.click(screen.getByRole("button", { name: "获取可用模型" }));
    view.rerender(
      <AgentModelConfigPanel botId="bot-1" execDebugCommand={execDebugCommand} providers={[replacementProvider]} />,
    );
    expect(await screen.findByRole("combobox", { name: "Coding Plan 套餐" })).toHaveTextContent("Replacement Plan");
    await waitFor(() => expect(screen.getByLabelText("API Key")).toHaveValue(""));

    await act(async () => {
      resolveFirstProbe?.({ status: "Succeeded", exitCode: 0, output: successOutput({ ...initialSnapshot, probedModels: ["stale-model"] }) });
      await firstProbe;
    });
    expect(screen.getByRole("combobox", { name: "模型" })).toBeDisabled();

    await userEvent.type(screen.getByLabelText("API Key"), "provider-b-secret");
    await userEvent.click(screen.getByRole("button", { name: "获取可用模型" }));
    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith("已获取可用模型"));
    expect(screen.queryByText("已获取可用模型")).not.toBeInTheDocument();
    const probeActions = actions.filter((item): item is Extract<HermesModelConfigAction, { type: "probe" }> => item.type === "probe");
    expect(probeActions).toEqual([
      expect.objectContaining({ credentialEnvelope: expect.any(Object), baseUrl: initialProvider.baseUrl }),
      expect.objectContaining({ credentialEnvelope: expect.any(Object), baseUrl: replacementProvider.baseUrl }),
    ]);
    const [initialProbeAction, replacementProbeAction] = probeActions;
    if (!initialProbeAction || !replacementProbeAction) throw new Error("Expected both Provider probe actions");
    expect(initialProbeAction.credentialEnvelope.ciphertext).not.toBe(replacementProbeAction.credentialEnvelope.ciphertext);
    expect(JSON.stringify(actions)).not.toContain("provider-a-secret");
    expect(JSON.stringify(actions)).not.toContain("provider-b-secret");
  });

  it("ignores a deferred connectivity result after the Provider changes", async () => {
    const initialProvider = providers[1];
    const replacementProvider: ModelProviderOption = {
      ...initialProvider,
      providerKey: "replacement-plan",
      providerName: "Replacement Plan",
      baseUrl: "https://replacement.example.com/v1",
    };
    const initialSnapshot = { primary: primaryModel, fallbacks: [], configuredModels: [primaryModel] };
    let resolveConnection: ((result: { status: string; exitCode: number; output: string }) => void) | undefined;
    const pendingConnection = new Promise<{ status: string; exitCode: number; output: string }>((resolve) => {
      resolveConnection = resolve;
    });
    const execDebugCommand = vi.fn(async (_botId: string, command: string) => {
      const action = decodeAction(command);
      if (action.type === "prepareCredentialEnvelope") {
        return { status: "Succeeded", exitCode: 0, output: preparationOutput };
      }
      if (action.type === "probe") {
        return { status: "Succeeded", exitCode: 0, output: successOutput({ ...initialSnapshot, probedModels: ["shared-model"] }) };
      }
      if (action.type === "connectivityProbe") return pendingConnection;
      return { status: "Succeeded", exitCode: 0, output: successOutput(initialSnapshot) };
    });
    const view = render(
      <AgentModelConfigPanel botId="bot-1" execDebugCommand={execDebugCommand} providers={[initialProvider]} />,
    );
    await screen.findByText("model-primary");

    await userEvent.type(screen.getByLabelText("API Key"), "provider-secret");
    await userEvent.click(screen.getByRole("button", { name: "获取可用模型" }));
    await userEvent.click(screen.getByRole("button", { name: "检测模型状态" }));
    view.rerender(
      <AgentModelConfigPanel botId="bot-1" execDebugCommand={execDebugCommand} providers={[replacementProvider]} />,
    );

    await act(async () => {
      resolveConnection?.({ status: "Succeeded", exitCode: 0, output: connectionOutput(initialSnapshot) });
      await pendingConnection;
    });
    expect(screen.queryByRole("dialog", { name: "模型可用性检测通过" })).not.toBeInTheDocument();
  });

  it("uses a collision-safe identity for custom Providers", async () => {
    const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [] }, ["custom-model"]);
    renderPanel(remote);
    await screen.findByText("暂未配置模型");

    await userEvent.click(screen.getByRole("tab", { name: "自定义模型" }));
    await userEvent.type(screen.getByLabelText("Provider 名称"), "Alpha");
    await userEvent.type(screen.getByLabelText("Base URL"), "https://custom-alpha.example.com/v1");
    await userEvent.type(screen.getByLabelText("API Key"), "custom-secret");
    await userEvent.click(screen.getByRole("button", { name: "获取可用模型" }));
    await userEvent.click(screen.getByRole("button", { name: "添加模型" }));

    const addAction = remote.actions.find((item): item is Extract<HermesModelConfigAction, { type: "add" }> => item.type === "add");
    expect(addAction?.discoverModels).toBe(true);
    expect(addAction?.model.providerKey).not.toBe("lightvela-alpha");
    expect(addAction?.model.providerKey).toMatch(/^lightvela-custom-alpha-/);
  });

  it("keeps the API key available for correction when add fails", async () => {
    const remote = createRemote({ primary: primaryModel, fallbacks: [], configuredModels: [primaryModel] });
    renderPanel(remote);
    await screen.findByText("model-primary");

    await userEvent.type(screen.getByLabelText("API Key"), "retry-secret");
    await userEvent.click(screen.getByRole("button", { name: "获取可用模型" }));
    remote.failNext("add");
    await userEvent.click(screen.getByRole("button", { name: "添加模型" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("模型配置操作失败，请重试。");
    expect(screen.getByRole("alert")).not.toHaveTextContent("temporary operation failure");
    expect(screen.getByLabelText("API Key")).toHaveValue("retry-secret");
    expect(screen.queryByText("模型已添加")).not.toBeInTheDocument();
  });

  it("keeps delete failures inside the confirmation dialog for retry", async () => {
    const remote = createRemote({ primary: null, fallbacks: [], configuredModels: [idleModel] });
    renderPanel(remote);
    await screen.findByText("model-idle");

    const idleRow = screen.getByText("model-idle").closest("li") as HTMLElement;
    await userEvent.click(within(idleRow).getByRole("button", { name: "删除" }));
    remote.failNext("remove");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认删除" }));

    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("模型配置操作失败，请重试。");
    expect(within(dialog).getByRole("button", { name: "确认删除" })).toBeEnabled();
  });
});
