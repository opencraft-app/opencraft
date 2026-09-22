import { DATONG_PAGE_IDS, type DatongPageId } from "@/observability/datong";

/**
 * 大同声明式埋点属性构造器。
 *
 * SDK 约定：
 *   - `dt-pgid`：页面 ID，标记在页面根元素
 *   - `dt-eid`：元素 ID，标记在可交互元素或曝光容器
 *   - `dt-params`：私有参数，格式为 URL query 风格 `k1=v1&k2=v2`
 *
 * 示例：
 * ```tsx
 * <div {...trackPage(DATONG_PAGE_IDS.HOME)}>
 * <button {...trackElement("hero_create_now_btn", { has_bots: hasBots })}>Create Now</button>
 * ```
 *
 * SDK 官方文档：`dt-` 属性会由 universal-report 自动检测并上报
 * `dt_pgin` / `dt_pgout` / `dt_imp` / `dt_clck` / `dt_imp_end` 五类标准事件。
 */

/** 允许出现在 dt-params 中的原始值类型（会被字符串化后拼接）。 */
export type TrackParamValue = string | number | boolean | null | undefined;
export type TrackParams = Record<string, TrackParamValue>;

const encodeSegment = (value: string): string => encodeURIComponent(value);

/**
 * 将业务参数对象序列化为 SDK 期望的 `k1=v1&k2=v2` 字符串。
 * 空值 / undefined / null 会被跳过；布尔值会被序列化为 `true` / `false`。
 */
export function serializeTrackParams(params?: TrackParams): string | undefined {
  if (!params) return undefined;
  const parts: string[] = [];
  for (const [rawKey, rawValue] of Object.entries(params)) {
    if (rawValue === null || rawValue === undefined) continue;
    if (typeof rawValue === "string" && rawValue.length === 0) continue;
    const stringified = typeof rawValue === "boolean" ? String(rawValue) : String(rawValue);
    parts.push(`${encodeSegment(rawKey)}=${encodeSegment(stringified)}`);
  }
  return parts.length > 0 ? parts.join("&") : undefined;
}

/**
 * 生成挂在页面根元素上的 dt-pgid + dt-params 属性。
 *
 * 使用 `React.HTMLAttributes` 无法收纳自定义 `dt-*` 属性时，业务侧通过 spread 直接展开即可。
 */
export function trackPage(pgid: DatongPageId, params?: TrackParams): {
  "dt-pgid": DatongPageId;
  "dt-params"?: string;
} {
  const serialized = serializeTrackParams(params);
  if (serialized) {
    return { "dt-pgid": pgid, "dt-params": serialized };
  }
  return { "dt-pgid": pgid };
}

/**
 * 生成挂在可交互元素或曝光容器上的 dt-eid + dt-params 属性。
 * eid 为字符串常量，建议在业务代码中集中管理，避免拼写错误。
 */
export function trackElement(eid: string, params?: TrackParams): {
  "dt-eid": string;
  "dt-params"?: string;
} {
  const serialized = serializeTrackParams(params);
  if (serialized) {
    return { "dt-eid": eid, "dt-params": serialized };
  }
  return { "dt-eid": eid };
}

// 便于业务侧在同一个文件中一次性 import 所需的所有埋点常量。
export { DATONG_PAGE_IDS };
export type { DatongPageId };
