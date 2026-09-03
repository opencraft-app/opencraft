/**
 * @deprecated 死代码：已被 agent-model-config/AgentModelConfigPanel 取代（零引用）。
 * 本文件是 config-panel-migration（!3110）从 tea-sdk 迁移本地化后未删除的旧实现。
 * 暂留作迁移期参考，待线上版本稳定后删除（2026-08-26 决策）。
 *
 * @fileoverview ModelPanel — Standard 变体模型配置面板
 *
 * 交互设计：
 *  - 顶部「当前模型」状态条（已配置 / 暂未配置）
 *  - 三个 Tab：「模型 Coding Plan（推荐）」/「模型 API」/「自定义模型」
 *  - 表单：Provider 选择 → 模型选择 → API Key → 保存
 *
 * 不依赖 TEA Component，只输出 HTML + BEM class name。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import './agent-config/styles-index.css';
import { t } from "@/i18n/t";
import { ChevronDown, ChevronRight, Trash2, Eye, EyeOff, Loader2 } from 'lucide-react';
import {
  useModelOperations,
  CUSTOM_JSON_PLACEHOLDER,
  normalizeCustomProvider,
  message,
  parseJsonWithNormalizedWhitespace,
  getModelSwitchFailureMessage,
  isHermesModelProbeSuccessful,
  type ModelPanelProps,
  type ModelConfigKind,
  type CustomApiMode,
  type CustomInputMode,
  type IHermesModelProbeParams,
  type IHermesModelProbeResult,
} from './agent-config';

const CLS = 'lh-std-model-panel';

const isCustomProviderName = (name: string) => {
  const normalized = (name || '').trim().toLowerCase();
  return normalized === 'custom' || normalized.startsWith('custom_');
};

interface IModelProbeNotice {
  success: boolean;
  result: IHermesModelProbeResult | null;
  error: string | null;
}

interface ICustomProbeModelCandidate {
  id?: unknown;
}

interface ICustomProbeConfig {
  provider?: unknown;
  base_url?: unknown;
  api?: unknown;
  api_key?: unknown;
  model?: ICustomProbeModelCandidate;
  models?: ICustomProbeModelCandidate[];
}

const getProbeErrorMessage = (raw?: string | null, errorCode?: number): string => {
  if (!raw) return '';
  let messageText = raw;
  try {
    const parsed = JSON.parse(raw);
    messageText = parsed?.error?.message || parsed?.message || raw;
  } catch {
    // ACLI may return a plain-text provider error instead of JSON.
  }
  const safeMessage = messageText
    .replace(/\bsk-[a-z0-9._-]+\b/gi, 'sk-****')
    .replace(/(api[_ -]?key\s*[:=]\s*)[^\s,;"'}]+/gi, '$1****')
    .trim();
  const isAuthenticationError =
    errorCode === 401 ||
    /token.*(?:expired|incorrect|invalid)|authentication\s*(?:fails?|failed)|api\s*key.*(?:invalid|expired|incorrect)|unauthorized|invalid.*api\s*key/i.test(
      safeMessage,
    );
  if (isAuthenticationError) return t('API Key 无效或已过期，请检查后重试');

  const isHtmlResponse = /<\s*(?:!doctype|html|head|body|meta|title|script|style)\b/i.test(safeMessage);
  const isNonJsonResponse = /\bnon-json\s+response\b/i.test(safeMessage);
  if (isHtmlResponse || isNonJsonResponse) {
    if (errorCode === -4) {
      return t('模型服务返回了非 JSON 内容，请检查 API 地址是否为兼容模型接口（如 /v1）。');
    }
    return t('模型服务返回了网页内容，请检查 API 地址是否填写为模型服务接口。');
  }

  return safeMessage.length > 240 ? `${safeMessage.slice(0, 240)}...` : safeMessage;
};

export function ModelPanel(props: ModelPanelProps) {
  const { className, ...baseProps } = props;

  const ops = useModelOperations(baseProps);

  // ── Tab 状态 ──
  const [activeKind, setActiveKind] = useState<ModelConfigKind>('coding_plan');

  // ── Coding Plan 表单状态 ──
  const [codingPlanId, setCodingPlanId] = useState('');
  const [codingPlanModelId, setCodingPlanModelId] = useState('');
  const [codingPlanApiKey, setCodingPlanApiKey] = useState('');
  const [codingPlanKeyVisible, setCodingPlanKeyVisible] = useState(false);

  // ── API 表单状态 ──
  const [apiProviderId, setApiProviderId] = useState('');
  const [apiModelId, setApiModelId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyVisible, setApiKeyVisible] = useState(false);

  // ── 自定义模型状态 ──
  const [customInputMode, setCustomInputMode] = useState<CustomInputMode>('form');
  const [customProvider, setCustomProvider] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customModelId, setCustomModelId] = useState('');
  const [customModelName, setCustomModelName] = useState('');
  const [customApiKey, setCustomApiKey] = useState('');
  const [customApiKeyVisible, setCustomApiKeyVisible] = useState(false);
  const [customApiMode, setCustomApiMode] = useState<CustomApiMode>('openai-completions');
  const [customJsonText, setCustomJsonText] = useState('');
  const [customJsonError, setCustomJsonError] = useState<string | null>(null);
  const [probeNotice, setProbeNotice] = useState<IModelProbeNotice | null>(null);

  useEffect(() => {
    if (ops.probing) return;
    if (!ops.modelProbeResult && ops.modelProbeError) {
      setProbeNotice(null);
      message.error({ content: t('模型检测未能完成，请检查输入内容后重试') });
      return;
    }
    if (!ops.modelProbeResult) return;
    setProbeNotice({
      success: isHermesModelProbeSuccessful(ops.modelProbeResult),
      result: ops.modelProbeResult,
      error: ops.modelProbeError,
    });
  }, [ops.probing, ops.modelProbeResult, ops.modelProbeError]);

  // ── 派生数据 ──
  const codingPlanProviders = useMemo(
    () => ops.providerGroups.find((g) => g.category === 'coding_plan')?.providers ?? [],
    [ops.providerGroups],
  );
  const apiProviders = useMemo(
    () => ops.providerGroups.find((g) => g.category === 'api')?.providers ?? [],
    [ops.providerGroups],
  );

  const activeCodingPlan = useMemo(
    () => codingPlanProviders.find((p) => p.value === codingPlanId),
    [codingPlanProviders, codingPlanId],
  );
  const activeApiProvider = useMemo(
    () => apiProviders.find((p) => p.value === apiProviderId),
    [apiProviders, apiProviderId],
  );

  // ── 默认选中逻辑 ──
  useEffect(() => {
    if (!codingPlanId && codingPlanProviders.length > 0) {
      const preferred = codingPlanProviders.find((p) => p.value === 'tencent_token_plan') ?? codingPlanProviders[0];
      if (preferred) setCodingPlanId(preferred.value);
    }
  }, [codingPlanProviders, codingPlanId]);

  useEffect(() => {
    if (activeCodingPlan && !codingPlanModelId && activeCodingPlan.models[0]) {
      setCodingPlanModelId(activeCodingPlan.models[0].id);
    }
  }, [activeCodingPlan, codingPlanModelId]);

  useEffect(() => {
    if (activeApiProvider && !apiModelId && activeApiProvider.models[0]) {
      setApiModelId(activeApiProvider.models[0].id);
    }
  }, [activeApiProvider, apiModelId]);

  // 模型 API：默认选第一个 provider
  useEffect(() => {
    if (!apiProviderId && apiProviders.length > 0) {
      const first = apiProviders[0];
      if (first) setApiProviderId(first.value);
    }
  }, [apiProviders, apiProviderId]);

  // ── 校验 ──
  const canSave = useMemo(() => {
    if (ops.saving) return false;
    if (activeKind === 'coding_plan') {
      return Boolean(codingPlanId) && Boolean(codingPlanModelId) && codingPlanApiKey.trim().length > 0;
    }
    if (activeKind === 'api') {
      return Boolean(apiProviderId) && Boolean(apiModelId) && apiKey.trim().length > 0;
    }
    if (customInputMode === 'json') return customJsonText.trim().length > 0;
    return (
      customProvider.trim().length > 0 &&
      customBaseUrl.trim().length > 0 &&
      customModelId.trim().length > 0 &&
      customModelName.trim().length > 0 &&
      customApiKey.trim().length > 0
    );
  }, [
    ops.saving,
    activeKind,
    codingPlanId,
    codingPlanModelId,
    codingPlanApiKey,
    apiProviderId,
    apiModelId,
    apiKey,
    customInputMode,
    customJsonText,
    customProvider,
    customBaseUrl,
    customModelId,
    customModelName,
    customApiKey,
  ]);

  // ── 保存操作 ──
  const handleSave = useCallback(async () => {
    if (!canSave) return;

    let success = false;
    try {
      if (activeKind === 'coding_plan') {
        success = await ops.saveProvider({
          providerValue: codingPlanId,
          modelId: codingPlanModelId,
          apiKey: codingPlanApiKey.trim(),
        });
      } else if (activeKind === 'api') {
        success = await ops.saveProvider({
          providerValue: apiProviderId,
          modelId: apiModelId,
          apiKey: apiKey.trim(),
        });
      } else if (customInputMode === 'json') {
        success = await ops.saveCustomModelFromJson(customJsonText);
        if (!success) {
          setCustomJsonError(t('配置格式错误或缺少必要字段'));
          message.error({ content: t('配置格式错误或缺少必要字段') });
          return;
        }
      } else {
        success = await ops.saveCustomModel({
          provider: customProvider.trim(),
          baseUrl: customBaseUrl.trim(),
          api: customApiMode,
          apiKey: customApiKey.trim(),
          models: [{ id: customModelId.trim(), name: customModelName.trim() }],
        });
      }

      if (success) {
        await ops.refresh();
        message.success({ content: t('已保存') });
      } else {
        message.error({ content: t('保存失败') });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('保存失败');
      message.error({ content: msg });
    }
  }, [
    canSave,
    activeKind,
    codingPlanId,
    codingPlanModelId,
    codingPlanApiKey,
    apiProviderId,
    apiModelId,
    apiKey,
    customInputMode,
    customJsonText,
    customProvider,
    customBaseUrl,
    customModelId,
    customModelName,
    customApiKey,
    customApiMode,
    ops,
  ]);

  // ── 已配置模型列表（从 ops 数据获取） ──
  const configuredModels = useMemo(() => {
    // Hermes: acli 返回的 name 是 value（如 minimax_domestic），需转为可读名
    const getDisplayName = (name: string) => {
      if (isCustomProviderName(name)) return t('自定义');
      const matched = ops.filteredProviders.find((p) => p.value === name || p.provider === name);
      return matched?.provider_name || name;
    };
    return ops.hermesProviderList.map((p: any) => ({
      name: p.name || p.provider || '',
      label: getDisplayName(p.name || p.provider || ''),
      currentModel: p.currentModel || '',
      isDefault: !!p.isDefault,
      models: (p.models || []).map((m: any) => ({ id: m.id, name: m.name || m.id })),
    }));
  }, [ops.hermesProviderList, ops.filteredProviders]);

  // ── 已配置列表中每个 provider 选中的 model ──
  const [selectedModelMap, setSelectedModelMap] = useState<Record<string, string>>({});
  // ── 当前展开的 provider ──
  const [expandedProvider, setExpandedProvider] = useState<string>('');

  // ── 切换激活模型 ──
  const handleSwitchModel = useCallback(
    async (providerName: string, modelId: string) => {
      const result = await ops.hermesSwitchModelWithResult(modelId, providerName);
      if (result.success) {
        await ops.refresh();
        message.success({ content: t('已切换当前生效的模型') });
      } else {
        const errorMessage = getModelSwitchFailureMessage(
          result.error,
          t('切换失败'),
          t('当前模型暂不可用，请稍后重试或切换模型。'),
        );
        if (errorMessage) message.error({ content: errorMessage });
      }
    },
    [ops],
  );

  // ── 删除确认弹窗状态 ──
  const [pendingDelete, setPendingDelete] = useState<{ name: string; label: string } | null>(null);

  const handleDeleteProvider = useCallback(
    (providerName: string) => {
      const item = configuredModels.find((m) => m.name === providerName);
      setPendingDelete({ name: providerName, label: item?.label || providerName });
    },
    [configuredModels],
  );

  const confirmDeleteProvider = useCallback(async () => {
    if (!pendingDelete) return;
    const isDefault = configuredModels.find((m) => m.name === pendingDelete.name)?.isDefault;
    const success = await ops.deleteProvider(pendingDelete.name, !!isDefault);
    setPendingDelete(null);
    if (success) {
      await ops.refresh();
      message.success({ content: t('已删除') });
    } else {
      message.error({ content: t('删除失败') });
    }
  }, [pendingDelete, configuredModels, ops]);

  // ── Tabs 配置 ──
  const tabs: { id: ModelConfigKind; label: string; recommended?: boolean }[] = [
    { id: 'coding_plan', label: t('模型 Coding Plan'), recommended: true },
    { id: 'api', label: t('模型 API') },
    { id: 'custom', label: t('自定义模型') },
  ];

  // ── 渲染辅助 ──
  const Select = DefaultSelect;
  const Input = DefaultInput;
  const Button = DefaultButton;
  const probeParams = useMemo<IHermesModelProbeParams | null>(() => {
    if (activeKind === 'coding_plan') {
      if (
        !codingPlanId ||
        !codingPlanModelId ||
        !codingPlanApiKey.trim() ||
        !activeCodingPlan?.base_url ||
        !activeCodingPlan.api
      )
        return null;
      return {
        provider: codingPlanId,
        model: codingPlanModelId,
        baseUrl: activeCodingPlan.base_url,
        apiKey: codingPlanApiKey.trim(),
        api: activeCodingPlan.api,
      };
    }
    if (activeKind === 'api') {
      if (!apiProviderId || !apiModelId || !apiKey.trim() || !activeApiProvider?.base_url || !activeApiProvider.api)
        return null;
      return {
        provider: apiProviderId,
        model: apiModelId,
        baseUrl: activeApiProvider.base_url,
        apiKey: apiKey.trim(),
        api: activeApiProvider.api,
      };
    }
    if (customInputMode === 'form') {
      if (
        !customProvider.trim() ||
        !customBaseUrl.trim() ||
        !customModelId.trim() ||
        !customApiKey.trim() ||
        !customApiMode
      )
        return null;
      return {
        provider: normalizeCustomProvider(customProvider),
        model: customModelId.trim(),
        baseUrl: customBaseUrl.trim(),
        apiKey: customApiKey.trim(),
        api: customApiMode,
      };
    }
    try {
      const config = parseJsonWithNormalizedWhitespace<ICustomProbeConfig>(customJsonText);
      const model = Array.isArray(config.models) ? config.models[0] : config.model;
      const provider = typeof config.provider === 'string' ? config.provider.trim() : '';
      const baseUrl = typeof config.base_url === 'string' ? config.base_url.trim() : '';
      const api = typeof config.api === 'string' ? config.api.trim() : '';
      const apiKey = typeof config.api_key === 'string' ? config.api_key.trim() : '';
      const modelId = typeof model?.id === 'string' ? model.id.trim() : '';
      if (!provider || !baseUrl || !api || !apiKey || !modelId) return null;
      return {
        provider: normalizeCustomProvider(provider),
        model: modelId,
        baseUrl,
        apiKey,
        api,
      };
    } catch {
      return null;
    }
  }, [
    activeKind,
    activeCodingPlan,
    activeApiProvider,
    codingPlanId,
    codingPlanModelId,
    codingPlanApiKey,
    apiProviderId,
    apiModelId,
    apiKey,
    customInputMode,
    customProvider,
    customBaseUrl,
    customModelId,
    customApiKey,
    customApiMode,
    customJsonText,
  ]);
  const canProbe = !ops.loading && !ops.saving && !ops.probing && probeParams !== null;
  const probeResultItem =
    probeNotice?.result?.results?.find((item) => item.success === false) || probeNotice?.result?.results?.[0];
  const probeFailureReason = probeNotice
    ? getProbeErrorMessage(
        probeNotice.error ||
          probeResultItem?.error_message ||
          probeNotice.result?.error_message ||
          t('模型连通性检查失败'),
        probeResultItem?.error_code ?? probeNotice.result?.error_code,
      )
    : '';

  return (
    <div className={`${CLS} ${className || ''}`}>
      <div className={`${CLS}__registry`}>
        <div className={`${CLS}__registry-header`}>
          <span className={`${CLS}__registry-title`}>
            {t('已配置模型')}
            {!ops.loading && configuredModels.length > 0 && (
              <span className={`${CLS}__registry-count`}>({configuredModels.length})</span>
            )}
          </span>
        </div>
        {ops.loading ? (
          <div className={`${CLS}__loader`}>{t('加载中...')}</div>
        ) : configuredModels.length === 0 ? (
          <p className={`${CLS}__registry-empty`}>{t('暂未配置')}</p>
        ) : (
          <ul className={`${CLS}__registry-list`}>
            {configuredModels.map((item) => {
              const busy = !!ops.deleting || !!ops.switching || ops.saving;
              const selectedModel = selectedModelMap[item.name] || item.currentModel;
              const isExpanded = expandedProvider === item.name;
              return (
                <li
                  key={item.name}
                  className={`${CLS}__registry-item ${item.isDefault ? `${CLS}__registry-item--active` : ''}`}
                >
                  <div
                    className={`${CLS}__registry-item-header`}
                    onClick={() => setExpandedProvider(isExpanded ? '' : item.name)}
                    role="button"
                    tabIndex={0}
                  >
                    <div className={`${CLS}__registry-info`}>
                      <span className={`${CLS}__registry-expand-icon`}>
                        {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </span>
                      <span
                        className={`${CLS}__registry-label ${item.isDefault ? `${CLS}__registry-label--active` : ''}`}
                      >
                        {item.label}
                      </span>
                      {item.isDefault && <span className={`${CLS}__registry-badge`}>{t('当前生效')}</span>}
                    </div>
                    <div className={`${CLS}__registry-actions`}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteProvider(item.name);
                        }}
                        className={`${CLS}__registry-delete`}
                        aria-label={t('删除')}
                      >
                        {ops.deleting === item.name ? (
                          <Loader2 size={16} className="lh-std-spin" />
                        ) : (
                          <Trash2 size={16} />
                        )}
                      </button>
                    </div>
                  </div>
                  {/* 展开：model radio 列表 + 切换按钮 */}
                  {isExpanded && item.models.length > 0 && (
                    <div className={`${CLS}__registry-models`}>
                      {item.models.map((m: { id: string; name: string }) => (
                        <label key={m.id} className={`${CLS}__registry-model-item`}>
                          <input
                            type="radio"
                            name={`model-${item.name}`}
                            value={m.id}
                            checked={selectedModel === m.id}
                            onChange={() => setSelectedModelMap((prev) => ({ ...prev, [item.name]: m.id }))}
                            className={`${CLS}__registry-model-radio`}
                          />
                          <span className={`${CLS}__registry-model-name`}>{m.name}</span>
                        </label>
                      ))}
                      <div className={`${CLS}__registry-switch-area`}>
                        <button
                          type="button"
                          disabled={busy || !selectedModel}
                          onClick={() => handleSwitchModel(item.name, selectedModel)}
                          className={`${CLS}__registry-switch-btn`}
                        >
                          {ops.switching === item.name ? t('切换中...') : t('切换为默认')}
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Tab 切换 */}
      <div className={`${CLS}__tabs`} role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeKind}
            className={`${CLS}__tab ${tab.id === activeKind ? `${CLS}__tab--active` : ''}`}
            onClick={() => setActiveKind(tab.id)}
          >
            <span>{tab.label}</span>
            {tab.recommended && <span className={`${CLS}__tab-badge`}>{t('推荐')}</span>}
          </button>
        ))}
      </div>

      {/* 表单区 */}
      <div className={`${CLS}__form`}>
        {activeKind === 'coding_plan' && (
          <div className={`${CLS}__form-section`}>
            <div className={`${CLS}__field`}>
              <label className={`${CLS}__label`}>{t('Coding Plan 套餐')}</label>
              <Select
                value={codingPlanId}
                onChange={(v: string) => {
                  setCodingPlanId(v);
                  setCodingPlanModelId('');
                }}
                options={codingPlanProviders.map((p) => ({
                  value: p.value,
                  label: p.provider_name,
                  description: p.description,
                }))}
                placeholder={t('请选择一个 Coding Plan')}
              />
              {activeCodingPlan?.description && (
                <div
                  className={`${CLS}__description`}
                  dangerouslySetInnerHTML={{ __html: activeCodingPlan.description }}
                />
              )}
            </div>
            <div className={`${CLS}__field`}>
              <label className={`${CLS}__label`}>{t('模型')}</label>
              <Select
                value={codingPlanModelId}
                onChange={setCodingPlanModelId}
                options={(activeCodingPlan?.models ?? []).map((m) => ({ value: m.id, label: m.name }))}
                placeholder={activeCodingPlan ? t('请选择模型') : t('请先选择 Coding Plan')}
                disabled={!activeCodingPlan}
              />
            </div>
            <div className={`${CLS}__field`}>
              <label className={`${CLS}__label`}>{t('API Key')}</label>
              <div className={`${CLS}__key-field`}>
                <Input
                  type={codingPlanKeyVisible ? 'text' : 'password'}
                  value={codingPlanApiKey}
                  onChange={setCodingPlanApiKey}
                  placeholder={t('请输入 API Key')}
                />
                <button
                  type="button"
                  className={`${CLS}__eye-btn`}
                  onClick={() => setCodingPlanKeyVisible((v) => !v)}
                  aria-label={codingPlanKeyVisible ? t('隐藏 API Key') : t('显示 API Key')}
                >
                  {codingPlanKeyVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {activeCodingPlan?.api_key_url && (
                <a
                  className={`${CLS}__api-key-link`}
                  href={activeCodingPlan.api_key_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('获取 API Key')}
                </a>
              )}
            </div>
          </div>
        )}

        {activeKind === 'api' && (
          <div className={`${CLS}__form-section`}>
            <div className={`${CLS}__field`}>
              <label className={`${CLS}__label`}>{t('模型服务商')}</label>
              <Select
                value={apiProviderId}
                onChange={(v: string) => {
                  setApiProviderId(v);
                  setApiModelId('');
                }}
                options={apiProviders.map((p) => ({ value: p.value, label: p.provider_name }))}
                placeholder={t('请选择一个模型服务商')}
              />
              {activeApiProvider?.description && (
                <div
                  className={`${CLS}__description`}
                  dangerouslySetInnerHTML={{ __html: activeApiProvider.description }}
                />
              )}
            </div>
            <div className={`${CLS}__field`}>
              <label className={`${CLS}__label`}>{t('模型')}</label>
              <Select
                value={apiModelId}
                onChange={setApiModelId}
                options={(activeApiProvider?.models ?? []).map((m) => ({ value: m.id, label: m.name }))}
                placeholder={activeApiProvider ? t('请选择模型') : t('请先选择模型服务商')}
                disabled={!activeApiProvider}
              />
            </div>
            <div className={`${CLS}__field`}>
              <label className={`${CLS}__label`}>{t('API Key')}</label>
              <div className={`${CLS}__key-field`}>
                <Input
                  type={apiKeyVisible ? 'text' : 'password'}
                  value={apiKey}
                  onChange={setApiKey}
                  placeholder={t('请输入 API Key')}
                />
                <button
                  type="button"
                  className={`${CLS}__eye-btn`}
                  onClick={() => setApiKeyVisible((v) => !v)}
                  aria-label={apiKeyVisible ? t('隐藏 API Key') : t('显示 API Key')}
                >
                  {apiKeyVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {activeApiProvider?.api_key_url && (
                <a
                  className={`${CLS}__api-key-link`}
                  href={activeApiProvider.api_key_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('获取 API Key')}
                </a>
              )}
            </div>
          </div>
        )}

        {activeKind === 'custom' && (
          <div className={`${CLS}__form-section`}>
            <div className={`${CLS}__custom-mode-switch`}>
              <button
                type="button"
                className={`${CLS}__custom-mode-btn ${
                  customInputMode === 'form' ? `${CLS}__custom-mode-btn--active` : ''
                }`}
                onClick={() => setCustomInputMode('form')}
              >
                {t('表单输入')}
              </button>
              <span className={`${CLS}__custom-mode-divider`}>|</span>
              <button
                type="button"
                className={`${CLS}__custom-mode-btn ${
                  customInputMode === 'json' ? `${CLS}__custom-mode-btn--active` : ''
                }`}
                onClick={() => {
                  setCustomInputMode('json');
                  setCustomJsonError(null);
                }}
              >
                {t('JSON 输入')}
              </button>
            </div>

            {customInputMode === 'form' ? (
              <>
                <div className={`${CLS}__field`}>
                  <label className={`${CLS}__label`}>{t('Provider')}</label>
                  <Input
                    value={customProvider}
                    onChange={setCustomProvider}
                    placeholder={t('请输入自定义模型 provider')}
                  />
                </div>
                <div className={`${CLS}__field`}>
                  <label className={`${CLS}__label`}>{t('Base URL')}</label>
                  <Input value={customBaseUrl} onChange={setCustomBaseUrl} placeholder="https://api.example.com/v1" />
                </div>
                <div className={`${CLS}__field`}>
                  <label className={`${CLS}__label`}>{t('兼容协议')}</label>
                  <Select
                    value={customApiMode}
                    onChange={(v: string) => setCustomApiMode(v as CustomApiMode)}
                    options={[
                      { value: 'openai-completions', label: 'OpenAI Completions' },
                      { value: 'anthropic-messages', label: 'Anthropic Messages' },
                    ]}
                  />
                </div>
                <div className={`${CLS}__field`}>
                  <label className={`${CLS}__label`}>{t('API Key')}</label>
                  <div className={`${CLS}__key-field`}>
                    <Input
                      type={customApiKeyVisible ? 'text' : 'password'}
                      value={customApiKey}
                      onChange={setCustomApiKey}
                      placeholder={t('请输入 API Key')}
                    />
                    <button
                      type="button"
                      className={`${CLS}__eye-btn`}
                      onClick={() => setCustomApiKeyVisible((v) => !v)}
                    >
                      {customApiKeyVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
                <div className={`${CLS}__field`}>
                  <label className={`${CLS}__label`}>{t('Model ID')}</label>
                  <Input
                    value={customModelId}
                    onChange={setCustomModelId}
                    placeholder={t('请输入自定义模型 model.id')}
                  />
                </div>
                <div className={`${CLS}__field`}>
                  <label className={`${CLS}__label`}>{t('Model Name')}</label>
                  <Input
                    value={customModelName}
                    onChange={setCustomModelName}
                    placeholder={t('请输入自定义模型 model.name')}
                  />
                </div>
              </>
            ) : (
              <div className={`${CLS}__field`}>
                <label className={`${CLS}__label`}>{t('JSON 配置')}</label>
                <textarea
                  className={`${CLS}__json-input ${customJsonError ? `${CLS}__json-input--error` : ''}`}
                  value={customJsonText}
                  onChange={(e) => {
                    setCustomJsonText(e.target.value);
                    if (customJsonError) setCustomJsonError(null);
                  }}
                  rows={10}
                  spellCheck={false}
                  placeholder={CUSTOM_JSON_PLACEHOLDER}
                />
                {customJsonError && <div className={`${CLS}__error`}>{customJsonError}</div>}
              </div>
            )}
          </div>
        )}

        {/* 保存按钮 */}
        <div className={`${CLS}__save-area`} style={{ columnGap: 8 }}>
          <Button
            variant="outline"
            onClick={async () => {
              if (!probeParams) return;
              setProbeNotice(null);
              await ops.probeModel(probeParams);
            }}
            disabled={!canProbe}
            loading={ops.probing}
          >
            {ops.probing ? t('检测中...') : t('模型检测')}
          </Button>
          <Button onClick={handleSave} disabled={!canSave} loading={ops.saving}>
            {ops.saving ? t('保存中...') : `+ ${t('添加并应用')}`}
          </Button>
        </div>
      </div>

      {probeNotice && (
        <div
          className={`${CLS}__modal-overlay`}
          onClick={(e) => {
            if (e.target === e.currentTarget) setProbeNotice(null);
          }}
        >
          <div
            className={`${CLS}__modal ${CLS}__probe-modal`}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${CLS}-probe-title`}
          >
            <button
              type="button"
              className={`${CLS}__probe-modal-dismiss`}
              onClick={() => setProbeNotice(null)}
              aria-label={t('关闭')}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <div className={`${CLS}__probe-modal-heading`}>
              <span
                className={`${CLS}__probe-modal-icon ${
                  probeNotice.success ? `${CLS}__probe-modal-icon--success` : `${CLS}__probe-modal-icon--error`
                }`}
                aria-hidden="true"
              >
                {probeNotice.success ? (
                  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" fill="#16a34a" />
                    <path
                      d="m7 12 3.2 3.2L17.5 8"
                      fill="none"
                      stroke="#fff"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : (
                  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" fill="#dc2626" />
                    <path
                      d="m8.5 8.5 7 7M15.5 8.5l-7 7"
                      fill="none"
                      stroke="#fff"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                    />
                  </svg>
                )}
              </span>
              <h3 id={`${CLS}-probe-title`} className={`${CLS}__modal-title ${CLS}__probe-modal-title`}>
                {probeNotice.success ? t('模型连接成功') : t('模型连接失败')}
              </h3>
            </div>
            {!probeNotice.success && probeFailureReason && (
              <p className={`${CLS}__modal-desc ${CLS}__probe-modal-reason`}>
                {t('原因')}: {probeFailureReason}
              </p>
            )}
            {probeNotice.result && (
              <div className={`${CLS}__probe-modal-details`}>
                {probeNotice.result.provider && (
                  <div>
                    <span>{t('模型服务商')}: </span>
                    <strong>{probeNotice.result.provider}</strong>
                  </div>
                )}
                {probeNotice.result.model && (
                  <div>
                    <span>{t('模型')}: </span>
                    <strong>{probeNotice.result.model}</strong>
                  </div>
                )}
                {probeNotice.result.base_url && (
                  <div>
                    <span>{t('API 地址')}: </span>
                    <strong>{probeNotice.result.base_url}</strong>
                  </div>
                )}
                {!probeNotice.success &&
                  (probeResultItem?.error_code ?? probeNotice.result.error_code) !== undefined && (
                    <div>
                      <span>{t('错误码')}: </span>
                      <strong>{probeResultItem?.error_code ?? probeNotice.result.error_code}</strong>
                    </div>
                  )}
                {probeNotice.success && probeNotice.result.time_ms !== undefined && (
                  <div>
                    <span>{t('响应时间')}: </span>
                    <strong>{probeNotice.result.time_ms} ms</strong>
                  </div>
                )}
              </div>
            )}
            <div className={`${CLS}__modal-actions ${CLS}__probe-modal-actions`}>
              <button type="button" className={`${CLS}__probe-modal-ok`} onClick={() => setProbeNotice(null)}>
                {t('确定')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认弹窗 */}
      {pendingDelete && (
        <div
          className={`${CLS}__modal-overlay`}
          onClick={(e) => {
            if (e.target === e.currentTarget) setPendingDelete(null);
          }}
        >
          <div className={`${CLS}__modal`}>
            <h3 className={`${CLS}__modal-title`}>{t('确认删除模型配置？')}</h3>
            <p className={`${CLS}__modal-desc`}>
              {t('确认删除「{{name}}」？删除后该模型将不可用，直到重新配置。', { name: pendingDelete.label })}
            </p>
            <div className={`${CLS}__modal-actions`}>
              <Button variant="outline" onClick={() => setPendingDelete(null)} disabled={!!ops.deleting}>
                {t('取消')}
              </Button>
              <Button
                variant="danger"
                onClick={confirmDeleteProvider}
                loading={!!ops.deleting}
                disabled={!!ops.deleting}
              >
                {ops.deleting ? t('删除中...') : t('确认删除')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 内置简单的默认渲染组件（无样式） ───

function DefaultSelect(props: any) {
  const [open, setOpen] = useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const selectedOpt = (props.options || []).find((o: any) => o.value === props.value);
  const displayText = selectedOpt?.label || props.placeholder || '';

  // 点击外部关闭
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className={`lh-std-select-wrapper ${open ? 'lh-std-select-wrapper--open' : ''}`} ref={containerRef}>
      <button
        type="button"
        className={`lh-std-select ${props.disabled ? 'lh-std-select--disabled' : ''}`}
        onClick={() => !props.disabled && setOpen((v) => !v)}
      >
        <span className={`lh-std-select__text ${!selectedOpt ? 'lh-std-select__text--placeholder' : ''}`}>
          {displayText}
        </span>
        <ChevronDown size={16} className={`lh-std-select__arrow ${open ? 'lh-std-select__arrow--open' : ''}`} />
      </button>
      {open && (
        <div className="lh-std-select__dropdown">
          {(props.options || []).map((opt: any) => (
            <div
              key={opt.value}
              className={`lh-std-select__option ${opt.value === props.value ? 'lh-std-select__option--active' : ''}`}
              onClick={() => {
                props.onChange(opt.value);
                setOpen(false);
              }}
            >
              {opt.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DefaultInput(props: any) {
  return (
    <input
      className="lh-std-input"
      type={props.type || 'text'}
      value={props.value}
      disabled={props.disabled}
      placeholder={props.placeholder}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}

function DefaultButton(props: any) {
  return (
    <button
      type="button"
      className={`lh-std-button lh-std-button--${props.variant || 'primary'}`}
      disabled={props.disabled || props.loading}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
