// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * @fileoverview useModelOperations — 模型操作公共 hook
 *
 * 从 ModelCard 中抽取的操作逻辑，供 Standard / Compact 两套面板共用。
 * 封装：添加 provider、删除 provider、切换默认模型、自定义模型保存。
 *
 * 内部自动根据 productConfig.agentType 走 OpenClaw 或 Hermes 命令路径。
 */

import { useCallback, useMemo, useState } from 'react';
import { t } from "../../../../i18n/t";
import { useAgentConfig } from './useAgentConfig';
import { useAgentInternals } from './useAgentInternals';
import type { IAgentComponentBaseProps } from './useAgentInternals';
import type { IConfigData } from '../types';
import type { IModelProvider } from '../types';
import { normalizeCustomProvider } from '../utils/model-providers';
import { isHermesModelProbeSuccessful, normalizeHermesApi, parseHermesModelProbe } from "../utils/hermes-parsers";
import type { IHermesModelProbeParams, IHermesModelProbeResult } from "../utils/hermes-parsers";

// ─── 类型定义 ───

export interface IProviderGroup {
  category: 'coding_plan' | 'api';
  label: string;
  providers: IModelProvider[];
}

export interface IUseModelOperationsParams extends IAgentComponentBaseProps {
  /** 数据是否准备就绪（可选，默认 true） */
  isDataReady?: boolean;
  /** 操作禁用提示 */
  operationDisabledTip?: string;
}

export interface ISaveProviderParams {
  /** provider 标识（如 'tencent_token_plan'） */
  providerValue: string;
  /** 模型 ID */
  modelId: string;
  /** API Key */
  apiKey: string;
}

export interface ISaveCustomModelParams {
  /** provider name（Hermes 可不传，默认 'custom'） */
  provider?: string;
  providerName?: string;
  description?: string;
  apiKeyUrl?: string;
  /** Base URL */
  baseUrl: string;
  /** API 协议（如 'openai-completions'） */
  api: string;
  /** API Key */
  apiKey: string;
  /** 模型列表 */
  models: Array<{ id: string; name: string; input?: string[] }>;
}

export interface IModelSwitchResult {
  success: boolean;
  error?: string;
}

export interface IUseModelOperationsResult {
  // ─── 数据 ───
  /** 已解析的配置数据（含 providers / channels / activeModel） */
  configData: IConfigData;
  /** 是否正在加载 */
  loading: boolean;
  /** 按 category 分组的 provider 列表 */
  providerGroups: IProviderGroup[];
  /** 完整的 provider 列表（已按地域过滤） */
  filteredProviders: IModelProvider[];
  /** Hermes 已配置的 provider 列表（带 name/models/isDefault） */
  hermesProviderList: any[];

  // ─── 操作 ───
  /** 保存预设 provider（选择 provider + 模型 + apiKey） */
  saveProvider: (params: ISaveProviderParams) => Promise<boolean>;
  /** 保存自定义模型配置 */
  saveCustomModel: (params: ISaveCustomModelParams) => Promise<boolean>;
  /** 保存自定义模型（从 JSON 字符串解析） */
  saveCustomModelFromJson: (json: string) => Promise<boolean>;
  /** 删除 provider */
  deleteProvider: (providerName: string, isInUse?: boolean) => Promise<boolean>;
  /** 切换默认模型（Hermes：provider/modelId 格式） */
  hermesSwitchModel: (modelId: string, providerName: string) => Promise<boolean>;
  /** 切换默认模型（Hermes：provider/modelId 格式），返回失败原因 */
  hermesSwitchModelWithResult: (modelId: string, providerName: string) => Promise<IModelSwitchResult>;
  /** 测试当前已生效模型的连通性（Hermes/acli only） */
  probeModel: (params?: IHermesModelProbeParams) => Promise<boolean>;
  /** 刷新配置 */
  refresh: () => Promise<void>;

  // ─── 状态 ───
  /** 当前正在执行的操作标识 */
  currentAction: string;
  /** 是否正在保存 */
  saving: boolean;
  /** 正在删除的 provider name（null 表示未删除） */
  deleting: string | null;
  /** 正在切换的 provider name（null 表示未切换） */
  switching: string | null;
  /** 是否正在执行模型连通性检测 */
  probing: boolean;
  /** 最近一次模型连通性检测结果 */
  modelProbeResult: IHermesModelProbeResult | null;
  /** 模型连通性检测的执行/解析错误 */
  modelProbeError: string | null;

  // ─── 功能特性 ───
  /** 是否为腾讯系 provider（自动获取 Key） */
  isTencentProvider: (providerValue: string) => boolean;
  /** 获取腾讯系 API Key */
  getTencentApiKey: (providerValue: string, modelId: string) => Promise<string>;
}

// ─── 纯工具函数 ───

/**
 * 解析自定义模型 JSON 配置字符串（Hermes）
 */
function parseCustomModelJson(configStr: string): ISaveCustomModelParams | null {
  try {
    const config = JSON.parse(configStr);

    // 验证必要字段
    if (!config.provider || !config.base_url || !config.api || !config.api_key) {
      return null;
    }

    // 兼容 model 为数组或单对象
    if (!config.model) {
      return null;
    }
    const configModels: Array<{
      id: string;
      name: string;
      input?: string[];
    }> = Array.isArray(config.model) ? config.model : [config.model];
    if (configModels.length === 0 || configModels.some((m: any) => !m?.id || !m?.name)) {
      return null;
    }

    return {
      provider: config.provider,
      providerName: config.provider,
      description: '',
      apiKeyUrl: '',
      baseUrl: config.base_url,
      api: config.api,
      apiKey: config.api_key,
      models: configModels,
    };
  } catch (error) {
    return null;
  }
}

// ─── Hook 实现 ───

export function useModelOperations(params: IUseModelOperationsParams): IUseModelOperationsResult {
  // ── 底层 hooks ──
  const { configData, loading, restartAndRefresh, currentAction, setCurrentAction, refresh } = useAgentConfig({
    instance: params.instance,
    scriptCommands: params.scriptCommands,
    featureFlags: params.featureFlags,
    productConfig: params.productConfig,
    commandExecutor: params.commandExecutor,
    isDataReady: params.isDataReady,
    operationDisabledTip: params.operationDisabledTip,
  });

  const { scriptCommands, executor, productConfig } = useAgentInternals({
    instance: params.instance,
    scriptCommands: params.scriptCommands,
    featureFlags: params.featureFlags,
    productConfig: params.productConfig,
    commandExecutor: params.commandExecutor,
  });

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [modelProbeResult, setModelProbeResult] = useState<IHermesModelProbeResult | null>(null);
  const [modelProbeError, setModelProbeError] = useState<string | null>(null);

  // ── 过滤后的 provider 列表 ──
  const filteredProviders = useMemo(() => {
    const region = params.instance.Zone?.replace(/-\d+$/, '');
    return (
      productConfig.getFilteredModelProviders?.(region, params.instance.RegionId) ?? productConfig.modelProviders ?? []
    );
  }, [params.instance.RegionId, params.instance.Zone, productConfig]);

  // ── 按 category 分组 ──
  const providerGroups = useMemo<IProviderGroup[]>(() => {
    const codingPlan: IModelProvider[] = [];
    const api: IModelProvider[] = [];
    for (const p of filteredProviders) {
      if (p.category === 'coding_plan') {
        codingPlan.push(p);
      } else {
        api.push(p);
      }
    }
    const groups: IProviderGroup[] = [];
    if (codingPlan.length > 0) {
      groups.push({ category: 'coding_plan', label: t('模型 Coding Plan'), providers: codingPlan });
    }
    if (api.length > 0) {
      groups.push({ category: 'api', label: t('模型 API'), providers: api });
    }
    return groups;
  }, [filteredProviders]);

  // ── Hermes 已配置 provider 列表 ──
  const hermesProviderList = useMemo(() => {
    return configData?.providers ?? [];
  }, [configData?.providers]);

  // ── 命令引用（Hermes / acli） ──
  const hermesModelCmds = scriptCommands.hermes.model;

  // ── 操作：保存预设 provider ──
  const saveProvider = useCallback(
    async ({ providerValue, modelId, apiKey: inputApiKey }: ISaveProviderParams): Promise<boolean> => {
      setSaving(true);
      setCurrentAction('add_model');
      try {
        const providerInfo = filteredProviders.find((p) => p.value === providerValue);
        if (!providerInfo) {
          setSaving(false);
          setCurrentAction('');
          return false;
        }

        // 腾讯系 provider 自动获取 key
        let key = inputApiKey;
        const _isTencentProvider = productConfig.isTencentProvider?.(providerValue) ?? false;
        if (_isTencentProvider) {
          key = await (productConfig.getTencentApiKey?.(providerValue, modelId) ?? '');
        }
        if (!key) {
          setSaving(false);
          setCurrentAction('');
          return false;
        }

        const models = providerInfo.models.map((m) => ({ id: m.id, name: m.name, input: m.input }));

        // 用 providerValue（如 minimax_coding）作为唯一标识
        const providerName = providerValue;
        const saveCmd = hermesModelCmds.getProviderSaveCommand({
          name: providerName,
          baseUrl: providerInfo.base_url ?? '',
          api: normalizeHermesApi(providerInfo.api ?? ''),
          apiKey: key,
          models: models.map((m) => ({ id: m.id, name: m.name })),
        });
        const saveResult = await executor.run({ command: saveCmd });
        if (!saveResult.success) {
          setSaving(false);
          setCurrentAction('');
          return false;
        }
        const switchCmd = hermesModelCmds.getModelSwitchCommand(`${providerName}/${modelId}`);
        const switchResult = await executor.run({ command: switchCmd });
        if (!switchResult.success) {
          setSaving(false);
          setCurrentAction('');
          return false;
        }

        setCurrentAction('');
        setSaving(false);
        await restartAndRefresh();
        return true;
      } catch {
        setCurrentAction('');
        setSaving(false);
        return false;
      }
    },
    [
      filteredProviders,
      productConfig,
      executor,
      hermesModelCmds,
      restartAndRefresh,
      setCurrentAction,
    ],
  );

  // ── 操作：保存自定义模型 ──
  const saveCustomModel = useCallback(
    async (customParams: ISaveCustomModelParams): Promise<boolean> => {
      setSaving(true);
      setCurrentAction('add_model');
      try {
        // Hermes 下加 custom_ 前缀避免与内置 provider 冲突
        const providerName = normalizeCustomProvider(customParams.provider || 'custom');

        const saveCmd = hermesModelCmds.getProviderSaveCommand({
          name: providerName,
          baseUrl: customParams.baseUrl,
          api: normalizeHermesApi(customParams.api),
          apiKey: customParams.apiKey,
          models: customParams.models.map((m) => ({ id: m.id, name: m.name })),
        });
        const saveResult = await executor.run({ command: saveCmd });
        if (!saveResult.success) {
          setSaving(false);
          setCurrentAction('');
          return false;
        }
        const switchCmd = hermesModelCmds.getModelSwitchCommand(`${providerName}/${customParams.models[0].id}`);
        const switchResult = await executor.run({ command: switchCmd });
        if (!switchResult.success) {
          setSaving(false);
          setCurrentAction('');
          return false;
        }

        setCurrentAction('');
        setSaving(false);
        await restartAndRefresh();
        return true;
      } catch {
        setCurrentAction('');
        setSaving(false);
        return false;
      }
    },
    [
      executor,
      hermesModelCmds,
      restartAndRefresh,
      setCurrentAction,
    ],
  );

  // ── 操作：从 JSON 保存自定义模型 ──
  const saveCustomModelFromJson = useCallback(
    async (json: string): Promise<boolean> => {
      const parsed = parseCustomModelJson(json);
      if (!parsed) return false;
      return saveCustomModel(parsed);
    },
    [saveCustomModel],
  );

  // ── 操作：删除 provider ──
  const deleteProvider = useCallback(
    async (providerName: string, isInUse?: boolean): Promise<boolean> => {
      setDeleting(providerName);
      setCurrentAction('delete_provider');
      try {
        const command = hermesModelCmds.getDeleteCommand({ providerName });
        const result = await executor.run({ command });
        setDeleting(null);
        setCurrentAction('');
        if (result.success) {
          await restartAndRefresh(isInUse);
          return true;
        }
        return false;
      } catch {
        setDeleting(null);
        setCurrentAction('');
        return false;
      }
    },
    [executor, hermesModelCmds, restartAndRefresh, setCurrentAction],
  );

  // ── 操作：Hermes 切换模型 ──
  const hermesSwitchModelWithResult = useCallback(
    async (modelId: string, providerName: string): Promise<IModelSwitchResult> => {
      const fullModelId = `${providerName}/${modelId}`;
      setSwitching(providerName);
      setCurrentAction('model_apply');
      try {
        const switchCmd = hermesModelCmds.getModelSwitchCommand(fullModelId);
        const result = await executor.run({ command: switchCmd });
        // 切换后重启网关
        if (result.success) {
          const restartCmd = scriptCommands.hermes.gateway.getRestartCommand();
          await executor.run({ command: restartCmd });
        }
        setSwitching(null);
        setCurrentAction('');
        if (result.success) {
          await restartAndRefresh();
          return { success: true };
        }
        return { success: false, error: result.output };
      } catch {
        setSwitching(null);
        setCurrentAction('');
        return { success: false };
      }
    },
    [executor, hermesModelCmds, scriptCommands, restartAndRefresh, setCurrentAction],
  );

  const hermesSwitchModel = useCallback(
    async (modelId: string, providerName: string): Promise<boolean> =>
      (await hermesSwitchModelWithResult(modelId, providerName)).success,
    [hermesSwitchModelWithResult],
  );

  // ── 操作：检测当前模型连通性（Hermes/acli） ──
  const probeModel = useCallback(
    async (params?: IHermesModelProbeParams): Promise<boolean> => {
      if (probing) return false;
      setProbing(true);
      setModelProbeResult(null);
      setModelProbeError(null);
      setCurrentAction('model_probe');
      try {
        const result = await executor.run({
          command: hermesModelCmds.getModelProbeCommand(params),
          timeout: 60,
        });
        if (!result.success) {
          setModelProbeError(t('模型连通性检查失败'));
          return false;
        }

        const parsed = parseHermesModelProbe(result.output);
        if (!parsed.ok) {
          setModelProbeError(t('模型连通性结果解析失败'));
          return false;
        }

        setModelProbeResult(parsed.data);
        const failedResult = parsed.data.results?.find((item) => item.success === false);
        const success = isHermesModelProbeSuccessful(parsed.data);
        if (!success) {
          setModelProbeError(
            failedResult?.error_message || parsed.data.error_message || parsed.data.message || t('模型连通性检查失败'),
          );
        }
        return success;
      } catch {
        // Remote execution errors may contain the command and API key, so intentionally avoid logging the raw error.
        setModelProbeError(t('模型连通性检查失败'));
        return false;
      } finally {
        setProbing(false);
        setCurrentAction('');
      }
    },
    [executor, hermesModelCmds, probing, setCurrentAction],
  );

  // ── 工具方法 ──
  const isTencentProvider = useCallback(
    (providerValue: string) => productConfig.isTencentProvider?.(providerValue) ?? false,
    [productConfig],
  );

  const getTencentApiKey = useCallback(
    async (providerValue: string, modelId: string) =>
      (await productConfig.getTencentApiKey?.(providerValue, modelId)) ?? '',
    [productConfig],
  );

  const handleRefresh = useCallback(async () => {
    await refresh();
  }, [refresh]);

  return {
    // 数据
    configData,
    loading,
    providerGroups,
    filteredProviders,
    hermesProviderList,

    // 操作
    saveProvider,
    saveCustomModel,
    saveCustomModelFromJson,
    deleteProvider,
    hermesSwitchModel,
    hermesSwitchModelWithResult,
    probeModel,
    refresh: handleRefresh,

    // 状态
    currentAction,
    saving,
    deleting,
    switching,
    probing,
    modelProbeResult,
    modelProbeError,

    // 功能特性
    isTencentProvider,
    getTencentApiKey,
  };
}
