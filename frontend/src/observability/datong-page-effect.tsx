'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  DATONG_PAGE_EVENTS,
  getDatong,
  reportDatongPageEvent,
  type DatongPageId,
} from '@/observability/datong';
import { resolveDatongPageId, resolvePagePrivateParams } from '@/observability/datong-page-map';
import {
  COOKIE_CONSENT_ACCEPTED,
  COOKIE_CONSENT_CHANGED_EVENT,
  readStoredCookieConsent,
} from '@/lib/cookie-consent';

/**
 * 大同页面曝光副作用组件。
 *
 * 挂载在 App Router 的顶层布局中，监听 pathname/search 变化：
 *   - 每次进入新路由 → 上报 `dt_pgin`（带上路由私参，如 doc_slug/plan/entry）
 *   - 离开旧路由 → 上报 `dt_pgout`（带上停留时长）
 *
 * 与 `DatongTrackerBridge` 的差异：
 *   - Bridge 负责 SDK 生命周期与用户身份（挂在 provider 顶层）
 *   - PageEffect 负责路由级 pgin/pgout（可挂在具体的 layout 里）
 *
 * 由于 SDK 未初始化时 `getDatong()` 返回 `null`，本组件对未加载 SDK 的场景是 no-op。
 *
 * SDK 就绪补偿：若用户先进入页面、之后才同意 cookie consent 触发 SDK init，
 * 首屏 `dt_pgin` 会丢失。这里通过监听 consent 变化事件 + 短时轮询兜底，
 * 在 SDK 就绪后补发当前页面的 pgin。
 */
export const DatongPageEffect = () => {
  const pathname = usePathname() ?? '/';
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? '';
  const searchQuery = search ? `?${search}` : '';

  const currentRef = useRef<{
    pgid: DatongPageId;
    enteredAt: number;
    params: Record<string, string | undefined>;
  } | null>(null);

  // SDK 就绪标记：纳入主 effect 依赖，SDK init 完成后触发 pgin 补发。
  const [datongReady, setDatongReady] = useState(false);

  useEffect(() => {
    const checkReady = () => {
      if (getDatong()) {
        setDatongReady(true);
        return true;
      }
      return false;
    };

    // mount 时检查一次
    if (checkReady()) return;

    const handleConsentChange = () => {
      const consent = readStoredCookieConsent();
      if (consent === COOKIE_CONSENT_ACCEPTED) {
        // consent 变化后 initDatong 是异步的，用短时轮询等待 client 就绪
        let attempts = 0;
        const timer = window.setInterval(() => {
          if (checkReady() || ++attempts > 10) {
            window.clearInterval(timer);
          }
        }, 300);
      }
    };

    window.addEventListener(COOKIE_CONSENT_CHANGED_EVENT, handleConsentChange);
    return () => {
      window.removeEventListener(COOKIE_CONSENT_CHANGED_EVENT, handleConsentChange);
    };
  }, []);

  useEffect(() => {
    const client = getDatong();
    if (!client) return;

    const nextPgid = resolveDatongPageId(pathname, searchQuery);
    const previous = currentRef.current;

    if (previous && (!nextPgid || previous.pgid !== nextPgid)) {
      const dwell = Math.max(0, Date.now() - previous.enteredAt);
      reportDatongPageEvent(DATONG_PAGE_EVENTS.PAGE_OUT, {
        pgid: previous.pgid,
        businessParams: {
          ...previous.params,
          dt_lvtm: dwell,
        },
      });
      currentRef.current = null;
    }

    if (nextPgid && (!previous || previous.pgid !== nextPgid)) {
      const params = resolvePagePrivateParams(nextPgid, pathname, searchQuery);
      reportDatongPageEvent(DATONG_PAGE_EVENTS.PAGE_IN, {
        pgid: nextPgid,
        businessParams: params,
      });
      currentRef.current = {
        pgid: nextPgid,
        enteredAt: Date.now(),
        params,
      };
    }

    return () => {
      // 组件卸载时（如切换到 CN 站不启用大同）也补一条 pgout。
      const active = currentRef.current;
      if (!active) return;
      const dwell = Math.max(0, Date.now() - active.enteredAt);
      reportDatongPageEvent(DATONG_PAGE_EVENTS.PAGE_OUT, {
        pgid: active.pgid,
        businessParams: {
          ...active.params,
          dt_lvtm: dwell,
        },
      });
      currentRef.current = null;
    };
  }, [pathname, searchQuery, datongReady]);

  return null;
};
