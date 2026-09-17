import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  creditPackageSourceId,
  sortCreditSources,
  summarizeCreditSources,
  type CreditSourceView,
  type CreditSummary,
} from "@/domain/credit-pack";
import { useRepositories } from "@/contexts/repository-context";

/**
 * 合并「套餐积分」与「付费积分包」两套数据源，供账号页积分额度模块使用。
 *
 * 为什么需要合并：套餐积分来自 pass（`operablePass.credit_total/credit_available`），
 * 付费积分包来自 credit 服务（`GET /v1/credit/packages`）。credit 服务当前只实现
 * 付费积分包，套餐积分的入口迁移「后续再补」（见 credit/AGENTS.md:3），
 * 因此账号页只能在前端把两者拼起来展示。
 *
 * ⚠️ 服务端才是扣减顺序的权威，本 hook 的排序仅用于解释性展示。
 */

/** 套餐积分入参：由调用方从 pass 取值，避免 hook 依赖 pass 的具体类型。 */
export type PlanCreditInput = {
  displayName: string;
  creditTotal: number;
  creditAvailable: number;
  /** 下一次刷新时间（套餐周期）；未知时留空 */
  nextRefreshAt?: string;
};

export type CreditSourcesState = {
  /** 按扣减优先级排序后的全部有效来源 */
  sources: CreditSourceView[];
  /** 汇总额度 */
  summary: CreditSummary;
  /** 积分包是否加载中 */
  loading: boolean;
  /** 积分包查询是否失败（套餐积分仍可展示） */
  failed: boolean;
  /** 重新拉取积分包 */
  reload: () => void;
};

/**
 * 格式化积分来源的时间节点。
 *
 * 无法解析时返回空串，由调用方决定是否隐藏该行——避免把 "Invalid Date" 显示给用户。
 */
export const formatCreditDate = (iso: string): string => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
};

export const useCreditSources = (planCredit: PlanCreditInput | null): CreditSourcesState => {
  const repositories = useRepositories();
  /* 用 ref 持有：repositories 若非 memo 化，放进依赖会导致 effect 反复重跑 */
  const repositoriesRef = useRef(repositories);
  repositoriesRef.current = repositories;

  const [packSources, setPackSources] = useState<CreditSourceView[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    let active = true;

    /* 容错：部分调用方（含既有测试的 mock）提供的 repositories 可能没有 credit 仓储。
       此时不发请求、不报错，退化为「只有套餐积分」——积分包属增量能力，
       不应让缺失它导致整个账号页崩溃。 */
    const creditRepository = repositoriesRef.current?.credit;
    if (!creditRepository) {
      setPackSources([]);
      setLoading(false);
      setFailed(false);
      return () => {
        active = false;
      };
    }

    setLoading(true);
    setFailed(false);

    void creditRepository
      .listCreditPackages()
      .then((items) => {
        if (!active) return;
        setPackSources(
          items.map((item) => ({
            source_type: "paid_pack" as const,
            source_id: creditPackageSourceId(item),
            /* 展示名用积分总额构造：查询结果不含商品名（credit/AGENTS.md:79） */
            display_name: `${item.credit_total.toLocaleString()} 积分包`,
            credit_total: item.credit_total,
            credit_available: item.credit_available,
            next_expire_at: item.expired_time,
          })),
        );
      })
      .catch(() => {
        if (!active) return;
        /* 积分包查询失败不影响套餐积分展示，只标记失败态供 UI 提示重试 */
        setPackSources([]);
        setFailed(true);
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [reloadToken]);

  const sources = useMemo(() => {
    const all: CreditSourceView[] = [];
    if (planCredit && planCredit.creditTotal > 0) {
      all.push({
        source_type: "plan",
        source_id: "plan-credit",
        display_name: planCredit.displayName,
        credit_total: planCredit.creditTotal,
        credit_available: planCredit.creditAvailable,
        next_expire_at: planCredit.nextRefreshAt,
      });
    }
    all.push(...packSources);
    return sortCreditSources(all);
  }, [packSources, planCredit]);

  const summary = useMemo(() => summarizeCreditSources(sources), [sources]);

  return { sources, summary, loading, failed, reload };
};
