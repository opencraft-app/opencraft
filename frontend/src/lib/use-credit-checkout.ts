import { useCallback, useRef, useState } from "react";

import { creditPackageSourceId, type CreditPackageItem } from "@/domain/credit-pack";
import { useRepositories } from "@/contexts/repository-context";

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
  /** 超过约定时间仍未到账 */
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
   * 发起购买：创建订单 → 获取支付链接 → 跳转支付页。
   *
   * need_charge=0 时跳过跳转，直接进入到账确认。
   */
  start: (productId: string) => Promise<void>;
  /** 从支付页返回后调用：开始轮询确认积分是否到账。 */
  confirmDelivery: () => Promise<void>;
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
  /** 购买前的积分包快照，用于到账对比 */
  const baselineRef = useRef<Set<string>>(new Set());

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  const start = useCallback(async (productId: string) => {
    const credit = repositoriesRef.current?.credit;
    if (!credit) {
      setState({ status: "failed", dealName: null, error: "积分包服务不可用" });
      return;
    }

    setState({ status: "creating", dealName: null, error: null });

    /* 先记录购买前快照：到账判定依赖它。失败不阻塞下单，
       但会让到账判定退化为「出现任何包即视为到账」。 */
    try {
      baselineRef.current = snapshotKeys(await credit.listCreditPackages());
    } catch {
      baselineRef.current = new Set();
    }

    let dealName: string;
    try {
      const order = await credit.createCreditOrder(productId);
      dealName = order.dealName;
      if (!dealName) throw new Error("订单号为空");
    } catch (error) {
      setState({
        status: "failed",
        dealName: null,
        error: error instanceof Error ? error.message : "创建订单失败",
      });
      return;
    }

    try {
      const session = await credit.createCreditOrderUrl({
        deal_name: dealName,
        platform: "pc",
        return_url: optionsRef.current?.returnUrl,
        cancel_url: optionsRef.current?.cancelUrl,
      });

      /* need_charge=0：无需支付，直接进入到账确认 */
      if (session.need_charge === 0) {
        setState({ status: "delivery_pending", dealName, error: null });
        return;
      }

      if (!session.pay_url) {
        setState({ status: "failed", dealName, error: "支付链接为空" });
        return;
      }

      /* 跳转支付页。用 assign 保留历史，便于用户返回。 */
      setState({ status: "payment_pending", dealName, error: null });
      if (typeof window !== "undefined") {
        window.location.assign(session.pay_url);
      }
    } catch (error) {
      /* 订单已创建但支付链接失败：保留 dealName 供重试与客服排查，
         不自动重新下单（产品方案：不自动创建第二笔订单）。 */
      setState({
        status: "failed",
        dealName,
        error: error instanceof Error ? error.message : "获取支付链接失败",
      });
    }
  }, []);

  const confirmDelivery = useCallback(async () => {
    const credit = repositoriesRef.current?.credit;
    if (!credit) return;

    setState((prev) => ({ ...prev, status: "delivery_pending", error: null }));

    const intervalMs = optionsRef.current?.pollIntervalMs ?? DELIVERY_POLL_INTERVAL_MS;
    const timeoutMs = optionsRef.current?.pollTimeoutMs ?? DELIVERY_POLL_TIMEOUT_MS;
    const baseline = baselineRef.current;
    const startedAt = Date.now();
    /* 至少尝试一次；之后按耗时判断是否继续，避免依赖 Date.now 与假定时器的耦合 */
    let attempts = 0;
    const maxAttempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));

    while (attempts < maxAttempts) {
      attempts += 1;
      try {
        const items = await credit.listCreditPackages();
        const appeared = items.some((item) => !baseline.has(creditPackageSourceId(item)));
        if (appeared) {
          setState((prev) => ({ ...prev, status: "delivered", error: null }));
          optionsRef.current?.onDelivered?.();
          return;
        }
      } catch {
        /* 单次查询失败不终止轮询：网络抖动不应判定为交付异常 */
      }
      if (attempts >= maxAttempts) break;
      if (Date.now() - startedAt >= timeoutMs) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    /* 超时：保留订单号，提供刷新与联系客服入口，不自动重下单 */
    setState((prev) => ({ ...prev, status: "delivery_exception", error: null }));
  }, []);

  return { state, start, confirmDelivery, reset };
};
