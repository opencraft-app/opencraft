import { useEffect, useState } from "react";

/*
 * 积分包购买入口的可见性开关。
 *
 * 默认显示（2026-09-10 用户拍板：联调期默认放开）。
 * 控制台执行 toggle_credit_pack() 可临时隐藏/恢复，便于对照验收。
 *
 * 与 github-login-visibility / phone-login-visibility 保持同一套范式：
 * 挂在 window 上的运行时标记 + CustomEvent 广播 + React hook 订阅，无需发版切换。
 *
 * ⚠️ 合入 master 前需重新评估（详见 .workflow/native/changes/credit-pack-purchase/brief.md）：
 *   1. /subscribe 裸路由语言 bug 未修（next-site/subscribe-page-client.tsx 默认
 *      locale 为 en-US）——国际站中文用户经裸路由进入会看到整块英文积分包区域；
 *   2. 后端 package_id / auth_code 缺口（逐包 key 为临时组合值、
 *      国内站中转页鉴权待后端支持）。
 */

const CREDIT_PACK_VISIBILITY_EVENT = "lightvela:credit-pack-visibility";

type CreditPackVisibilityHost = Window & typeof globalThis & {
  toggle_credit_pack?: unknown;
  __LIGHTVELA_HIDE_CREDIT_PACK__?: boolean;
};

const resolveHost = (host?: CreditPackVisibilityHost): CreditPackVisibilityHost | null => {
  if (host) return host;
  return typeof window === "undefined" ? null : window;
};

/** 默认显示：只有显式设置了隐藏标记才不可见。 */
export const isCreditPackVisible = (host?: CreditPackVisibilityHost) =>
  resolveHost(host)?.__LIGHTVELA_HIDE_CREDIT_PACK__ !== true;

export const setCreditPackVisible = (visible: boolean, host?: CreditPackVisibilityHost) => {
  const target = resolveHost(host);
  if (!target) return false;
  target.__LIGHTVELA_HIDE_CREDIT_PACK__ = !visible;
  target.dispatchEvent(new CustomEvent<boolean>(CREDIT_PACK_VISIBILITY_EVENT, { detail: visible }));
  return visible;
};

export const installCreditPackVisibilityHelper = (host?: CreditPackVisibilityHost) => {
  const target = resolveHost(host);
  if (!target) return () => undefined;
  const originalToggle = target.toggle_credit_pack;

  const toggleCreditPack = () => {
    const next = !isCreditPackVisible(target);
    setCreditPackVisible(next, target);
    target.console.info(`Credit pack purchase section is now ${next ? "visible" : "hidden"}.`);
    return next;
  };

  target.toggle_credit_pack = toggleCreditPack;

  return () => {
    if (originalToggle === undefined) {
      delete target.toggle_credit_pack;
      return;
    }

    target.toggle_credit_pack = originalToggle;
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
