/**
 * useModelProviders — 从七彩石拉取模型提供商列表
 *
 * 返回值始终是可用的模型列表：
 *  - 请求中 / 失败 → 内置兜底列表 MODEL_PROVIDER_LIST
 *  - 成功 → 七彩石列表（拉到后无感替换，触发重渲染）
 *
 * 因为始终有可用列表垫底，消费方无需处理 loading/error，直接拿数组用即可。
 * 拉取结果按 站点+语言+app+baseUrl 缓存在模块级，避免重复请求。
 *
 * @example
 * ```tsx
 * const modelProviders = useModelProviders({ isI18n: IS_I18N, useEnglish });
 * const useOverseaModelProviders = IS_I18N && isOverseaRegion(String(instance.RegionId));
 * const list = getFilteredModelProviderList(instanceRegion, modelProviders, useOverseaModelProviders);
 * ```
 */

import { useEffect, useState } from 'react';
import { MODEL_PROVIDER_LIST } from './model-providers';
import type { IModelProvider } from './model-providers';
import { getRainbow } from './rainbow';
import { MODEL_PROVIDER_RAINBOW_GROUP, parseRainbowModelProviders } from './model-provider-parser';

/** useModelProviders 入参 */
export interface IUseModelProvidersParams {
  /**
   * 是否国际站（站点维度）。决定 rainbow 请求域名：
   * 国际站前端只能连国际域名，国内站只能连国内域名。默认 false。
   */
  isI18n?: boolean;
  /**
   * 是否取英文文案（语言维度）。决定取 zh/en 哪份 key。
   * 不传则默认跟随 isI18n（向后兼容）。
   *
   * 注意与 isI18n 是两个维度：国内站切英文语言时，
   * 域名仍走国内（isI18n=false），但文案应取英文（useEnglish=true）。
   * 调用方应传 `IS_I18N || lang === 'en'`。
   */
  useEnglish?: boolean;
  /** 自定义 rainbow 代理 URL（供代理域名不同的宿主覆盖，如 mono2） */
  rainbowBaseUrl?: string;
  /** rainbow app 名，默认 'lighthouse' */
  app?: string;
}

/** 模块级缓存：已完成的列表 */
const cache: Record<string, IModelProvider[]> = {};
/** 模块级 in-flight 缓存：进行中的 Promise，避免多组件同时挂载时重复请求 */
const inflight: Partial<Record<string, Promise<IModelProvider[] | null>>> = {};

const cacheKey = (isI18n: boolean, useEnglish: boolean, app: string, baseUrl?: string): string =>
  `${isI18n ? 'intl' : 'cn'}::${useEnglish ? 'en' : 'zh'}::${app}::${baseUrl || 'default'}`;

/**
 * 拉取并解析七彩石模型列表。失败返回 null（由调用方回退兜底）。
 * 若已有相同 key 的 in-flight 请求，复用该 Promise，避免重复请求。
 */
function fetchModelProviders(
  isI18n: boolean,
  useEnglish: boolean,
  app: string,
  rainbowBaseUrl?: string,
): Promise<IModelProvider[] | null> {
  const key = cacheKey(isI18n, useEnglish, app, rainbowBaseUrl);
  if (inflight[key]) return inflight[key];

  const promise = (async () => {
    try {
      const resp = await getRainbow({
        groups: [MODEL_PROVIDER_RAINBOW_GROUP],
        app,
        enableEnv: 1,
        isI18n,
        baseUrl: rainbowBaseUrl,
      });
      const keyValues = resp.data?.[0]?.keyValues;
      return parseRainbowModelProviders(keyValues, useEnglish);
    } finally {
      delete inflight[key];
    }
  })();

  inflight[key] = promise;
  return promise;
}

/**
 * 拉取模型提供商列表。始终返回可用列表（七彩石成功用七彩石，否则用内置兜底）。
 */
export function useModelProviders(params: IUseModelProvidersParams = {}): IModelProvider[] {
  const { isI18n = false, rainbowBaseUrl, app = 'lighthouse' } = params;
  // 语言维度不传则跟随站点维度（向后兼容）
  const useEnglish = params.useEnglish ?? isI18n;
  const key = cacheKey(isI18n, useEnglish, app, rainbowBaseUrl);

  // 已有缓存则同步命中，否则先用内置兜底垫底
  const [data, setData] = useState<IModelProvider[]>(cache[key] ?? MODEL_PROVIDER_LIST);

  useEffect(() => {
    if (cache[key]) {
      setData(cache[key]);
      return;
    }

    let cancelled = false;

    fetchModelProviders(isI18n, useEnglish, app, rainbowBaseUrl)
      .then((list) => {
        if (cancelled || !list) return; // 失败/空时保持兜底不变
        cache[key] = list;
        setData(list);
      })
      .catch(() => {
        // 拉取失败：静默保持兜底列表
      });

    return () => {
      cancelled = true;
    };
  }, [key, isI18n, useEnglish, app, rainbowBaseUrl]);

  return data;
}
