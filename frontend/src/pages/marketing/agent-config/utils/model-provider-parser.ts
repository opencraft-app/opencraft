/**
 * 七彩石模型列表解析
 *
 * 从 rainbow 返回的 KV 型数据中，按站点（国内/国际）选对应语言的 key，
 * 将其 value（JSON 字符串）解析为 IModelProvider[]。
 *
 * 解析失败一律静默返回 null，由上层回退到兜底列表。
 */

import type { IModelProvider } from './model-providers';
import type { IRainbowKeyValue } from './rainbow';
import { sanitizeHtml } from './sanitize-html';

/** 七彩石中模型列表的 group 名（七彩石固定配置名，非 UI 文案，禁止国际化） */
// eslint-disable-next-line @tencent/tea-i18n/no-bare-zh-in-js
export const MODEL_PROVIDER_RAINBOW_GROUP = 'Agent模型列表';

/** 七彩石中模型列表的 key（按语言区分） */
export const MODEL_PROVIDER_RAINBOW_KEY = {
  zh: 'model_provider_list_zh.json',
  en: 'model_provider_list_en.json',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeProvider(value: unknown): IModelProvider | null {
  if (!isRecord(value) || !Array.isArray(value.models)) return null;
  const providerValue = readString(value.value).trim();
  const category = value.category;
  const baseUrl = readString(value.base_url).trim();
  const api = readString(value.api).trim();
  if (!providerValue || (category !== 'coding_plan' && category !== 'api') || !baseUrl || !api) return null;

  const provider = readString(value.provider).trim() || providerValue;
  const providerName = readString(value.provider_name).trim() || provider;
  const models = value.models.flatMap((model) => {
    if (!isRecord(model)) return [];
    const id = readString(model.id).trim();
    if (!id) return [];
    const name = readString(model.name).trim() || id;
    return [{ ...model, id, name }];
  });

  return {
    ...value,
    value: providerValue,
    category,
    provider,
    provider_name: providerName,
    description: sanitizeHtml(readString(value.description)),
    api_key_url: readString(value.api_key_url).trim(),
    base_url: baseUrl,
    api,
    models,
  } as IModelProvider;
}

/**
 * 从 keyValues 中按语言选 key，解析出模型列表
 *
 * @param keyValues rainbow 返回的 data[0].keyValues
 * @param isI18n 是否国际站（true 取英文 key，false 取中文 key）
 * @returns 解析成功返回 IModelProvider[]，任何异常返回 null
 */
export function parseRainbowModelProviders(
  keyValues: IRainbowKeyValue[] | undefined,
  isI18n: boolean,
): IModelProvider[] | null {
  if (!Array.isArray(keyValues)) return null;

  const targetKey = isI18n ? MODEL_PROVIDER_RAINBOW_KEY.en : MODEL_PROVIDER_RAINBOW_KEY.zh;
  const matched = keyValues.find((kv) => kv.key === targetKey);
  if (!matched || typeof matched.value !== 'string') return null;

  try {
    const parsed = JSON.parse(matched.value);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    // 逐项校验连接所需字段；整组均无效时返回 null，让上层使用本地兜底。
    const valid = parsed
      .map(normalizeProvider)
      .filter((item): item is IModelProvider => item !== null);
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}
