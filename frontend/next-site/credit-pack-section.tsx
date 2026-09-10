'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CREDIT_PACK_DENOMINATIONS, type CreditProduct, type CreditQuote } from '@/domain/credit-pack';
import { useRepositories } from '@/contexts/repository-context';
import { RepositoryError } from '@/repositories/http-repositories';
import { useT } from '@/i18n/t';
import { useCreditCheckout } from '@/lib/use-credit-checkout';
import { centsToYuan, formatYuan } from '@/lib/billing-flow';
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

/** URL query 参数名（与 subscribe-page 的 section 定位约定一致） */
const SECTION_QUERY_KEY_PARAM = 'section';
const CREDIT_SECTION_QUERY_VALUE_PARAM = 'credits';
/** 支付回跳标记 */
const PAY_RETURN_QUERY_KEY = 'credit_pay';
const PAY_RETURN_QUERY_VALUE = 'return';

/**
 * 格式化金额。
 *
 * ⚠️ 联调文档 §5：金额字段沿用现有计费接口的**最小货币单位（分）**，
 * 与套餐 BundlePrice 一致（见 billing-flow.ts 的 centsToYuan），
 * 展示前必须除以 100 转元。
 */
const formatAmount = (quote: CreditQuote): string =>
  formatYuan(centsToYuan(quote.real_total_cost), quote.currency);

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
  const [modalOpen, setModalOpen] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  /* 在线商品（接口真源）：加载中为 null 表示尚未拿到 */
  const [onlineProducts, setOnlineProducts] = useState<readonly CreditProduct[] | null>(null);

  /* 用 ref 持有 repositories：不把它放进 useCallback / useEffect 的依赖里。
     否则一旦上层 context 返回新对象引用（非 memo 化），就会
     effect 重跑 → setQuotes → 重渲染 → effect 再跑，形成无限循环。 */
  const repositoriesRef = useRef(repositories);
  repositoriesRef.current = repositories;

  /* 商品列表：GET /v1/credit/products 是商品在线状态与增减的真源（联调文档 §4）。
     productsFailed 时退化为常量表全量展示——商品接口不可用不应导致整个区域空白。 */
  const [productsFailed, setProductsFailed] = useState(false);
  const loadProducts = useCallback(async () => {
    try {
      const products = await repositoriesRef.current.credit.listCreditProducts();
      setOnlineProducts(products.filter((p) => p.state === 'ONLINE'));
      setProductsFailed(false);
    } catch {
      setOnlineProducts([]);
      setProductsFailed(true);
    }
  }, []);

  /* 并发询价：单个商品失败只影响该卡片，不影响其他已成功的卡片（产品方案 9）。
     409（商品下线）特殊处理：刷新商品列表并取消选中（产品方案 9 状态矩阵）。 */
  const loadQuote = useCallback(
    async (productId: string) => {
      setQuotes((prev) => ({ ...prev, [productId]: { status: 'loading' } }));
      try {
        const quote = await repositoriesRef.current.credit.inquireCreditPrice(productId);
        setQuotes((prev) => ({ ...prev, [productId]: { status: 'ready', quote } }));
      } catch (error) {
        if (error instanceof RepositoryError && error.status === 409) {
          /* 商品已下线：刷新商品列表（联调文档 §9），由展示层移除该卡并取消选中 */
          setSelectedProductId((current) => (current === productId ? null : current));
          setNotice(t('该积分包暂不可购买'));
          void loadProducts();
        }
        setQuotes((prev) => ({ ...prev, [productId]: { status: 'failed' } }));
      }
    },
    [loadProducts, t],
  );

  /* 待展示的卡片 = 接口在线商品 ∩ 积分数量映射表。
     映射表没有的 product_id 无法展示「N 模型积分」核心信息，跳过并告警；
     TODO(credit-pack): 后端 products 补 credit_total 后删除映射表。 */
  const visibleDenominations = useMemo(() => {
    const source = productsFailed || onlineProducts === null ? CREDIT_PACK_DENOMINATIONS : onlineProducts;
    const onlineIds = new Set(source.map((p) => p.product_id));
    const known = CREDIT_PACK_DENOMINATIONS.filter((d) => onlineIds.has(d.product_id));
    if (!productsFailed && onlineProducts) {
      const unknown = onlineProducts.filter(
        (p) => !CREDIT_PACK_DENOMINATIONS.some((d) => d.product_id === p.product_id),
      );
      if (unknown.length > 0) {
        console.warn('[credit-pack] 接口返回了映射表之外的商品，暂不展示：', unknown.map((p) => p.product_id).join(', '));
      }
    }
    return known;
  }, [onlineProducts, productsFailed]);

  /* 挂载时拉商品列表，并对全部面额发起一次并发询价。重试由用户交互触发。 */
  useEffect(() => {
    void loadProducts();
    void Promise.all(CREDIT_PACK_DENOMINATIONS.map((denomination) => loadQuote(denomination.product_id)));
  }, [loadProducts, loadQuote]);

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
      /* 打开订单确认弹窗：勾选虚拟商品条款后才可支付（产品方案 7.1） */
      setTermsAccepted(false);
      setModalOpen(true);
    }
  }, [gate, loadQuote, onRequireLogin, onRequirePlan, selectedProductId]);

  const primaryDisabled = gate === 'unselected';

  /* 支付回跳标记：order-url 的 return_url 会带上它，返回后触发到账确认 */
  /* 构造回跳地址：当前页 + section 定位 + 支付返回标记 */
  const buildReturnUrl = useCallback((cancelled: boolean) => {
    if (typeof window === 'undefined') return undefined;
    const url = new URL(window.location.href);
    url.searchParams.set(SECTION_QUERY_KEY_PARAM, CREDIT_SECTION_QUERY_VALUE_PARAM);
    url.searchParams.set(PAY_RETURN_QUERY_KEY, cancelled ? 'cancel' : PAY_RETURN_QUERY_VALUE);
    return url.toString();
  }, []);

  const checkout = useCreditCheckout({
    returnUrl: buildReturnUrl(false),
    cancelUrl: buildReturnUrl(true),
    onDelivered: () => {
      /* 到账后刷新询价无关，仅清弹窗；账号页额度由用户返回后刷新 */
      setModalOpen(false);
    },
  });

  /* 从支付页返回（credit_pay=return）时自动进入交付确认 */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get(PAY_RETURN_QUERY_KEY) === PAY_RETURN_QUERY_VALUE) {
      /* 消费掉标记，避免刷新时重复触发 */
      params.delete(PAY_RETURN_QUERY_KEY);
      const cleaned = params.toString();
      const url = `${window.location.pathname}${cleaned ? `?${cleaned}` : ''}`;
    window.history.replaceState(window.history.state, '', url);
      void checkout.confirmDelivery();
    }
    /* checkout.confirmDelivery 是稳定引用（useCallback 空依赖），不会反复触发 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 支付中/到账中的状态文案（产品方案 7.4） */
  const checkoutNotice = useMemo(() => {
    switch (checkout.state.status) {
      case 'creating':
        return t('正在创建订单…');
      case 'payment_pending':
        return t('已跳转支付页面，完成支付后返回本页确认到账。');
      case 'delivery_pending':
        return t('积分到账处理中，请稍候…');
      case 'delivered':
        return t('购买成功，积分已到账。');
      case 'delivery_exception':
        return t('支付已完成但积分尚未到账，请稍后刷新；如有疑问请联系客服并提供订单号：{{deal}}', {
          deal: checkout.state.dealName ?? '',
        });
      case 'failed':
        return t('下单失败：{{reason}}', { reason: checkout.state.error ?? '' });
      default:
        return null;
    }
  }, [checkout.state, t]);

  /* 确认弹窗内点「确认支付」 */
  const handleConfirmPay = useCallback(() => {
    if (!selectedProductId) return;
    void checkout.start(selectedProductId);
  }, [checkout, selectedProductId]);

  const selectedDenomination = useMemo(
    () => CREDIT_PACK_DENOMINATIONS.find((d) => d.product_id === selectedProductId),
    [selectedProductId],
  );

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

      {visibleDenominations.length > 0 ? (
        <ul className="mt-6 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 lg:grid-cols-5">
          {visibleDenominations.map((denomination) => {
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
      ) : null}

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
        {checkoutNotice ? (
          <p
            role="status"
            data-testid="credit-pack-checkout-status"
            className="text-sm"
            style={{ color: checkout.state.status === 'delivered' ? '#15803d' : '#b45309' }}
          >
            {checkoutNotice}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="text-sm" style={{ color: '#b45309' }}>
            {notice}
          </p>
        ) : null}
        {checkout.state.status === 'delivery_exception' ? (
          <button
            type="button"
            onClick={() => void checkout.confirmDelivery()}
            className="text-sm font-semibold underline underline-offset-2"
            style={{ color: '#4f46e5' }}
          >
            {t('重新查询到账状态')}
          </button>
        ) : null}
      </div>

      {/* 国际站税费口径未定：credit inquiry 不返回 tax_price（套餐链路有），
          上线前需与产品/法务确认展示口径。 */}
      {isGlobal ? (
        <p className="mt-2 text-xs" style={{ color: '#999' }}>
          {t('单次付费，不会自动续费。')}
        </p>
      ) : null}

      {/* 订单确认弹窗：勾选虚拟商品条款后才可支付（产品方案 7.1） */}
      {modalOpen && selectedDenomination && selectedQuote?.status === 'ready' ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="credit-pack-modal-title"
          data-testid="credit-pack-confirm-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(event) => {
            if (event.target === event.currentTarget) setModalOpen(false);
          }}
        >
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h3 id="credit-pack-modal-title" className="text-lg font-semibold" style={{ color: '#333' }}>
              {t('确认购买积分包')}
            </h3>

            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <dt style={{ color: '#666' }}>{t('商品')}</dt>
                <dd className="font-semibold" style={{ color: '#333' }}>
                  {t('{{count}} 模型积分', { count: selectedDenomination.credit_total.toLocaleString() })}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt style={{ color: '#666' }}>{t('有效期')}</dt>
                <dd style={{ color: '#333' }}>{t('到账后 1 个月')}</dd>
              </div>
              <div className="flex justify-between">
                <dt style={{ color: '#666' }}>{t('购买数量')}</dt>
                <dd style={{ color: '#333' }}>{t('1 份')}</dd>
              </div>
              <div className="flex justify-between">
                <dt style={{ color: '#666' }}>{t('应付金额')}</dt>
                <dd className="font-semibold" style={{ color: '#333' }}>
                  {formatAmount(selectedQuote.quote)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt style={{ color: '#666' }}>{t('支付方式')}</dt>
                <dd style={{ color: '#333' }}>{isGlobal ? t('信用卡 / 借记卡') : t('微信支付')}</dd>
              </div>
            </dl>

            <label className="mt-4 flex items-start gap-2 text-xs leading-relaxed" style={{ color: '#666' }}>
              <input
                type="checkbox"
                checked={termsAccepted}
                onChange={(event) => setTermsAccepted(event.target.checked)}
                data-testid="credit-pack-terms-checkbox"
                className="mt-0.5"
              />
              <span>
                {t('我已知晓：本商品为虚拟积分商品，支付成功后即时到账，有效期 1 个月；积分到账后不支持自主退款，到期未使用部分失效。')}
                {isGlobal ? null : (
                  <>
                    <br />
                    {t('法律规定、重复扣款或平台交付异常等情况，由客服核验处理。')}
                  </>
                )}
              </span>
            </label>

            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-lg border px-4 py-2 text-sm font-semibold"
                style={{ borderColor: '#d1d5db', color: '#666' }}
              >
                {t('取消')}
              </button>
              <button
                type="button"
                disabled={!termsAccepted || checkout.state.status === 'creating'}
                onClick={handleConfirmPay}
                data-testid="credit-pack-confirm-pay"
                className="rounded-lg px-4 py-2 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
                style={{ background: '#4f46e5' }}
              >
                {checkout.state.status === 'creating' ? t('正在创建订单…') : t('确认支付')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
};
