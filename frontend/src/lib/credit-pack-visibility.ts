import { useEffect, useState } from "react";

/*
 * 积分包购买入口的可见性开关。
 *
 * 默认关闭：后端支付链路尚未就绪（trade 的 creditorder 服务 payURL 恒为空，
 * 见 trade/internal/logic/creditorder/service.go:178,229），积分包查询也缺少
 * package_id（credit/AGENTS.md:79），因此购买流程无法闭环、逐包明细无法稳定标识。
 *
 * 与 github-login-visibility / phone-login-visibility 保持同一套范式：
 * 挂在 window 上的运行时开关 + CustomEvent 广播 + React hook 订阅，
 * 无需发版即可在控制台执行 `show_credit_pack()` 打开，便于内部验收。
 *
 * ⚠️ 开启前置条件（详见 .workflow/native/changes/credit-pack-purchase/brief.md）：
 *   1. 后端补齐 payURL / package_id，支付与到账链路可闭环；
 *   2. 修复 /subscribe 裸路由语言 bug（next-site/subscribe-page-client.tsx 默认
 *      locale 为 en-US，会让国际站中文用户看到整块英文）。
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

export const isCreditPackVisible = (host?: CreditPackVisibilityHost) =>
  resolveHost(host)?.__LIGHTVELA_SHOW_CREDIT_PACK__ === true;

export const setCreditPackVisible = (visible: boolean, host?: CreditPackVisibilityHost) => {
  const target = resolveHost(host);
  if (!target) return false;
  target.__LIGHTVELA_SHOW_CREDIT_PACK__ = visible;
  target.dispatchEvent(new CustomEvent<boolean>(CREDIT_PACK_VISIBILITY_EVENT, { detail: visible }));
  return visible;
};

export const installShowCreditPackHelper = (host?: CreditPackVisibilityHost) => {
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
