import { useCallback, useRef, useState } from "react";

import { creditPackageSourceId, type CreditPackageItem } from "@/domain/credit-pack";
import { useRepositories } from "@/contexts/repository-context";
import { buildPayPlan, BRIDGE_KIND_CREDIT_PACK, type PayPlan } from "@/lib/wx-pay";
import { isGlobal } from "@/lib/region";

/**
 * 积分包购买链路编排。
 *
 * 后端契约见 docs/frontend-credit-package-integration.md：
 *   POST /v1/credit/packages/order      → { dealName, bigOrderId }
 *   POST /v1/credit/packages/order-url  → { pay_url, need_charge, ... }
 *   GET  /v1/credit/packages            → 确认积分包是否到账
 *
 * ⚠️ 与套餐（pass）链路的关键差异：积分包**没有 auth_code**，不走
 * 「中转页 + 一次性 ticket」的二维码安全模型（见 src/lib/wx-pay.ts），
 * 而是直接跳转 pay_url。因此本 hook 不涉及二维码与中转页。
 *
 * ⚠️ 到账判定是近似的：后端 GET /v1/credit/packages 不返回 package_id、
 * 也不返回购买时间（见 credit/AGENTS.md:79），无法把 order_id 与具体积分包关联。
 * 本实现用「购买前后快照对比，出现新条目即视为到账」近似判断。
 * 已知局限：若用户在别处同时购买了另一个包，可能误判为本次到账。
 * TODO(credit-pack): 后端补 package_id / order 关联后改为精确判定。
 */

/** 购买状态机，对应产品方案 7.4。 */
export type CheckoutStatus =
  | "idle"
  /** 已确认下单，正在创建订单与获取支付链接 */
  | "creating"
  /** 已跳转支付页，等待支付结果 */
  | "payment_pending"
  /** 支付已完成，积分包尚未出现在额度中 */
  | "delivery_pending"
  /** 已查到新增积分包，购买成功 */
  | "delivered"
  /** 下单或获取支付链接失败 */
  | "failed"
  /** 到账轮询超时。注意：轮询只观察「积分包是否出现」，无法区分「用户未支付」
      与「已支付但未到账」——这是中性等待态而非错误态，UI 不得按支付失败渲染
      （对齐套餐续费 renew-pass-modal 的超时静默口径）。 */
  | "delivery_exception";

export type CheckoutState = {
  status: CheckoutStatus;
  /** 当前订单号，用于异常时提供给客服排查 */
  dealName: string | null;
  /** 失败原因，供 UI 展示 */
  error: string | null;
};

/** 到账轮询参数：与产品方案「超过约定时间仍未到账」对应。 */
const DELIVERY_POLL_INTERVAL_MS = 3000;
const DELIVERY_POLL_TIMEOUT_MS = 120_000;

const INITIAL_STATE: CheckoutState = { status: "idle", dealName: null, error: null };

/** 对积分包列表做快照，用于购买前后对比。 */
const snapshotKeys = (items: readonly CreditPackageItem[]): Set<string> =>
  new Set(items.map((item) => creditPackageSourceId(item)));

export type UseCreditCheckoutResult = {
  state: CheckoutState;
  /**
   * 国内站：中转页支付计划（二维码 URL + 过期时间）。
   * status=payment_pending 且 bridgePlan 非空时，UI 渲染二维码等待扫码。
   */
  bridgePlan: PayPlan | null;
  /**
   * 国际站：信用卡托管页 URL。
   * 保留在状态中供「重新打开支付页」入口使用（对齐 pass 链路的 paymentContext.redirectUrl）。
   */
  payUrl: string | null;
  /**
   * 发起购买。
   *
   * 国内站：创建订单后生成中转页二维码（PC 端不调 order-url——jifei pay_url
   * 绑定 wx_open_id，PC 端拿不到正确的 URL；由中转页在手机端带 openid 调，
   * 对齐 pass 链路的 wxSign 编排，见 wx-pay.ts）。
   * 国际站：创建订单 → order-url 拿 pay_url 直跳（need_charge=0 时跳过跳转）。
   */
  start: (productId: string) => Promise<void>;
  /**
   * 从支付页返回后调用：开始轮询确认积分是否到账。
   * 已有轮询在跑时直接返回（防重入，对齐套餐 renew-pass-modal 的
   * paymentCheckInFlightRef）。
   */
  confirmDelivery: () => Promise<void>;
  /**
   * 单次查询到账状态（对齐套餐手动「刷新」的语义：查一次立即返回，
   * 不进入轮询循环）。返回是否已到账；未到账不改状态。
   */
  checkDeliveryOnce: () => Promise<boolean>;
  /** 重置状态，允许用户重新发起新订单。 */
  reset: () => void;
};

export const useCreditCheckout = (options?: {
  /** 支付完成回跳地址 */
  returnUrl?: string;
  /** 取消支付回跳地址 */
  cancelUrl?: string;
  /** 到账成功后的回调，用于刷新账号页额度 */
  onDelivered?: () => void;
  /** 轮询间隔，仅测试注入用 */
  pollIntervalMs?: number;
  /** 轮询超时，仅测试注入用 */
  pollTimeoutMs?: number;
}): UseCreditCheckoutResult => {
  const repositories = useRepositories();
  /* ref 持有：避免 repositories 引用变化导致回调重建与 effect 反复触发 */
  const repositoriesRef = useRef(repositories);
  repositoriesRef.current = repositories;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [state, setState] = useState<CheckoutState>(INITIAL_STATE);
  /** 国内站中转页支付计划（二维码） */
  const [bridgePlan, setBridgePlan] = useState<PayPlan | null>(null);
  /** 国际站托管页 URL（供「重新打开支付页」） */
  const [payUrl, setPayUrl] = useState<string | null>(null);
  /** 购买前的积分包快照，用于到账对比 */
  const baselineRef = useRef<Set<string>>(new Set());
  /** 轮询进行中标记：防止自动接棒与手动刷新并发（对齐套餐 paymentCheckInFlightRef） */
  const confirmingRef = useRef(false);

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
    setBridgePlan(null);
    setPayUrl(null);
  }, []);

  const start = useCallback(async (productId: string) => {
    const credit = repositoriesRef.current?.credit;
    if (!credit) {
      setState({ status: "failed", dealName: null, error: "积分包服务不可用" });
      return;
    }

    setState({ status: "creating", dealName: null, error: null });
    setBridgePlan(null);

    /* 先记录购买前快照：到账判定依赖它。失败不阻塞下单，
       但会让到账判定退化为「出现任何包即视为到账」。 */
    try {
      baselineRef.current = snapshotKeys(await credit.listCreditPackages());
    } catch {
      baselineRef.current = new Set();
    }

    let dealName: string;
    let authCode: string | undefined;
    try {
      const order = await credit.createCreditOrder(productId);
      dealName = order.dealName;
      authCode = order.auth_code;
      if (!dealName) throw new Error("订单号为空");
    } catch (error) {
      setState({
        status: "failed",
        dealName: null,
        error: error instanceof Error ? error.message : "创建订单失败",
      });
      return;
    }

    /* 国内站：中转页 + wxSign 模式（对齐 pass 链路）。
       PC 端不调 order-url——jifei pay_url 生成时绑定 wx_open_id，
       PC 端调只能拿到 H5 商品页兜底 URL。中转页在手机端带 openid 调。
       authCode 为 undefined 时 buildPayPlan 仍生成中转页 URL（灰度兼容，
       见 CreditOrderResult.auth_code 注释——后端补齐 auth_code 后即通）。 */
    if (!isGlobal) {
      const plan = buildPayPlan({
        dealName,
        authCode,
        kind: BRIDGE_KIND_CREDIT_PACK,
      });
      setBridgePlan(plan);
      setState({ status: "payment_pending", dealName, error: null });
      return;
    }

    /* 国际站：信用卡托管页（对齐 pass 链路 startIntlCardPay 的编排）。
       1. 同步打开占位窗口：window.open 必须在用户手势同步调用栈内，跨 await
          （网络往返）后会被浏览器弹窗拦截。先开 about:blank，拿到 pay_url 后再跳转。
       2. need_charge=0：零元订单已支付成功，关窗直接进入到账确认。
       3. 占位窗跳转托管页；被弹窗拦截时兜底当前页 assign。
       4. payUrl 保留在状态中，供「重新打开支付页」入口。 */
    const payWindow = typeof window !== "undefined" ? window.open("about:blank", "_blank") : null;
    try {
      const session = await credit.createCreditOrderUrl({
        deal_name: dealName,
        platform: "pc",
        return_url: optionsRef.current?.returnUrl,
        cancel_url: optionsRef.current?.cancelUrl,
      });

      /* need_charge=0：无需支付，关闭占位窗，直接进入到账确认 */
      if (session.need_charge === 0) {
        payWindow?.close();
        setState({ status: "delivery_pending", dealName, error: null });
        return;
      }

      if (!session.pay_url) {
        throw new Error("支付链接为空");
      }

      if (payWindow) {
        payWindow.location.href = session.pay_url;
      } else {
        /* 占位窗口被拦截（浏览器弹窗限制）：兜底当前页跳转 */
        window.location.assign(session.pay_url);
      }
      setPayUrl(session.pay_url);
      setState({ status: "payment_pending", dealName, error: null });
    } catch (error) {
      payWindow?.close();
      /* 订单已创建但支付链接失败：保留 dealName 供重试与客服排查，
         不自动重新下单（产品方案：不自动创建第二笔订单）。 */
      setState({
        status: "failed",
        dealName,
        error: error instanceof Error ? error.message : "获取支付链接失败",
      });
    }
  }, []);

  /* 单次到账判定：出现快照之外的新积分包即视为到账（近似判定，见文件头注释） */
  const checkDeliveryOnce = useCallback(async (): Promise<boolean> => {
    const credit = repositoriesRef.current?.credit;
    if (!credit) return false;
    try {
      const items = await credit.listCreditPackages();
      const appeared = items.some((item) => !baselineRef.current.has(creditPackageSourceId(item)));
      if (appeared) {
        setState((prev) => ({ ...prev, status: "delivered", error: null }));
        optionsRef.current?.onDelivered?.();
        return true;
      }
      return false;
    } catch {
      /* 查询失败不判定为交付异常（网络抖动），仅返回未到账 */
      return false;
    }
  }, []);

  const confirmDelivery = useCallback(async () => {
    const credit = repositoriesRef.current?.credit;
    if (!credit) return;
    /* 防重入：自动轮询接棒与手动刷新共用，已在跑则直接返回 */
    if (confirmingRef.current) return;
    confirmingRef.current = true;

    /* 启动时**不修改 status**：保持当前 payment_pending，让国内站二维码持续可见、
       国际站「已在新窗口打开」状态保持；轮询命中再切 delivered，超时切 delivery_exception。
       之前的「立即设 delivery_pending」会让国内站用户来不及看二维码。 */
    setState((prev) => ({ ...prev, error: null }));

    const intervalMs = optionsRef.current?.pollIntervalMs ?? DELIVERY_POLL_INTERVAL_MS;
    const timeoutMs = optionsRef.current?.pollTimeoutMs ?? DELIVERY_POLL_TIMEOUT_MS;
    const startedAt = Date.now();
    /* 至少尝试一次；之后按耗时判断是否继续，避免依赖 Date.now 与假定时器的耦合 */
    let attempts = 0;
    const maxAttempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));

    try {
      while (attempts < maxAttempts) {
        attempts += 1;
        const appeared = await checkDeliveryOnce();
        if (appeared) return;
        if (attempts >= maxAttempts) break;
        if (Date.now() - startedAt >= timeoutMs) break;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }

      /* 超时：保留订单号，提供刷新与联系客服入口，不自动重下单 */
      setState((prev) => ({ ...prev, status: "delivery_exception", error: null }));
    } finally {
      confirmingRef.current = false;
    }
  }, [checkDeliveryOnce]);

  return { state, bridgePlan, payUrl, start, confirmDelivery, checkDeliveryOnce, reset };
};
