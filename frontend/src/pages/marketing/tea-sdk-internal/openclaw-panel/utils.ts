import { t } from "@/i18n/t";
import {
  getNotSupportList as _getDefaultNotSupportList,
  getChannelPluginName as _getDefaultChannelPluginName,
} from '../utils/moltbot';
import type { IProductConfig } from '../config/types';
import type { LightClawScriptsSDK as LightClawSDK, ICommandExecutor } from "@tencent/tea-sdk-lightclaw/scripts";

/** 从 productConfig 获取 getNotSupportList，不传则使用默认 */
const resolveNotSupportList = (productConfig?: IProductConfig) =>
  productConfig?.getNotSupportList ?? _getDefaultNotSupportList;

/** 从 productConfig 获取 getChannelPluginName，不传则使用默认 */
const resolveChannelPluginName = (productConfig?: IProductConfig) =>
  productConfig?.getChannelPluginName ?? _getDefaultChannelPluginName;

/**
 * 安全获取字符串值，防止用户篡改字段为对象导致渲染异常
 */
export const safeString = (value: unknown, defaultValue = ''): string => {
  if (value === null || value === undefined) return defaultValue;
  if (typeof value === 'string') return value;
  // 其他类型（number、boolean、object、array等）强转为字符串
  return String(value);
};

/**
 * 加载状态展示：根据 loading 返回 Status 组件 props
 */
export const getLoadingStatusProps = (isLoading: boolean) => ({
  icon: isLoading ? ('loading' as const) : ('blank' as const),
  title: isLoading ? t('加载中') : t('暂无数据'),
});

/**
 * 判断当前蓝图版本是否支持指定功能
 * 替代 11 个 isSupportXxx 布尔 props 的逐层传递
 */
export const isFeatureSupported = (
  isOpenClawBlueprint: boolean,
  displayBlueprintVersion: string,
  feature: string,
  productConfig?: IProductConfig,
): boolean => isOpenClawBlueprint && !resolveNotSupportList(productConfig)(feature).includes(displayBlueprintVersion);

/**
 * 密钥遮罩：保留前3字符，其余替换为星号
 */
export const maskSecret = (value: string) => value.replace(/^(.{3}).*/, '$1***************');
