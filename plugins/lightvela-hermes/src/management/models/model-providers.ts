// UI localization is supplied by the Workbench. Provider business metadata
// keeps mono2's source strings as its deterministic fallback catalogue.
const t = (value: string, ..._args: unknown[]): string => value;
const IS_I18N = false;

/**
 * 腾讯系 provider 列表（apiKey 自动获取，无需用户手动输入）
 *
 * 这些 provider 的 `getTencentApiKey` 实现**强依赖腾讯云 CAPI**：
 *   - hunyuan             → QueryHunyuanUserStatus / GetHunyuanAPIKey (+ 开通服务/后付费 / MFA 弹窗)
 *   - qcloud_lkeap        → DescribeLkeapOpenStatus / ListLkeapPostpaidProduct / ...
 *   - tencent_coding_plan → DescribeCodingPlanPkg / ListCodingPlanAPIKey / GetHunyuanAPIKey
 *   - tencent_token_plan  → DescribeTokenPlanUsage / ListTokenPlanAPIKey / GetHunyuanAPIKey
 *
 * 在非腾讯云账号体系的宿主（如 mono 平台）下，CAPI 调用会全部失败。
 * 宿主可在 `IProductConfig.supportsTencentCloudApi = false` 时由 SDK 自动屏蔽这些 provider。
 */
export const TENCENT_PROVIDERS = [
  'hunyuan',
  'qcloud_lkeap',
  'tencent_coding_plan',
  'tencent_token_plan',
  'tencent_hy_token_plan',
];

/** 国际站屏蔽的 provider 列表（仅国内站展示） */
export const I18N_HIDDEN_PROVIDERS = [
  'hunyuan',
  'qcloud_lkeap',
  'tencent_coding_plan',
  'tencent_token_plan',
  'tencent_token_plan_enterprise_lite',
  'tencent_token_plan_enterprise_pro',
  'tencent_hy_token_plan',
  'minimax_domestic',
  'minimax_coding',
  'moonshot_domestic',
  'zhipu',
  'glmcode',
  'baidu',
  'baiducode',
];

/** 国内站屏蔽的 provider 列表（仅国际站展示） */
export const DOMESTIC_HIDDEN_PROVIDERS = [
  'openai',
  'openai_codex',
  'anthropic',
  'google_gemini',
  'openrouter',
  'minimax_international',
  'moonshot_international',
  'zai',
  'zaicode',
];

/**
 * 国际站专属 provider 列表（仅国际站展示，国内站屏蔽）
 *
 * 2026-08 新增：国际站版 Token Plan 套餐。条目由宿主通过七彩石 sourceList 下发
 * （SDK 内置列表暂无），国内站一律屏蔽，国际站全地域展示。
 * 注意与 DOMESTIC_HIDDEN_PROVIDERS 的维度差异：本名单按站点（IS_I18N）过滤，
 * DOMESTIC_HIDDEN_PROVIDERS 按机器地域（useOversea）过滤，原因见 getFilteredModelProviderList。
 */
export const INTL_ONLY_PROVIDERS = [
  'tencent_token_plan_intl',
  'tencent_token_plan_enterprise_lite_intl',
  'tencent_token_plan_enterprise_pro_intl',
];

/** 香港地域屏蔽的 provider 列表（这些服务商在香港地区未提供官方 API 服务或存在访问限制） */
export const HK_REGION_HIDDEN_PROVIDERS = ['openai', 'openai_codex', 'anthropic'];

/**
 * TokenHub base_url 国内/海外切换映射
 *
 * tokenhub 是国内+海外都展示的 provider，base_url 需按集合切换。
 * SDK 内置数据（MODEL_PROVIDER_LIST）默认填 domestic 值；
 * 海外业务方可在自己的过滤逻辑里 map 出 oversea 值。
 */
export const TOKENHUB_BASE_URL = {
  domestic: 'https://tokenhub.tencentmaas.com/v1',
  oversea: 'https://tokenhub-intl.tencentcloudmaas.com/v1',
};

/**
 * 根据站点与实例地域过滤模型提供商列表（OpenClaw 用，Hermes 复用同一套规则）
 *
 * 过滤规则按「屏蔽原因」区分维度，共四条：
 *  1. 国际站（IS_I18N）：不分地域屏蔽 I18N_HIDDEN_PROVIDERS——这些 provider 的
 *     一键配置强依赖国内站 hunyuan CAPI（仅 ap-guangzhou），国际站登录态下调用必报错
 *  2. 国内站（!IS_I18N）：屏蔽 INTL_ONLY_PROVIDERS（国际站专属 Token Plan 套餐）
 *  3. 国内集合（!useOverseaModelProviders）：屏蔽 DOMESTIC_HIDDEN_PROVIDERS——
 *     openai 等海外 API 从国内地域机器网络不可达，按机器地域而非站点过滤
 *  4. 香港地域（region === 'ap-hongkong'）：叠加屏蔽 OpenAI/Anthropic 等
 *
 * 另：tokenhub 为国内+海外共展示 provider，base_url 按机器地域切换海外域名。
 *
 * @param region 实例地域英文名，仅用于 `ap-hongkong` 的附加屏蔽，不负责判断国内/海外模型集合
 * @param sourceList 待过滤的完整模型列表，通常来自 `useModelProviders()`
 * @param useOverseaModelProviders 是否使用海外模型集合。调用方结合站点和实例地域计算的最终结果：
 * `true` 使用海外集合，`false` 使用国内集合。默认 IS_I18N
 * @param useOverseaTokenhubUrl tokenhub 是否使用海外域名。按机器地域判断，与集合切换解耦，
 * 默认跟随 useOverseaModelProviders
 * @param isI18n 站点是否国际站。默认取 SDK 内部 IS_I18N（@tencent/tea-app 的 site）；
 * 宿主有自己的站点判断或需要在单测中 mock 站点行为时可显式传入
 */
export function getFilteredModelProviderList<T extends IModelProvider>(
  region?: string,
  sourceList?: T[],
  useOverseaModelProviders?: boolean,
  useOverseaTokenhubUrl?: boolean,
  isI18n: boolean = IS_I18N,
): T[] {
  const list = sourceList ?? (MODEL_PROVIDER_LIST as unknown as T[]);
  const oversea = useOverseaModelProviders ?? isI18n;
  const tokenhubIntl = useOverseaTokenhubUrl ?? oversea;
  return list
    .filter((item) => {
      // 1. 国际站：屏蔽依赖国内 CAPI 一键配置的国内专属 provider（不分地域）
      if (isI18n && I18N_HIDDEN_PROVIDERS.includes(item.value)) return false;
      // 2. 国内站：屏蔽国际站专属 TokenPlan 套餐
      if (!isI18n && INTL_ONLY_PROVIDERS.includes(item.value)) return false;
      // 3. 国内集合：屏蔽海外专属 provider（国内地域机器网络不可达）
      if (!oversea && DOMESTIC_HIDDEN_PROVIDERS.includes(item.value)) return false;
      // 4. 香港叠加：官方未提供香港 API 服务或存在访问限制的服务商
      if (region === 'ap-hongkong' && HK_REGION_HIDDEN_PROVIDERS.includes(item.value)) return false;
      return true;
    })
    .map((item) =>
      item.value === 'tokenhub' && tokenhubIntl ? { ...item, base_url: TOKENHUB_BASE_URL.oversea } : item,
    );
}

/** 判断是否为腾讯系 provider */
export function isTencentProvider(value: string): boolean {
  return TENCENT_PROVIDERS.includes(value);
}

/** 模型提供商配置 */
export interface IModelProvider {
  /** 唯一标识，用于 Select/Cascader 的 value */
  value: string;
  /** 分类：coding_plan 为 Coding Plan 订阅模式，api 为直接 API 调用模式 */
  category: 'coding_plan' | 'api';
  /** 底层 provider 标识，用于写入 openclaw.json 配置 */
  provider: string;
  /** 显示名称（已国际化） */
  provider_name: string;
  /** 描述信息（可含 HTML） */
  description: string;
  /** API Key 获取地址 */
  api_key_url: string;
  /** API 基础地址 */
  base_url: string;
  /** API 协议类型，如 'openai-completions' | 'anthropic-messages' */
  api: string;
  /** 该提供商支持的模型列表 */
  models: Array<{
    id: string;
    name: string;
    input?: string[];
    isDefault?: boolean;
    contextWindow?: number;
    maxTokens?: number;
  }>;
  /** OAuth 授权配置（存在则支持 OAuth） */
  oauth?: {
    /** 脚本 init/poll 的 provider 参数（如 'codex'） */
    provider: string;
    /** gateway 生成的 models.json 中的 provider key（如 'openai-codex'），用于 parseConfigResult 匹配 */
    openclawProvider: string;
    /** 是否需要用户回填回调 URL（Authorization Code Flow） */
    requireCallbackUrl?: boolean;
    /** 是否为纯 OAuth 模式（不支持 API Key） */
    exclusive?: boolean;
    /** 写入 openclaw.json 的 provider 配置 */
    providerConfig?: {
      baseUrl: string;
      api: string;
    };
    /** 删除时是否需要清理 auth-profiles.json */
    cleanAuthProfile?: boolean;
    /** init 命令额外参数（如 'cn'），拼接在 provider 之后 */
    initArgs?: string;
    /** poll 命令固定参数（当 requireCallbackUrl=false 时替代回调 URL） */
    pollArgs?: string;
    /** OAuth 专属模型列表（写入 openclaw.json 时使用，不同于 providerInfo.models） */
    models?: Array<{
      id: string;
      name: string;
      input?: string[];
      isDefault?: boolean;
      contextWindow?: number;
      maxTokens?: number;
    }>;
  };
}

// 列表文案含 t()。原 SDK 的 i18n 词条由宿主在模块加载后才注册，顶层求值会拿到
// 未初始化的 i18n（返回中文 defaultValue 或空串），故曾用惰性 Proxy 推迟到首次访问。
// 本地化后 t() 走 @/i18n/t：构建期静态字典 + i18n 在模块顶层同步 init，
// 且经 import 依赖链先于本模块体求值，顶层直接求值即安全。

export const MODEL_PROVIDER_LIST: IModelProvider[] = [
    // 国际站专属模型（排在最前，国际站过滤后默认选中第一个）
    {
      value: 'openai',
      category: 'api',
      provider: 'openai',
      provider_name: 'OpenAI',
      description: t('OpenAI 系列模型，全球开发者使用最广泛的模型之一，适合代码生成、复杂推理与 Agent 开发场景。'),
      api_key_url: 'https://platform.openai.com/api-keys',
      base_url: 'https://api.openai.com/v1',
      api: 'openai-completions',
      models: [
        { id: 'gpt-5-mini', name: 'GPT-5 mini', input: ['text', 'image'] },
        { id: 'gpt-5.4', name: 'GPT-5.4', input: ['text', 'image'] },
        { id: 'gpt-4.1', name: 'GPT-4.1', input: ['text', 'image'] },
        { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini', input: ['text', 'image'] },
        { id: 'gpt-4.1-nano', name: 'GPT-4.1 nano', input: ['text', 'image'] },
        { id: 'o4-mini', name: 'o4-mini', input: ['text', 'image'] },
      ],
    },
    {
      value: 'openai_codex',
      category: 'coding_plan',
      provider: 'openai-codex',
      provider_name: 'OpenAI Codex (OAuth)',
      description:
        "Codex is OpenAI's coding agent that can read, edit, and run code. It helps you build faster, fix bugs, and understand unfamiliar code.",
      api_key_url: 'https://chatgpt.com/codex',
      base_url: 'https://api.openai.com/v1',
      api: 'openai-completions',
      models: [
        { id: 'gpt-5.1', name: 'GPT 5.1' },
        { id: 'gpt-5.1-codex-max', name: 'GPT 5.1 Codex Max' },
        { id: 'gpt-5.1-codex-mini', name: 'GPT 5.1 Codex Mini' },
        { id: 'gpt-5.2', name: 'GPT 5.2' },
        { id: 'gpt-5.2-codex', name: 'GPT 5.2 Codex' },
        { id: 'gpt-5.3-codex', name: 'GPT 5.3 Codex' },
        { id: 'gpt-5.3-codex-spark', name: 'GPT 5.3 Codex Spark' },
        { id: 'gpt-5.4', name: 'GPT 5.4', input: ['text', 'image'] },
      ],
      oauth: {
        provider: 'codex',
        openclawProvider: 'openai-codex',
        requireCallbackUrl: true,
        exclusive: true,
        providerConfig: {
          baseUrl: 'https://chatgpt.com/backend-api',
          api: 'openai-codex-responses',
        },
        cleanAuthProfile: true,
      },
    },
    {
      value: 'anthropic',
      category: 'api',
      provider: 'anthropic',
      provider_name: 'Anthropic',
      description: t('Anthropic Claude 系列模型，长上下文能力强，适合代码理解、大规模文档分析和复杂推理任务。'),
      api_key_url: 'https://console.anthropic.com/settings/keys',
      base_url: 'https://api.anthropic.com',
      api: 'anthropic-messages',
      models: [
        {
          id: 'claude-opus-4-8',
          name: 'Claude Opus 4.8',
          contextWindow: 1000000,
          maxTokens: 128000,
          input: ['text', 'image'],
        },
        {
          id: 'claude-sonnet-4-6',
          name: 'Claude Sonnet 4.6',
          contextWindow: 1000000,
          maxTokens: 64000,
          input: ['text', 'image'],
        },
        {
          id: 'claude-haiku-4-5-20251001',
          name: 'Claude Haiku 4.5',
          contextWindow: 200000,
          maxTokens: 64000,
          input: ['text', 'image'],
        },
      ],
    },
    {
      value: 'google_gemini',
      category: 'api',
      provider: 'google',
      provider_name: 'Google Gemini',
      description: t('Google Gemini 系列模型，支持长上下文代码理解和复杂推理，适合多文件项目分析与开发辅助。'),
      api_key_url: 'https://aistudio.google.com/apikey',
      base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      api: 'openai-completions',
      models: [
        { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', input: ['text', 'image'] },
        { id: 'gemini-3-flash', name: 'Gemini 3 Flash', input: ['text', 'image'] },
        { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', input: ['text', 'image'] },
      ],
    },
    {
      value: 'openrouter',
      category: 'api',
      provider: 'openrouter',
      provider_name: 'OpenRouter',
      description: t(
        'OpenRouter 提供统一 API 聚合 OpenAI、Anthropic、Google、xAI、Mistral、DeepSeek 等模型，支持多模型切换与 fallback，适合国际开发环境。支持访问最新发布的前沿模型。',
      ),
      api_key_url: 'https://openrouter.ai/keys',
      base_url: 'https://openrouter.ai/api/v1',
      api: 'openai-completions',
      models: [
        { id: 'openai/gpt-5.4-pro', name: 'OpenAI GPT-5.4 Pro', input: ['text', 'image'] },
        { id: 'openai/gpt-5.4', name: 'OpenAI GPT-5.4', input: ['text', 'image'] },
        { id: 'openai/gpt-5.3-chat', name: 'OpenAI GPT-5.3 Chat', input: ['text', 'image'] },
        { id: 'inception/mercury-2', name: 'Inception Mercury 2' },
        {
          id: 'google/gemini-3.1-flash-lite-preview',
          name: 'Google Gemini 3.1 Flash Lite Preview',
          input: ['text', 'image'],
        },
        { id: 'bytedance/seed-2.0-mini', name: 'ByteDance Seed 2.0 Mini' },
        { id: 'google/nano-banana-2', name: 'Google Nano Banana 2' },
        { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', input: ['text', 'image'] },
        { id: 'x-ai/grok-4-1-fast-reasoning', name: 'Grok 4.1 Fast Reasoning' },
        { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3' },
      ],
    },
    {
      value: 'tencent_hy_token_plan',
      category: 'coding_plan',
      provider: 'tencenthytokenplan',
      provider_name: t('腾讯云 Hy Token Plan（个人版）'),
      description: t(
        '基于腾讯2026年最新推出的混元模型打造：集成 Hy4 Preview 模型，面向 Agent 工作负载设计，适配 Coding Agent、文档自动化、多步工具调用等工作流。',
      ),
      api_key_url: 'https://console.cloud.tencent.com/tokenhub/tokenplan/hy',
      base_url: 'https://api.lkeap.cloud.tencent.com/plan/v3',
      api: 'openai-completions',
      models: [{ id: 'hy4-preview', name: 'hy4-preview' }],
    },
    {
      value: 'tencent_token_plan',
      category: 'coding_plan',
      provider: 'tencenttokenplan',
      provider_name: t('腾讯云通用 Token Plan（个人版）'),
      description: t(
        '腾讯云大模型服务针对 Agent 与编码场景全新升级，正式推出 Token Plan 套餐！套餐内设更多档位选择，适配更多种类任务需求；还将持续集成更多更优模型，助力体验升级。',
      ),
      api_key_url: 'https://console.cloud.tencent.com/tokenhub/tokenplan',
      base_url: 'https://api.lkeap.cloud.tencent.com/plan/v3',
      api: 'openai-completions',
      models: [
        { id: 'tc-code-latest', name: t('自动'), input: ['text', 'image'] },
        { id: 'minimax-m2.5', name: 'MiniMax-M2.5' },
        { id: 'minimax-m2.7', name: 'MiniMax-M2.7' },
        { id: 'kimi-k2.5', name: 'Kimi-K2.5', input: ['text', 'image'], isDefault: true },
        { id: 'glm-5', name: 'GLM-5' },
        { id: 'glm-5.1', name: 'GLM-5.1' },
        { id: 'deepseek-v4-flash-202605', name: 'DeepSeek-V4-Flash' },
        { id: 'deepseek-v4-pro-202606', name: 'DeepSeek-V4-Pro' },
      ],
    },
    {
      value: 'tencent_token_plan_enterprise_lite',
      category: 'coding_plan',
      provider: 'tencenttokenplanenterpriselite',
      provider_name: t('腾讯云 Token Plan 企业版轻享套餐'),
      description: t(
        'Token Plan 企业版轻享套餐，面向企业及团队推出的大模型 API 按月预付费套餐，可按需采购自定义规格专属 Token 资源池，支持 Auto 智能路由调度模型，具备多密钥管理与配额分配能力。',
      ),
      api_key_url: 'https://console.cloud.tencent.com/tokenhub/tokenplan-e',
      base_url: 'https://tokenhub.tencentmaas.com/plan/v3',
      api: 'openai-completions',
      models: [{ id: 'auto', name: t('Auto 智能路由模型') }],
    },
    {
      value: 'tencent_token_plan_enterprise_pro',
      category: 'coding_plan',
      provider: 'tencenttokenplanenterprisepro',
      provider_name: t('腾讯云 Token Plan 企业版专业套餐'),
      description: t(
        'Token Plan 企业版专业套餐，面向企业及团队推出的大模型 API 按月预付费套餐，可按需采购自定义规格积分池，支持灵活切换主流国产大模型，具备多密钥管理与配额分配能力。',
      ),
      api_key_url: 'https://console.cloud.tencent.com/tokenhub/tokenplan-e',
      base_url: 'https://tokenhub.tencentmaas.com/plan/v3',
      api: 'openai-completions',
      models: [
        { id: 'auto', name: t('Auto 智能路由模型') },
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
        { id: 'glm-5', name: 'GLM-5' },
        { id: 'glm-5-turbo', name: 'GLM-5-Turbo' },
        { id: 'glm-5.2', name: 'GLM-5.2' },
        { id: 'glm-5.1', name: 'GLM-5.1' },
        { id: 'kimi-k2.5', name: 'Kimi-K2.5', input: ['text', 'image'] },
        { id: 'kimi-k2.6', name: 'Kimi-K2.6', input: ['text', 'image'] },
        { id: 'minimax-m2.5', name: 'MiniMax-M2.5' },
        { id: 'minimax-m2.7', name: 'MiniMax-M2.7' },
      ],
    },
    {
      value: 'minimax_coding',
      category: 'coding_plan',
      provider: 'minimax',
      provider_name: t('MiniMax Token Plan（国内）'),
      description: t(
        'MiniMax 是国内领先的通用大模型公司，提供文本、语音、视觉等多模态AI能力，擅长长文本和复杂任务处理。',
      ),
      api_key_url: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
      base_url: 'https://api.minimaxi.com/anthropic',
      api: 'anthropic-messages',
      models: [
        { id: 'MiniMax-M3', name: 'MiniMax-M3', contextWindow: 1000000, maxTokens: 128000 },
        { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7', contextWindow: 256000, maxTokens: 32000 },
        { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax-M2.7-Highspeed', contextWindow: 256000, maxTokens: 32000 },
      ],
      oauth: {
        provider: 'minimax',
        initArgs: 'cn',
        openclawProvider: 'minimax-portal',
        requireCallbackUrl: false,
        exclusive: false,
        pollArgs: 'minimax-portal',
        providerConfig: {
          baseUrl: 'https://api.minimaxi.com/anthropic',
          api: 'anthropic-messages',
        },
        cleanAuthProfile: true,
        models: [
          { id: 'MiniMax-M3', name: 'MiniMax-M3', contextWindow: 1000000, maxTokens: 128000 },
          { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7', contextWindow: 256000, maxTokens: 32000 },
          {
            id: 'MiniMax-M2.7-highspeed',
            name: 'MiniMax-M2.7-Highspeed',
            contextWindow: 256000,
            maxTokens: 32000,
          },
        ],
      },
    },
    {
      value: 'glmcode',
      category: 'coding_plan',
      provider: 'glmcode',
      provider_name: t('智谱 Coding Plan（国内） '),
      description: t('智谱提供GLM系列模型的全球接入能力，支持多语言场景，适配海外开发者与企业级应用需求。'),
      api_key_url: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
      base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
      api: 'openai-completions',
      models: [
        {
          id: 'glm-5.2',
          name: 'GLM-5.2',
        },
        { id: 'GLM-5.1', name: 'GLM-5.1' },
        { id: 'GLM-5-Turbo', name: 'GLM-5-Turbo' },
        { id: 'glm-5', name: 'GLM-5' },
        { id: 'glm-4.7', name: 'GLM-4.7' },
        { id: 'glm-4.6', name: 'GLM-4.6' },
        { id: 'glm-4.5-air', name: 'GLM-4.5-Air' },
        { id: 'glm-4.5', name: 'GLM-4.5' },
      ],
    },
    {
      value: 'zaicode',
      category: 'coding_plan',
      provider: 'zaicode',
      provider_name: t('智谱 AI（GLM国际-Coding Plan）'),
      description: t('Z.AI基于智谱AI的GLM系列模型，提供高性能的中英文理解和生成能力。'),
      api_key_url: 'https://z.ai/manage-apikey/apikey-list',
      base_url: 'https://api.z.ai/api/coding/paas/v4',
      api: 'openai-completions',
      models: [
        { id: 'GLM-5.1', name: 'GLM-5.1' },
        { id: 'GLM-5-Turbo', name: 'GLM-5-Turbo' },
        { id: 'glm-5', name: 'GLM-5' },
        { id: 'glm-4.7', name: 'GLM-4.7' },
        { id: 'glm-4.6', name: 'GLM-4.6' },
        { id: 'glm-4.5-air', name: 'GLM-4.5-Air' },
        { id: 'glm-4.5', name: 'GLM-4.5' },
      ],
    },
    {
      value: 'kimicode',
      category: 'coding_plan',
      provider: 'kimicode',
      provider_name: t('Kimi Coding Plan'),
      description: t(
        'Kimi Code 是 Kimi 会员计划中专为代码开发场景打造的增值会员权益，旨在为开发者提供更强大的模型性能与更深度的工具集成。',
      ),
      api_key_url: 'https://www.kimi.com/code/console',
      base_url: 'https://api.kimi.com/coding/v1',
      api: 'openai-completions',
      models: [{ id: 'kimi-for-coding', name: 'kimi for coding', input: ['text', 'image'] }],
    },
    {
      value: 'xiaomicoding',
      category: 'coding_plan',
      provider: 'xiaomicoding',
      provider_name: t('小米 Token Plan'),
      description: t('小米 Token Plan 是小米为开发者打造的 AI 编码订阅服务。'),
      api_key_url: 'https://platform.xiaomimimo.com/#/console/plan-manage',
      base_url: 'https://token-plan-cn.xiaomimimo.com/v1',
      api: 'openai-completions',
      models: [
        { id: 'mimo-v2.5-pro', name: 'MiMo-V2.5-Pro' },
        { id: 'mimo-v2.5', name: 'MiMo-V2.5' },
        { id: 'mimo-v2-pro', name: 'MiMo-V2-Pro' },
        { id: 'mimo-v2-omni', name: 'MiMo-V2-Omni', input: ['text', 'image'] },
      ],
    },
    // TokenHub（国内+国际站均展示，模型 API 分类首位）
    {
      value: 'tokenhub',
      category: 'api',
      provider: 'tokenhub',
      provider_name: t('腾讯云 TokenHub'),
      description: t(
        '大模型服务平台 TokenHub 致力于为企业和开发者提供统一的大模型服务入口，整合腾讯自研的混元大模型能力，并引入优质第三方模型，覆盖通用对话、深度推理、代码生成、视觉理解等多类场景。',
      ),
      api_key_url: 'https://console.cloud.tencent.com/tokenhub/apikey',
      // 默认填国内域,海外地域由 getFilteredModelProviderList 在过滤后注入海外域(TOKENHUB_BASE_URL.oversea)
      base_url: TOKENHUB_BASE_URL.domestic,
      api: 'openai-completions',
      models: [
        { id: 'hy3-preview', name: 'Hy3 Preview' },
        { id: 'minimax-m3', name: 'MiniMax-M3' },
        { id: 'glm-5', name: 'GLM-5' },
        { id: 'minimax-m2.5', name: 'MiniMax-M2.5' },
        { id: 'hunyuan-2.0-instruct-20251111', name: 'Hunyuan 2.0 Instruct' },
        { id: 'hunyuan-2.0-thinking-20251109', name: 'Hunyuan 2.0 Thinking' },
        { id: 'glm-5.1', name: 'GLM-5.1' },
        { id: 'kimi-k2.5', name: 'Kimi-K2.5', input: ['text', 'image'] },
        { id: 'hunyuan-role-latest', name: 'Hunyuan Role' },
        { id: 'deepseek-v3.1-terminus', name: 'DeepSeek V3.1 Terminus' },
        { id: 'kimi-k2.6', name: 'Kimi-K2.6', input: ['text', 'image'] },
        { id: 'deepseek-v3.2', name: 'DeepSeek V3.2' },
        { id: 'minimax-m2.7', name: 'MiniMax-M2.7' },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        { id: 'glm-5v-turbo', name: 'GLM-5V Turbo', input: ['text', 'image'] },
        { id: 'glm-5-turbo', name: 'GLM-5 Turbo' },
        { id: 'deepseek-r1-0528', name: 'DeepSeek R1 0528' },
        { id: 'deepseek-v3-0324', name: 'DeepSeek V3 0324' },
      ],
    },
    {
      value: 'deepseek',
      category: 'api',
      provider: 'deepseek',
      provider_name: t('深度求索（DeepSeek）'),
      description: t('DeepSeek是国产高性能大语言模型，以极高的性价比和强大的代码/推理能力著称。'),
      api_key_url: 'https://platform.deepseek.com/api_keys',
      base_url: 'https://api.deepseek.com/v1',
      api: 'openai-completions',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
    },
    {
      value: 'qwen',
      category: 'api',
      provider: 'qwen',
      provider_name: t('百炼（千问）'),
      description: t('阿里云百炼是一站式大模型开发与应用平台，集成了千问及主流第三方模型。'),
      api_key_url: 'https://bailian.console.aliyun.com/cn-beijing/?tab=model#/api-key',
      base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      api: 'openai-completions',
      models: [
        { id: 'qwen3.7-max', name: 'Qwen3.7 Max' },
        { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', input: ['text', 'image'] },
        { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', input: ['text', 'image'] },
        { id: 'qwen3.6-flash', name: 'Qwen3.6 Flash', input: ['text', 'image'] },
        { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', input: ['text', 'image'] },
        { id: 'qwen-max', name: 'Qwen Max' },
        { id: 'qwen-plus', name: 'Qwen Plus' },
        { id: 'qwen-turbo', name: 'Qwen Turbo' },
        { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus' },
        { id: 'MiniMax-M2.5', name: 'MiniMax-M2.5' },
        { id: 'kimi-k2.6', name: 'Kimi K2.6', input: ['text', 'image'] },
        { id: 'GLM-5.1', name: 'GLM-5.1' },
        { id: 'glm-5', name: 'GLM-5' },
        { id: 'glm-4.7', name: 'GLM-4.7' },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
    },
    {
      value: 'qwencode',
      category: 'coding_plan',
      provider: 'qwencode',
      provider_name: t('百炼 Coding Plan'),
      description: t('阿里云百炼是一站式大模型开发与应用平台，集成了千问及主流第三方模型。'),
      api_key_url: 'https://bailian.console.aliyun.com/cn-beijing/?tab=model#/efm/coding_plan',
      base_url: 'https://coding.dashscope.aliyuncs.com/v1',
      api: 'openai-completions',
      models: [
        { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', input: ['text', 'image'] },
        { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', input: ['text', 'image'] },
        { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', input: ['text', 'image'] },
        { id: 'qwen3-max-2026-01-23', name: 'Qwen3 Max' },
        { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus' },
        { id: 'MiniMax-M2.5', name: 'MiniMax-M2.5' },
        { id: 'kimi-k2.5', name: 'Kimi K2.5', input: ['text', 'image'] },
        { id: 'glm-5', name: 'GLM-5' },
        { id: 'glm-4.7', name: 'GLM-4.7' },
      ],
    },
    {
      value: 'minimax_domestic',
      category: 'api',
      provider: 'minimax',
      provider_name: t('MiniMax（国内）'),
      description: t(
        'MiniMax 是国内领先的通用大模型公司，提供文本、语音、视觉等多模态AI能力，擅长长文本和复杂任务处理。',
      ),
      api_key_url: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
      base_url: 'https://api.minimaxi.com/anthropic',
      api: 'anthropic-messages',
      models: [
        { id: 'MiniMax-M3', name: 'MiniMax-M3', contextWindow: 1000000, maxTokens: 128000 },
        { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7' },
        { id: 'MiniMax-M2.5', name: 'MiniMax-M2.5' },
        { id: 'MiniMax-M2.1', name: 'MiniMax-M2.1' },
        { id: 'MiniMax-M2.1-lightning', name: 'MiniMax-M2.1-Lightning' },
        { id: 'MiniMax-M2', name: 'MiniMax-M2' },
      ],
    },

    {
      value: 'minimax_international',
      category: 'api',
      provider: 'minimax',
      provider_name: t('MiniMax（国际）'),
      description: t(
        'MiniMax国际版提供与国内版一致的多模态 AI 能力，支持全球网络接入，适配海外复杂任务与长文本处理场景。',
      ),
      api_key_url: 'https://platform.minimax.io/user-center/basic-information/interface-key',
      base_url: 'https://api.minimax.io/v1',
      api: 'openai-completions',
      models: [
        { id: 'MiniMax-M3', name: 'MiniMax-M3' },
        { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7' },
        { id: 'MiniMax-M2.5', name: 'MiniMax-M2.5' },
        { id: 'MiniMax-M2.1', name: 'MiniMax-M2.1' },
        { id: 'MiniMax-M2.1-lightning', name: 'MiniMax-M2.1-Lightning' },
        { id: 'MiniMax-M2', name: 'MiniMax-M2' },
      ],
    },
    {
      value: 'moonshot_domestic',
      category: 'api',
      provider: 'moonshot',
      provider_name: t('Moonshot AI（Kimi国内）'),
      description: t('Moonshot AI（月之暗面）开发了Kimi大模型，以超长上下文窗口和中文理解能力著称。'),
      api_key_url: 'https://platform.moonshot.cn/console/api-keys',
      base_url: 'https://api.moonshot.cn/v1',
      api: 'openai-completions',
      models: [
        { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking' },
        { id: 'kimi-k2-thinking-turbo', name: 'Kimi K2 Thinking Turbo' },
        { id: 'kimi-k2.5', name: 'Kimi K2.5', input: ['text', 'image'] },
        { id: 'moonshot-v1-128k', name: 'Moonshot V1 128K' },
        { id: 'kimi-k2.6', name: 'Kimi K2.6', input: ['text', 'image'], isDefault: true },
      ],
    },
    {
      value: 'moonshot_international',
      category: 'api',
      provider: 'moonshot',
      provider_name: t('Moonshot AI（Kimi国际）'),
      description: t('Kimi国际版提供全球网络接入，支持多语言与海外企业级场景，保持与国内版一致的模型能力与架构设计。'),
      api_key_url: 'https://platform.moonshot.ai/console/api-keys',
      base_url: 'https://api.moonshot.ai/v1',
      api: 'openai-completions',
      models: [
        { id: 'kimi-k2.5', name: 'Kimi K2.5', input: ['text', 'image'] },
        { id: 'kimi-k2.6', name: 'Kimi K2.6', input: ['text', 'image'], isDefault: true },
      ],
    },
    {
      value: 'zhipu',
      category: 'api',
      provider: 'zhipu',
      provider_name: t('智谱 AI（GLM国内）'),
      description: t('智谱提供GLM系列模型的全球接入能力，支持多语言场景，适配海外开发者与企业级应用需求。'),
      api_key_url: 'https://open.bigmodel.cn/usercenter/apikeys',
      base_url: 'https://open.bigmodel.cn/api/paas/v4',
      api: 'openai-completions',
      models: [
        { id: 'GLM-5V-Turbo', name: 'GLM-5V-Turbo', input: ['text', 'image'] },
        { id: 'GLM-5.1', name: 'GLM-5.1' },
        { id: 'GLM-5-Turbo', name: 'GLM-5-Turbo' },
        { id: 'glm-5', name: 'GLM-5' },
        { id: 'glm-4.7', name: 'GLM-4.7' },
        { id: 'glm-4.6', name: 'GLM-4.6' },
        { id: 'glm-4.5-air', name: 'GLM-4.5-Air' },
        { id: 'glm-4.5', name: 'GLM-4.5' },
      ],
    },
    {
      value: 'zai',
      category: 'api',
      provider: 'zai',
      provider_name: t('智谱 AI（GLM国际）'),
      description: t('Z.AI基于智谱AI的GLM系列模型，提供高性能的中英文理解和生成能力。'),
      api_key_url: 'https://z.ai/manage-apikey/apikey-list',
      base_url: 'https://api.z.ai/api/paas/v4',
      api: 'openai-completions',
      models: [
        { id: 'GLM-5V-Turbo', name: 'GLM-5V-Turbo', input: ['text', 'image'] },
        { id: 'GLM-5.1', name: 'GLM-5.1' },
        { id: 'GLM-5-Turbo', name: 'GLM-5-Turbo' },
        { id: 'glm-5', name: 'GLM-5' },
        { id: 'glm-4.7', name: 'GLM-4.7' },
        { id: 'glm-4.6', name: 'GLM-4.6' },
        { id: 'glm-4.5-air', name: 'GLM-4.5-Air' },
        { id: 'glm-4.5', name: 'GLM-4.5' },
      ],
    },
    {
      value: 'doubao',
      category: 'api',
      provider: 'doubao',
      provider_name: t('火山引擎（豆包）'),
      description: t('豆包大模型是字节跳动推出的AI大模型，具备优秀的对话、创作和推理能力。'),
      api_key_url: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
      base_url: 'https://ark.cn-beijing.volces.com/api/v3',
      api: 'openai-completions',
      models: [
        { id: 'doubao-seed-2-0-pro-260215', name: 'Doubao Seed 2.0 Pro', input: ['text', 'image'] },
        { id: 'doubao-seed-1-8-251228', name: 'Doubao Seed 1.8', input: ['text', 'image'] },
        { id: 'glm-4-7-251222', name: 'GLM-4.7', input: ['text', 'image'] },
        { id: 'doubao-seed-code-preview-251028', name: 'Doubao Seed Code Preview', input: ['text', 'image'] },
        { id: 'doubao-seed-1-6-lite-251015', name: 'Doubao Seed 1.6 Lite', input: ['text', 'image'] },
        { id: 'doubao-seed-1-6-flash-250828', name: 'Doubao Seed 1.6 Flash', input: ['text', 'image'] },
        { id: 'doubao-seed-1-6-vision-250815', name: 'Doubao Seed 1.6 Vision', input: ['text', 'image'] },
      ],
    },
    {
      value: 'arkcode',
      category: 'coding_plan',
      provider: 'arkcode',
      provider_name: t('火山引擎方舟 Coding Plan'),
      description: t(
        '方舟 Coding Plan 是火山引擎为开发者量身定制的订阅服务，助力高效编码开发。若模型选择ark-code-latest需{{click}}控制模型配置（默认为Auto）。',
        {
          click: t(
            "<a target='_blank' href='https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&advancedActiveKey=subscribe'>前往提供商</a>",
          ),
        },
      ),
      api_key_url: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apikey',
      base_url: 'https://ark.cn-beijing.volces.com/api/coding/v3',
      api: 'openai-completions',
      models: [
        {
          id: 'ark-code-latest',
          name: 'ARK Code Latest',
          contextWindow: 256000,
          maxTokens: 32000,
          input: ['text', 'image'],
        },
        {
          id: 'doubao-seed-code',
          name: 'Doubao Seed Code',
          contextWindow: 256000,
          maxTokens: 32000,
          input: ['text', 'image'],
        },
        {
          id: 'doubao-seed-2.0-code',
          name: 'Doubao Seed 2.0 Code',
          contextWindow: 256000,
          maxTokens: 65536,
          input: ['text', 'image'],
        },
        {
          id: 'doubao-seed-2.0-pro',
          name: 'Doubao Seed 2.0 Pro',
          contextWindow: 256000,
          maxTokens: 65536,
          input: ['text', 'image'],
        },
        {
          id: 'doubao-seed-2.0-lite',
          name: 'Doubao Seed 2.0 Lite',
          contextWindow: 256000,
          maxTokens: 65536,
          input: ['text', 'image'],
        },
        { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200000, maxTokens: 65536 },
        { id: 'deepseek-v3.2', name: 'DeepSeek V3.2', contextWindow: 128000, maxTokens: 32000 },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1024000, maxTokens: 65536 },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1024000, maxTokens: 65536 },
        { id: 'minimax-latest', name: 'MiniMax Latest', contextWindow: 200000, maxTokens: 65536 },
        { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 256000, maxTokens: 32000, input: ['text', 'image'] },
      ],
    },
    {
      value: 'mimo',
      category: 'api',
      provider: 'mimo',
      provider_name: t('小米 MiMo'),
      description: t('小米 MiMo‑V2‑Pro 是小米发布的面向 Agent 时代的旗舰基座模型。'),
      api_key_url: 'https://platform.xiaomimimo.com/#/console/api-keys',
      base_url: 'https://api.xiaomimimo.com/v1',
      api: 'openai-completions',
      models: [
        { id: 'mimo-v2.5-pro', name: 'MiMo-V2.5-Pro' },
        { id: 'mimo-v2.5', name: 'MiMo-V2.5' },
        { id: 'mimo-v2-pro', name: 'MiMo-V2-Pro' },
        { id: 'mimo-v2-omni', name: 'MiMo-V2-Omni', input: ['text', 'image'] },
        { id: 'mimo-v2-flash', name: 'MiMo-V2-Flash' },
      ],
    },
    {
      value: 'baidu',
      category: 'api',
      provider: 'baidu',
      provider_name: t('百度（文心一言）'),
      description: t('百度文心大模型是百度推出的产业级知识增强大语言模型，具备强大的中文理解和生成能力。'),
      api_key_url: 'https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application',
      base_url: 'https://qianfan.baidubce.com/v2',
      api: 'openai-completions',
      models: [
        { id: 'ernie-5.0-thinking-preview', name: 'ERNIE 5.0', input: ['text', 'image'] },
        { id: 'DeepSeek-V3.2', name: 'DeepSeek-V3.2' },
        { id: 'ERNIE-X1.1-Preview', name: 'ERNIE X1.1' },
        { id: 'ernie-4.5-turbo-128k', name: 'ERNIE 4.5 Turbo' },
      ],
    },
    {
      value: 'baiducode',
      category: 'coding_plan',
      provider: 'baiducode',
      provider_name: t('百度千帆 Coding Plan'),
      description: t('千帆 Coding Plan 是百度千帆为开发者打造的 AI 编码订阅服务，支持接入多种主流代码模型。'),
      api_key_url: 'https://console.bce.baidu.com/qianfan/resource/subscribe',
      base_url: 'https://qianfan.baidubce.com/v2/coding',
      api: 'openai-completions',
      models: [
        { id: 'deepseek-v3.2', name: 'DeepSeek-V3.2' },
        { id: 'kimi-k2.5', name: 'Kimi-K2.5', input: ['text', 'image'] },
        { id: 'glm-5', name: 'GLM-5' },
        { id: 'minimax-m2.5', name: 'MiniMax-M2.5' },
        { id: 'ernie-4.5-turbo-20260402', name: 'ERNIE-4.5-Turbo-20260402' },
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
        { id: 'glm-5.1', name: 'GLM-5.1' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    },
    {
      value: 'tencent_coding_plan',
      category: 'coding_plan',
      provider: 'tencentcodingplan',
      provider_name: t('腾讯云 Coding Plan'),
      description: t('腾讯云大模型 Coding Plan ，集成腾讯混元、智谱 GLM、月之暗面 Kimi 、MiniMax 等多个国内主流模型。'),
      api_key_url: 'https://console.cloud.tencent.com/tokenhub/codingplan',
      base_url: 'https://api.lkeap.cloud.tencent.com/coding/v3',
      api: 'openai-completions',
      models: [
        { id: 'tc-code-latest', name: t('自动'), input: ['text', 'image'] },
        { id: 'minimax-m2.5', name: 'MiniMax-M2.5' },
        { id: 'kimi-k2.5', name: 'Kimi-K2.5', input: ['text', 'image'] },
        { id: 'glm-5', name: 'GLM-5' },
      ],
    },
];

interface IChannelConfig {
  value: string;
  channel: string;
  channel_name: string;
  description?: string;
  url?: string;
  supportQrConfig?: boolean;
  qrCodeOnly?: boolean;
  /** 一级选项展示名；有此字段的通道按数据源顺序作为一级直选项，其余归入「其他」 */
  primaryLabel?: string;
  channel_keys: { key: string; description: string }[];
}

// 同 MODEL_PROVIDER_LIST：t() 走 @/i18n/t（构建期静态字典，i18n 顶层同步 init 且经 import
// 链先于本模块求值），顶层直接求值即安全。
export const CHANNEL_LIST: IChannelConfig[] = [
    {
      value: 'qqbot',
      channel: 'qqbot',
      channel_name: t('QQ'),
      primaryLabel: t('QQ'),
      description: t('一键解锁智能玩法，开启你的个性化QQ机器人之旅。'),
      url: 'https://q.qq.com/qqbot/openclaw/',
      supportQrConfig: true,
      channel_keys: [
        {
          key: 'appId',
          description: t('QQ机器人的App ID'),
        },
        {
          key: 'clientSecret',
          description: t('QQ机器人的App Secret'),
        },
      ],
    },
    {
      value: 'wecom',
      channel: 'wecom',
      channel_name: t('企业微信机器人'),
      primaryLabel: t('企业微信'),
      description: t('企业微信是一款高效协同办公的企业通讯与办公工具。'),
      url: 'https://work.weixin.qq.com/wework_admin/frame#/aiHelper/create',
      channel_keys: [
        {
          key: 'token',
          description: t('企业微信机器人的Token'),
        },
        {
          key: 'encodingAESKey',
          description: t('企业微信机器人的encodingAESKey'),
        },
      ],
    },
    {
      value: 'feishu',
      channel: 'feishu',
      channel_name: t('飞书'),
      primaryLabel: t('飞书'),
      description: t('飞书是字节跳动推出的一站式先进协作平台，AI 赋能助力高效办公。'),
      url: 'https://open.feishu.cn/',
      supportQrConfig: true,
      channel_keys: [
        {
          key: 'appId',
          description: t('飞书应用的App ID'),
        },
        {
          key: 'appSecret',
          description: t('飞书应用的App Secret'),
        },
      ],
    },
    {
      value: 'dingtalk',
      channel: 'dingtalk',
      channel_name: t('钉钉'),
      primaryLabel: t('钉钉'),
      description: t('钉钉是阿里巴巴公司打造的智能办公平台，驱动组织数字化管理升级。'),
      url: 'https://www.dingtalk.com/',
      channel_keys: [
        {
          key: 'clientId',
          description: t('钉钉应用的Client ID'),
        },
        {
          key: 'clientSecret',
          description: t('钉钉应用的Client Secret'),
        },
      ],
    },
];

// Gateway状态常量
export const GATEWAY_STATUS = {
  RUNNING: 'running',
  STOPPED: 'stopped',
  UNKNOWN: 'unknown',
} as const;


// 自定义模型 provider 前缀，避免与内置 provider 命名冲突（key 覆盖、删除歧义等）
export const CUSTOM_PROVIDER_PREFIX = 'custom_';

/** 规范化自定义 provider 名：如果不以 custom_ 开头则自动加前缀 */
export const normalizeCustomProvider = (name: string): string => {
  const trimmed = (name || '').trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith(CUSTOM_PROVIDER_PREFIX) ? trimmed : `${CUSTOM_PROVIDER_PREFIX}${trimmed}`;
};

export const CUSTOM_JSON_PLACEHOLDER = t(`{
  "provider": "provider_name",
  "base_url": "baseurl",
  "api": "API协议",
  "api_key": "your-api-key-here",
  "model": {
    "id": "model_id",
    "name": "model_name"
  }
}`);
