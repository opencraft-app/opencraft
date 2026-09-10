'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CREDIT_PACK_DENOMINATIONS, type CreditQuote } from '@/domain/credit-pack';
import { useRepositories } from '@/contexts/repository-context';
import { useT } from '@/i18n/t';
import { isGlobal } from '@/lib/region';

/**
 * 积分包购买区域。
 *
 * 位于订阅页套餐卡片区下方的独立分区，供已有有效套餐的用户补充模型积分。
 *
 * ⚠️ 本期为「UI + 询价」范围，不接入下单与支付：
 * trade 侧 payURL 恒为空（trade/internal/logic/creditorder/service.go:178,229），
 * 拿不到微信二维码或信用卡托管页地址。整个区域由 feature flag 控制，默认关闭。
 * 详见 .workflow/native/changes/credit-pack-purchase/brief.md。
 */

/** 单个商品的询价状态：并发询价，互不影响。 */
type QuoteState =
  | { status: 'loading' }
  | { status: 'ready'; quote: CreditQuote }
  | { status: 'failed' };

/** 主按钮的五种形态，对应产品方案 6.3。 */
type PurchaseGate =
  | 'unselected'
  | 'purchasable'
  | 'not-logged-in'
  | 'no-active-plan'
  | 'quote-failed';

const CURRENCY_SYMBOL: Record<string, string> = { CNY: '¥', USD: '$' };

/** 格式化金额：保留后端返回的字符串精度，仅补币种符号。 */
const formatAmount = (quote: CreditQuote): string => {
  const symbol = CURRENCY_SYMBOL[quote.currency] ?? '';
  return `${symbol}${quote.real_total_cost}`;
};

export type CreditPackSectionProps = {
  /** 区域锚点 id，供 ?section=credits 定位 */
  sectionId?: string;
  /** 用户是否已登录 */
  isLoggedIn: boolean;
  /** 用户是否存在有效套餐；仅有效套餐用户可购买 */
  hasActivePlan: boolean;
  /** 引导登录 */
  onRequireLogin: () => void;
  /** 引导先开通套餐（定位到套餐卡片区） */
  onRequirePlan: () => void;
};

export const CreditPackSection = ({
  sectionId,
  isLoggedIn,
  hasActivePlan,
  onRequireLogin,
  onRequirePlan,
}: CreditPackSectionProps) => {
  const t = useT();
  const repositories = useRepositories();
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<Record<string, QuoteState>>({});
  const [notice, setNotice] = useState<string | null>(null);

  /* 用 ref 持有 repositories：不把它放进 useCallback / useEffect 的依赖里。
     否则一旦上层 context 返回新对象引用（非 memo 化），就会
     effect 重跑 → setQuotes → 重渲染 → effect 再跑，形成无限循环。 */
  const repositoriesRef = useRef(repositories);
  repositoriesRef.current = repositories;

  /* 并发询价：单个商品失败只影响该卡片，不影响其他已成功的卡片（产品方案 9）。 */
  const loadQuote = useCallback(async (productId: string) => {
    setQuotes((prev) => ({ ...prev, [productId]: { status: 'loading' } }));
    try {
      const quote = await repositoriesRef.current.credit.inquireCreditPrice(productId);
      setQuotes((prev) => ({ ...prev, [productId]: { status: 'ready', quote } }));
    } catch {
      setQuotes((prev) => ({ ...prev, [productId]: { status: 'failed' } }));
    }
  }, []);

  /* 挂载时对全部面额发起一次并发询价。依赖为空：询价只在挂载时执行一次，
     重试由用户点击「价格暂不可用」触发。 */
  useEffect(() => {
    void Promise.all(CREDIT_PACK_DENOMINATIONS.map((denomination) => loadQuote(denomination.product_id)));
  }, [loadQuote]);

  const selectedQuote = selectedProductId ? quotes[selectedProductId] : undefined;

  const gate: PurchaseGate = useMemo(() => {
    if (!selectedProductId) return 'unselected';
    if (!isLoggedIn) return 'not-logged-in';
    if (!hasActivePlan) return 'no-active-plan';
    if (selectedQuote?.status !== 'ready') return 'quote-failed';
    return 'purchasable';
  }, [hasActivePlan, isLoggedIn, selectedProductId, selectedQuote]);

  const primaryLabel = useMemo(() => {
    switch (gate) {
      case 'unselected':
        return t('请选择积分包');
      case 'not-logged-in':
        return t('登录后购买');
      case 'no-active-plan':
        return t('先开通套餐');
      case 'quote-failed':
        return t('价格暂不可用');
      default:
        return t('购买所选积分包');
    }
  }, [gate, t]);

  const handlePrimary = useCallback(() => {
    if (gate === 'not-logged-in') {
      onRequireLogin();
      return;
    }
    if (gate === 'no-active-plan') {
      onRequirePlan();
      return;
    }
    if (gate === 'quote-failed' && selectedProductId) {
      void loadQuote(selectedProductId);
      return;
    }
    if (gate === 'purchasable') {
      /* 支付通道未接入：后端 payURL 恒空，不调用下单接口，避免产生无法支付的孤儿订单。 */
      setNotice(t('支付通道正在接入中，敬请期待。'));
    }
  }, [gate, loadQuote, onRequireLogin, onRequirePlan, selectedProductId, t]);

  const primaryDisabled = gate === 'unselected';

  return (
    <section
      id={sectionId}
      aria-labelledby="credit-pack-heading"
      className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6"
      data-testid="credit-pack-section"
    >
      <h2 id="credit-pack-heading" className="text-xl font-semibold" style={{ color: '#333' }}>
        {t('补充模型积分')}
      </h2>
      <p className="mt-2 text-sm" style={{ color: '#666' }}>
        {t('适用于已有有效套餐、需要增加模型调用额度的用户')}
      </p>

      <ul className="mt-6 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 lg:grid-cols-5">
        {CREDIT_PACK_DENOMINATIONS.map((denomination) => {
          const state = quotes[denomination.product_id];
          const selected = selectedProductId === denomination.product_id;
          const failed = state?.status === 'failed';
          return (
            <li key={denomination.product_id}>
              <button
                type="button"
                aria-pressed={selected}
                disabled={failed}
                data-testid={`credit-pack-card-${denomination.product_id}`}
                onClick={() => setSelectedProductId(denomination.product_id)}
                className="flex w-full flex-col items-start gap-2 rounded-xl border p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-60"
                style={{
                  borderColor: selected ? '#4f46e5' : '#e5e7eb',
                  borderWidth: selected ? 2 : 1,
                  background: selected ? '#f5f3ff' : '#fff',
                }}
              >
                <span className="text-base font-semibold" style={{ color: '#333' }}>
                  {t('{{count}} 模型积分', { count: denomination.credit_total.toLocaleString() })}
                </span>
                <span className="text-sm" style={{ color: failed ? '#dc2626' : '#666' }}>
                  {state?.status === 'ready'
                    ? formatAmount(state.quote)
                    : failed
                      ? t('价格暂不可用')
                      : t('加载中…')}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className="mt-4 text-xs" style={{ color: '#999' }}>
        {t('积分包有效期为 1 个月，自支付成功并到账时起算；到期后未使用积分失效。')}
      </p>

      <div className="mt-4 flex flex-col gap-2">
        <button
          type="button"
          disabled={primaryDisabled}
          onClick={handlePrimary}
          data-testid="credit-pack-primary-action"
          className="w-full rounded-lg px-4 py-3 text-sm font-semibold text-white transition disabled:cursor-not-allowed sm:w-auto sm:self-start"
          style={{ background: primaryDisabled ? '#c7c7c7' : '#4f46e5' }}
        >
          {primaryLabel}
        </button>
        {notice ? (
          <p role="status" className="text-sm" style={{ color: '#b45309' }}>
            {notice}
          </p>
        ) : null}
      </div>

      {/* 国际站税费口径未定：credit inquiry 不返回 tax_price（套餐链路有），
          上线前需与产品/法务确认展示口径。 */}
      {isGlobal ? (
        <p className="mt-2 text-xs" style={{ color: '#999' }}>
          {t('单次付费，不会自动续费。')}
        </p>
      ) : null}
    </section>
  );
};
