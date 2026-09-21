// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import {
  DATONG_EVENTS,
  DATONG_PAGE_EVENTS,
  reportDatongEvent,
  reportDatongPageEvent,
  type DatongBusinessParams,
  type DatongEvent,
  type DatongPageId,
} from "./datong";

/**
 * 大同便捷 API 封装。
 *
 * 提供两组 helper：
 *   - `trackDatongClick(eid, ...)`：上报 SDK 保留的 `dt_clck` 元素点击事件
 *   - `trackDatongEvent(eventName, ...)`：上报业务自定义事件（DATONG_EVENTS 枚举中定义）
 *
 * 与直接调用 `reportDatongEvent` / `reportDatongPageEvent` 的区别：
 *   - 便捷 API 强制业务提供 `eid`（对 click）与可选 `pgid`
 *   - 便捷 API 都是同步 fire-and-forget，无返回值
 *
 * 所有便捷 API 在 SDK 未初始化 / cookie consent 未同意时均为 no-op。
 */

/** 上报元素点击事件（`dt_clck`）。 */
export function trackDatongClick(
  eid: string,
  options: {
    pgid: DatongPageId;
    params?: DatongBusinessParams;
  },
): void {
  reportDatongPageEvent(DATONG_PAGE_EVENTS.ELEMENT_CLICK, {
    pgid: options.pgid,
    eid,
    businessParams: options.params,
  });
}

/** 上报元素首次曝光事件（`dt_imp`）。 */
export function trackDatongImpression(
  eid: string,
  options: {
    pgid: DatongPageId;
    params?: DatongBusinessParams;
  },
): void {
  reportDatongPageEvent(DATONG_PAGE_EVENTS.ELEMENT_IMPRESSION, {
    pgid: options.pgid,
    eid,
    businessParams: options.params,
  });
}

/** 上报元素结束曝光事件（`dt_imp_end`）。 */
export function trackDatongImpressionEnd(
  eid: string,
  options: {
    pgid: DatongPageId;
    params?: DatongBusinessParams;
  },
): void {
  reportDatongPageEvent(DATONG_PAGE_EVENTS.ELEMENT_IMPRESSION_END, {
    pgid: options.pgid,
    eid,
    businessParams: options.params,
  });
}

/** 直接触发大同业务事件；所有 `DATONG_EVENTS` 枚举项都可传入。 */
export function trackDatongEvent(
  eventName: DatongEvent,
  options?: {
    pgid?: DatongPageId;
    eid?: string;
    params?: DatongBusinessParams;
  },
): void {
  reportDatongEvent(eventName, {
    pgid: options?.pgid,
    eid: options?.eid,
    businessParams: options?.params,
  });
}

/** 语义化别名：与 event constants 对应的短名，减少业务侧样板。 */
export const dtEvents = DATONG_EVENTS;
