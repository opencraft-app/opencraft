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
    // 逐项校验最小必需字段，过滤掉结构异常的项
    const valid = parsed
      .filter((item): item is IModelProvider => !!item && typeof item.value === 'string' && Array.isArray(item.models))
      // XSS 防护：对 description 字段做 HTML 白名单过滤（仅允许 <a href target>）
      .map((item) =>
        typeof item.description === 'string' ? { ...item, description: sanitizeHtml(item.description) } : item,
      );
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}
