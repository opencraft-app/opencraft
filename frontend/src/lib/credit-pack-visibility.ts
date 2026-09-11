import { useEffect, useState } from "react";

/*
 * 积分包购买入口的可见性开关。
 *
 * 默认关闭（2026-09-11 用户决策：恢复 flag 门控；2026-09-10 曾短暂默认放开）。
 * 控制台执行 show_credit_pack() 可开启，便于内部验收。
 *
 * 与 github-login-visibility / phone-login-visibility 保持同一套范式：
 * 挂在 window 上的运行时开关 + CustomEvent 广播 + React hook 订阅，无需发版切换。
 *
 * ⚠️ 正式放开（默认显示）的前置条件（详见 .workflow/native/changes/credit-pack-purchase/brief.md）：
 *   1. 修复 /subscribe 裸路由语言 bug（next-site/subscribe-page-client.tsx 默认
 *      locale 为 en-US）——国际站中文用户经裸路由进入会看到整块英文积分包区域；
 *   2. 后端补齐 auth_code（国内站中转页鉴权）与 package_id（逐包稳定标识）；
 *   3. pay_url 相对路径拼域名（国际站直跳场景）。
 */

const CREDIT_PACK_VISIBILITY_EVENT = "lightvela:credit-pack-visibility";

type CreditPackVisibilityHost = Window & typeof globalThis & {
  show_credit_pack?: unknown;
  __LIGHTVELA_SHOW_CREDIT_PACK__?: boolean;
};

const resolveHost = (host?: CreditPackVisibilityHost): CreditPackVisibilityHost | null => {
  if (host) return host;
  return typeof window === "undefined" ? null : window;
};

/** 默认隐藏：只有显式设置了显示标记才可见。 */
export const isCreditPackVisible = (host?: CreditPackVisibilityHost) =>
  resolveHost(host)?.__LIGHTVELA_SHOW_CREDIT_PACK__ === true;

export const setCreditPackVisible = (visible: boolean, host?: CreditPackVisibilityHost) => {
  const target = resolveHost(host);
  if (!target) return false;
  target.__LIGHTVELA_SHOW_CREDIT_PACK__ = visible;
  target.dispatchEvent(new CustomEvent<boolean>(CREDIT_PACK_VISIBILITY_EVENT, { detail: visible }));
  return visible;
};

export const installCreditPackVisibilityHelper = (host?: CreditPackVisibilityHost) => {
  const target = resolveHost(host);
  if (!target) return () => undefined;
  const originalShowCreditPack = target.show_credit_pack;

  const showCreditPack = () => {
    setCreditPackVisible(true, target);
    target.console.info("Credit pack purchase section is now visible.");
    return true;
  };

  target.show_credit_pack = showCreditPack;

  return () => {
    if (originalShowCreditPack === undefined) {
      delete target.show_credit_pack;
      return;
    }

    target.show_credit_pack = originalShowCreditPack;
  };
};

export const useCreditPackVisibility = () => {
  const [visible, setVisible] = useState(() => isCreditPackVisible());

  useEffect(() => {
    const syncVisibility = () => {
      setVisible(isCreditPackVisible());
    };

    syncVisibility();
    window.addEventListener(CREDIT_PACK_VISIBILITY_EVENT, syncVisibility);
    return () => {
      window.removeEventListener(CREDIT_PACK_VISIBILITY_EVENT, syncVisibility);
    };
  }, []);

  return visible;
};
