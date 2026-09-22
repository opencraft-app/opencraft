'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CREDIT_PACK_DENOMINATIONS, type CreditProduct, type CreditQuote } from '@/domain/credit-pack';
import { useRepositories } from '@/contexts/repository-context';
import { RepositoryError } from '@/repositories/http-repositories';
import { useT } from '@/i18n/t';
import { useCreditCheckout } from '@/lib/use-credit-checkout';
import { centsToYuan, formatYuan } from '@/lib/billing-flow';
import { ACCOUNT_BILLING_PATH } from '@/lib/agent-routes';
import { useAppNavigate } from '@/lib/app-navigation';
import { isGlobal } from '@/lib/region';
import { cn } from '@/lib/utils';

/**
 * 积分包购买区域。
 *
 * 位于订阅页套餐卡片区下方的独立分区，供已有有效套餐的用户补充模型积分。
 *
 * 支持询价、下单、支付和到账状态确认，国内站和国际站均直接展示。
 */

/** 单个商品的询价状态：并发询价，互不影响。 */
type QuoteState =
  | { status: 'loading' }
  | { status: 'ready'; quote: CreditQuote }
  | { status: 'failed' };

/** 主按钮的购买资格状态。 */
type PurchaseGate =
  | 'unselected'
  | 'purchasable'
  | 'not-logged-in'
  | 'no-active-plan'
  | 'realname-required'
  | 'quote-loading'
  | 'quote-unavailable';

/** URL query 参数名（与 subscribe-page 的 section 定位约定一致） */
const SECTION_QUERY_KEY_PARAM = 'section';
const CREDIT_SECTION_QUERY_VALUE_PARAM = 'credits';
/** 支付回跳标记 */
const PAY_RETURN_QUERY_KEY = 'credit_pay';
const PAY_RETURN_QUERY_VALUE = 'return';

/**
 * 下单接口在不同网关版本中可能把绑定错误作为业务 code 或嵌套 message
 * 返回。统一在展示层识别这些稳定语义，避免用户看到「重新下单」并重复提交。
 */
const isCreditPackBindingError = (error: string | null): boolean => {
  if (!error) return false;
  return /BindingNotFound|binding[_ ]not[_ ]found|shadow[_ ]binding|shadow binding|影子账号绑定|uin is required|app[_ ]id is required/i.test(error);
};

/**
 * 格式化金额。
 *
 * ⚠️ 联调文档 §5：金额字段沿用现有计费接口的**最小货币单位（分）**，
 * 与套餐 BundlePrice 一致（见 billing-flow.ts 的 centsToYuan），
 * 展示前必须除以 100 转元。
 */
const parseCents = (value: string): number | null => {
  const cents = Number(value);
  return Number.isInteger(cents) && cents >= 0 ? cents : null;
};

const formatQuoteAmounts = (quote: CreditQuote) => {
  const priceCents = parseCents(quote.price);
  const totalCents = parseCents(quote.real_total_cost);
  if (priceCents === null || totalCents === null || totalCents < priceCents) return null;

  return {
    price: formatYuan(centsToYuan(priceCents), quote.currency),
    tax: formatYuan(centsToYuan(totalCents - priceCents), quote.currency),
    total: formatYuan(centsToYuan(totalCents), quote.currency),
  };
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
  /** 用户是否具备完整实名/影子账号绑定，可进入下单。 */
  canPurchaseCreditPack?: boolean;
  /** 引导完成实名认证。 */
  onRequireRealname?: () => void;
};

export const CreditPackSection = ({
  sectionId,
  isLoggedIn,
  hasActivePlan,
  onRequireLogin,
  onRequirePlan,
  canPurchaseCreditPack = true,
  onRequireRealname = () => undefined,
}: CreditPackSectionProps): React.ReactElement => {
  const t = useT();
  const navigate = useAppNavigate();
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
        /* 契约防御：响应缺少金额字段或总价小于积分包价格时按询价失败处理，
           显示「价格暂不可用」而非渲染崩溃 */
        if (
          !quote ||
          typeof quote.price !== "string" ||
          typeof quote.real_total_cost !== "string" ||
          formatQuoteAmounts(quote) === null
        ) {
          throw new Error("invalid quote response");
        }
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

  const gate: PurchaseGate = useMemo(() => {
    if (!selectedProductId) return 'unselected';
    if (!isLoggedIn) return 'not-logged-in';
    if (!hasActivePlan) return 'no-active-plan';
    if (!canPurchaseCreditPack) return 'realname-required';
    const quoteStatus = quotes[selectedProductId]?.status;
    if (quoteStatus === 'failed') return 'quote-unavailable';
    if (quoteStatus !== 'ready') return 'quote-loading';
    return 'purchasable';
  }, [canPurchaseCreditPack, hasActivePlan, isLoggedIn, quotes, selectedProductId]);

  const primaryLabel = useMemo(() => {
    switch (gate) {
      case 'unselected':
        return t('请选择积分包');
      case 'not-logged-in':
        return t('登录后购买');
      case 'no-active-plan':
        return t('先开通套餐');
      case 'realname-required':
        return t('完成实名后购买');
      case 'quote-loading':
        return t('加载中…');
      case 'quote-unavailable':
        return t('价格暂不可用');
      default:
        return t('购买所选积分包');
    }
  }, [gate, t]);

  /* 支付回跳标记：order-url 的 return_url 会带上它，返回后触发到账确认 */
  /* 构造回跳地址（对齐 pass 链路 startIntlCardPay 的做法）：
     去掉当前 URL 的 query/hash 再拼标记——防止把 OAuth code、一次性 ticket
     等敏感 query 带进计费回跳地址；同时带 section 定位与支付返回标记。 */
  const buildReturnUrl = useCallback((cancelled: boolean) => {
    if (typeof window === 'undefined') return undefined;
    const base = (window.location.href.split('#')[0] ?? '').split('?')[0] ?? '';
    if (!base) return undefined;
    return `${base}?${SECTION_QUERY_KEY_PARAM}=${CREDIT_SECTION_QUERY_VALUE_PARAM}&${PAY_RETURN_QUERY_KEY}=${cancelled ? 'cancel' : PAY_RETURN_QUERY_VALUE}`;
  }, []);

  const checkout = useCreditCheckout({
    returnUrl: buildReturnUrl(false),
    cancelUrl: buildReturnUrl(true),
    /* 到账后不自动关弹窗：弹窗内展示「购买成功」态，用户点「完成」跳转账户页
       （对齐 pass 的 PaymentPendingModal 成功态） */
  });
  const hasCurrentOrder = checkout.state.status !== 'idle' && checkout.state.status !== 'failed';
  const effectivePrimaryLabel =
    hasCurrentOrder ? t('订单详情') : primaryLabel;
  const primaryDisabled = !hasCurrentOrder && (
    gate === 'unselected'
    || gate === 'realname-required'
    || gate === 'quote-loading'
    || gate === 'quote-unavailable'
  );

  const handlePrimary = useCallback(() => {
    if (gate === 'not-logged-in') {
      onRequireLogin();
      return;
    }
    if (gate === 'no-active-plan') {
      onRequirePlan();
      return;
    }
    if (gate === 'realname-required') {
      onRequireRealname();
      return;
    }
    if (hasCurrentOrder) {
      setTermsAccepted(false);
      setModalOpen(true);
      return;
    }
    if (gate === 'purchasable') {
      /* 仍可能到账的旧订单必须保留：reset 会递增 checkout generation，导致旧轮询
         无法写回到账结果。只有明确失败时才回到确认订单阶段；支付中、到账中、
         超时待确认和已到账状态均直接恢复原弹窗。 */
      if (checkout.state.status === 'failed') {
        checkout.reset();
      }
      /* 打开订单确认弹窗：勾选虚拟商品条款后才可支付（产品方案 7.1） */
      setTermsAccepted(false);
      setModalOpen(true);
    }
  }, [checkout, gate, hasCurrentOrder, onRequireLogin, onRequirePlan, onRequireRealname, selectedProductId]);

  /* 到账轮询统一启动：payment_pending（扫码 / 新窗口支付）或 delivery_pending
     （need_charge=0 零元单）即开始，超时进 delivery_exception 后可手动重查，
     也可 reset 重新发起新订单（对齐 pass 链路「PC 端轮询接棒」）。
     用 ref 防重入：同一订单只自动启动一次轮询。 */
  const pollStartedForRef = useRef<string | null>(null);
  useEffect(() => {
    const { status, dealName } = checkout.state;
    if (!dealName) return;
    if (status !== 'payment_pending' && status !== 'delivery_pending') return;
    if (pollStartedForRef.current === dealName) return;
    pollStartedForRef.current = dealName;
    void checkout.confirmDelivery();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkout.state.status, checkout.state.dealName]);

  /* 国际站「重新打开支付页」（对齐 pass 的 paymentContext.redirectUrl 用法） */
  const handleReopenPayPage = useCallback(() => {
    if (checkout.payUrl && typeof window !== 'undefined') {
      window.open(checkout.payUrl, '_blank', 'noopener,noreferrer');
    }
  }, [checkout.payUrl]);

  /* 手动刷新到账状态（对齐套餐 renew-pass-modal 的 checkRenewalStatus 单查语义）：
     单次查询立即返回；未到账时弹窗内提示「暂未确认支付结果，请稍后刷新。」。
     轮询超时后的刷新也走这里——checkDeliveryOnce 命中即切 delivered。 */
  const [checkingPayment, setCheckingPayment] = useState(false);
  const [recheckPendingNotice, setRecheckPendingNotice] = useState(false);
  const handleManualRecheck = useCallback(async () => {
    if (checkingPayment) return;
    setCheckingPayment(true);
    setRecheckPendingNotice(false);
    try {
      const delivered = await checkout.checkDeliveryOnce();
      if (!delivered) {
        /* 未到账不改状态：payment_pending 保持（自动轮询继续），仅提示 */
        setRecheckPendingNotice(true);
      }
    } finally {
      setCheckingPayment(false);
    }
  }, [checkingPayment, checkout.checkDeliveryOnce]);

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

  /* 只为异常与手动刷新未到账渲染独立状态行。成功、到账处理中由弹窗说明承载，
     避免同一句文案在 DialogDescription 和状态行中重复。 */
  const checkoutStatusNotice = useMemo(() => {
    if (checkout.state.status === 'failed' && isCreditPackBindingError(checkout.state.error)) {
      return t('请先完成实名认证，完成影子账号绑定后再购买积分包。');
    }
    switch (checkout.state.status) {
      case 'payment_pending':
        return recheckPendingNotice ? t('暂未确认支付结果，请稍后刷新。') : null;
      case 'delivery_exception':
        /* 轮询超时无法区分「未支付」与「已支付未到账」，文案必须中性——
           与套餐续费（renew-pass-modal）的字面口径一致，不预设用户已支付；
           订单号由弹窗内的订单号行统一展示（客服排查入口）。 */
        return recheckPendingNotice ? t('暂未确认支付结果，请稍后刷新。') : null;
      case 'failed':
        /* 文案必须中性：failed 不等于「下单失败」——订单可能已创建成功
           （如支付票据未下发、pay_url 为空），说「下单失败」会诱导用户
           重复下单产生双订单。与 delivery_exception 的中性口径一致。 */
        return t('支付未完成：{{reason}}', { reason: checkout.state.error ?? '' });
      default:
        return null;
    }
  }, [checkout.state.status, checkout.state.error, recheckPendingNotice, t]);

  const checkoutNeedsRealname = checkout.state.status === 'failed' && isCreditPackBindingError(checkout.state.error);

  /* 二维码过期校验：bridgePlan.expiresAt 由 buildPayPlan 写入（now + 9 分钟，
     比后端 auth_code TTL 10 分钟短 1 分钟 buffer）。中转页（wechat-pay-page）
     在扫码侧校验过期；PC 弹窗侧这里兜底——payment_pending 保留态下用户隔了
     TTL 再开弹窗，不应继续渲染已失效的二维码（扫码只会得到过期提示）。
     弹窗打开且有二维码期间每秒 tick 驱动过期翻转。 */
  const [qrNow, setQrNow] = useState(() => Date.now());
  const bridgePlanVisible = modalOpen && checkout.bridgePlan;
  useEffect(() => {
    if (!bridgePlanVisible) return;
    const timer = window.setInterval(() => setQrNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [bridgePlanVisible]);
  const qrExpired = checkout.bridgePlan != null && qrNow >= checkout.bridgePlan.expiresAt;
  const isQrPaymentState =
    checkout.state.status === 'payment_pending' || checkout.state.status === 'delivery_exception';
  const isExpiredQrOrder = !isGlobal && isQrPaymentState && checkout.bridgePlan != null && qrExpired;

  /* 确认弹窗内点「确认支付」 */
  const handleConfirmPay = useCallback(() => {
    if (!selectedProductId) return;
    void checkout.start(selectedProductId);
  }, [checkout, selectedProductId]);

  const handleReorder = useCallback(() => {
    const productId = checkout.state.productId;
    checkout.reset();
    if (productId) setSelectedProductId(productId);
    setTermsAccepted(false);
  }, [checkout]);

  const dialogProductId =
    checkout.state.status === 'idle' ? selectedProductId : (checkout.state.productId ?? selectedProductId);
  const dialogDenomination = useMemo(
    () => CREDIT_PACK_DENOMINATIONS.find((d) => d.product_id === dialogProductId),
    [dialogProductId],
  );
  const dialogQuote = dialogProductId && quotes[dialogProductId]?.status === 'ready'
    ? quotes[dialogProductId].quote
    : null;
  const dialogAmounts = dialogQuote ? formatQuoteAmounts(dialogQuote) : null;
  const isConfirmationStep = checkout.state.status === 'idle' || checkout.state.status === 'creating';
  const paymentDialogTitle =
    checkout.state.status === 'delivered'
      ? t('购买成功')
      : checkout.state.status === 'delivery_pending'
        ? t('积分到账处理中')
        : checkout.state.status === 'failed'
          ? checkoutNeedsRealname
            ? t('请完成实名认证')
            : t('支付遇到问题')
          : isGlobal
            ? t('信用卡支付')
            : t('请完成支付');
  const paymentDialogDescription =
    checkout.state.status === 'delivered'
      ? t('购买成功，积分已到账。')
      : checkout.state.status === 'delivery_pending'
        ? t('积分到账处理中，请稍候…')
        : checkout.state.status === 'delivery_exception'
          ? t('暂时无法确认订单状态，请稍后查询，避免重复付款。')
          : isExpiredQrOrder
            ? t('暂时无法确认订单状态，请稍后查询，避免重复付款。')
        : checkout.state.status === 'failed'
          ? checkoutNeedsRealname
            ? t('完成实名认证后即可购买积分包。')
            : t('请查看下方提示并重新下单。')
          : isGlobal
            ? t('已在新窗口打开信用卡支付页')
            : t('请使用微信扫描下方二维码完成支付');

  return (
    <section
      id={sectionId}
      aria-labelledby="credit-pack-heading"
      className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6"
      data-testid="credit-pack-section"
    >
      <h2 id="credit-pack-heading" className="text-balance text-xl font-semibold text-[var(--text-primary)]">
        {t('模型积分')}
      </h2>
      <p className="mt-2 text-pretty text-sm text-[var(--text-secondary)]">
        {t('选购模型积分，畅享更多大模型调用')}
      </p>

      {visibleDenominations.length > 0 ? (
        <ul className="mt-6 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 lg:grid-cols-5">
          {visibleDenominations.map((denomination) => {
            const selected = selectedProductId === denomination.product_id;
            const quoteState = quotes[denomination.product_id];
            return (
              <li key={denomination.product_id}>
                <button
                  type="button"
                  aria-pressed={selected}
                  disabled={quoteState?.status === 'failed'}
                  data-testid={`credit-pack-card-${denomination.product_id}`}
                  onClick={() => setSelectedProductId(denomination.product_id)}
                  className={cn(
                    'relative flex w-full flex-col items-start gap-2 rounded-md border-2 bg-white p-4 pr-11 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60',
                    selected
                      ? 'border-[var(--text-primary)]'
                      : 'border-[var(--border-strong)] hover:border-[var(--text-primary)]/30',
                  )}
                >
                  <Check
                    aria-hidden="true"
                    strokeWidth={3}
                    data-testid={`credit-pack-selected-indicator-${denomination.product_id}`}
                    className={cn('absolute right-4 top-4 size-5 text-[#07C160]', !selected && 'invisible')}
                  />
                  <span className="text-pretty text-base font-semibold text-[var(--text-primary)]">
                    {t('{{count}} 模型积分', { count: denomination.credit_total.toLocaleString() })}
                  </span>
                  <span className="text-sm tabular-nums text-[var(--text-secondary)]">
                    {quoteState?.status === 'ready'
                      ? formatQuoteAmounts(quoteState.quote)?.total ?? t('价格暂不可用')
                      : quoteState?.status === 'failed'
                        ? t('价格暂不可用')
                        : t('加载中…')}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <p className="mt-4 max-w-4xl text-pretty text-xs leading-relaxed text-[var(--text-tertiary)]">
        {t('积分包有效期为 1 个月，自支付成功并到账时起算；到期后未使用积分失效。')}
      </p>
      <p className="mt-1 max-w-4xl text-pretty text-xs leading-relaxed text-[var(--text-tertiary)]">
        {t('适用于已有有效套餐、需要增加模型调用额度的用户。实际抵扣优先使用到期时间更早的额度；到期时间相同时，优先使用创建时间更早的额度。')}
      </p>
      <p className="mt-1 max-w-4xl text-pretty text-xs leading-relaxed text-[var(--text-tertiary)]">
        {t('最终付款价格包含税费，请以付款页面显示为准。')}
      </p>

      <div className="mt-4 flex flex-col gap-2">
        <button
          type="button"
          disabled={primaryDisabled}
          onClick={handlePrimary}
          data-testid="credit-pack-primary-action"
          className="w-full rounded-md bg-[var(--text-primary)] px-4 py-3 text-sm font-semibold text-white transition-opacity duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-35 sm:w-auto sm:self-start"
        >
          {effectivePrimaryLabel}
        </button>
        {/* 支付进度只存在于弹窗内：页面按钮下方不挂任何状态提示行
            （对齐套餐续费——关闭弹窗即回到干净页面，进度与操作都在弹窗里）。 */}
        {notice ? (
          <p role="status" className="text-sm" style={{ color: '#b45309' }}>
            {notice}
          </p>
        ) : null}
        {gate === 'realname-required' ? (
          <button
            type="button"
            onClick={onRequireRealname}
            data-testid="credit-pack-realname-action"
            className="w-full rounded-md border border-[var(--text-primary)] bg-white px-4 py-3 text-sm font-semibold text-[var(--text-primary)] transition-colors duration-150 hover:bg-[var(--surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 sm:w-auto sm:self-start"
          >
            {t('去实名认证')}
          </button>
        ) : null}
      </div>

      {isGlobal ? (
        <p className="mt-2 text-xs" style={{ color: '#999' }}>
          {t('单次付费，不会自动续费。')}
        </p>
      ) : null}

      {/* 积分下单保持两阶段：确认订单后进入对应站点的支付与到账状态。 */}
      {dialogDenomination && dialogAmounts ? (
        <Dialog open={modalOpen} onOpenChange={setModalOpen}>
          <DialogContent
            closeLabel={t('关闭')}
            data-testid="credit-pack-confirm-modal"
            onPointerDownOutside={(event) => event.preventDefault()}
            className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-lg border border-[var(--border-strong)] bg-white p-0 shadow-2xl md:w-[30rem]"
          >
            {isConfirmationStep ? (
              <div className="p-6">
                <DialogHeader className="mb-5 pr-8">
                  <DialogTitle className="text-balance">{t('确认订单')}</DialogTitle>
                  <DialogDescription className="text-pretty">{t('订单详情')}</DialogDescription>
                </DialogHeader>

                <dl className="rounded-md border border-[var(--border-strong)] p-5 text-sm">
                  <div className="flex items-start justify-between gap-4 text-[var(--text-secondary)]">
                    <dt className="text-pretty">
                      {t('{{count}} 模型积分', { count: dialogDenomination.credit_total.toLocaleString() })}
                    </dt>
                    <dd className="shrink-0 font-semibold tabular-nums text-[var(--text-primary)]">{dialogAmounts.price}</dd>
                  </div>
                  <div className="mt-3 flex items-start justify-between gap-4 text-[var(--text-secondary)]">
                    <dt>{t('有效期')}</dt>
                    <dd className="font-semibold text-[var(--text-primary)]">{t('到账后 1 个月')}</dd>
                  </div>
                  <div data-testid="credit-pack-price-breakdown" className="mt-4 border-t border-[var(--border-strong)] pt-4 text-[var(--text-secondary)]">
                    <div className="mt-3 space-y-1 text-sm">
                      <div className="flex items-center justify-between"><dt>{t('积分包价格')}</dt><dd>{dialogAmounts.price}</dd></div>
                      <div className="flex items-center justify-between"><dt>{t('税费')}</dt><dd>{dialogAmounts.tax}</dd></div>
                    </div>
                    <p className="text-xs leading-relaxed">{t('最终付款价格包含税费，请以付款页面显示为准。')}</p>
                  </div>
                  <div className="my-4 h-px bg-[var(--border-strong)]" />
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-[var(--text-secondary)]">{t('总计：')}</dt>
                    <dd className="text-2xl font-bold tabular-nums text-[var(--text-primary)]">{dialogAmounts.total}</dd>
                  </div>
                </dl>

                <div className="mt-5 flex items-center gap-3 rounded-md border border-[var(--border-strong)] px-5 py-4">
                  <span
                    aria-hidden="true"
                    className="flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-[var(--text-primary)]"
                  >
                    <span className="size-2.5 rounded-full bg-[var(--text-primary)]" />
                  </span>
                  {isGlobal ? null : (
                    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-6 shrink-0">
                      <circle cx="12" cy="12" r="12" fill="#07C160" />
                      <path d="M17.2 10.8c-.4-2.1-2.5-3.6-5-3.6-2.8 0-5.1 1.9-5.1 4.3 0 1.4.8 2.6 2 3.5l-.5 1.5 1.8-1c.6.2 1.2.3 1.8.3.3 0 .5 0 .8-.1-.2-.4-.2-.8-.2-1.2 0-2.1 2-3.7 4.4-3.7z" fill="#fff" />
                      <path d="M19.5 14.5c0-1.7-1.7-3.1-3.8-3.1s-3.8 1.4-3.8 3.1 1.7 3.1 3.8 3.1c.4 0 .9-.1 1.3-.2l1.2.7-.3-1.1c1-.6 1.6-1.5 1.6-2.5z" fill="#fff" />
                    </svg>
                  )}
                  <span className="font-medium text-[var(--text-primary)]">
                    {isGlobal ? t('信用卡 / 借记卡') : t('微信支付')}
                  </span>
                </div>

                <label className="mt-5 flex items-start gap-2 text-pretty text-xs leading-relaxed text-[var(--text-secondary)]">
                  <input
                    type="checkbox"
                    checked={termsAccepted}
                    onChange={(event) => setTermsAccepted(event.target.checked)}
                    data-testid="credit-pack-terms-checkbox"
                    className="mt-0.5 size-4 rounded border-[var(--border-strong)] accent-[var(--text-primary)]"
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

                <div className="mt-6 grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setModalOpen(false)}
                    className="h-11 rounded-md border border-[var(--border-strong)] bg-white px-4 text-sm font-semibold text-[var(--text-primary)] transition-colors duration-150 hover:bg-[var(--surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                  >
                    {t('取消')}
                  </button>
                  <button
                    type="button"
                    disabled={!termsAccepted || checkout.state.status === 'creating'}
                    onClick={handleConfirmPay}
                    data-testid="credit-pack-confirm-pay"
                    className="h-11 rounded-md bg-[var(--text-primary)] px-4 text-sm font-semibold text-white transition-opacity duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    {checkout.state.status === 'creating' ? (
                      t('正在创建订单…')
                    ) : (
                      <>{t('支付')} {dialogAmounts.total}</>
                    )}
                  </button>
                </div>
              </div>
            ) : (
              <div className="p-6">
                <DialogHeader className="mb-5 pr-8">
                  <DialogTitle className="text-balance">{paymentDialogTitle}</DialogTitle>
                  <DialogDescription className="text-pretty">{paymentDialogDescription}</DialogDescription>
                </DialogHeader>

                <dl
                  data-testid="credit-pack-active-order-product"
                  className="mb-5 flex items-center justify-between gap-4 rounded-md border border-[var(--border-strong)] px-4 py-3 text-sm"
                >
                  <dt className="text-pretty font-medium text-[var(--text-primary)]">
                    {t('{{count}} 模型积分', { count: dialogDenomination.credit_total.toLocaleString() })}
                  </dt>
                  <dd className="shrink-0 font-semibold tabular-nums text-[var(--text-primary)]">{dialogAmounts.total}</dd>
                </dl>

                {isQrPaymentState && !isGlobal && checkout.bridgePlan && !qrExpired ? (
                  <div
                    data-testid="credit-pack-qr-panel"
                    className="flex min-h-64 items-center justify-center rounded-md bg-[var(--surface-muted)] p-6"
                  >
                    <div data-testid="credit-pack-wx-qr" className="bg-white p-2">
                      <QRCodeSVG value={checkout.bridgePlan.bridgeUrl} size={180} level="M" includeMargin={false} />
                    </div>
                  </div>
                ) : null}

                {isExpiredQrOrder ? (
                  <p
                    data-testid="credit-pack-qr-expired"
                    className="rounded-md bg-[var(--surface-muted)] px-5 py-12 text-center text-sm text-[var(--text-secondary)]"
                  >
                    {t('二维码已过期，请重新下单。')}
                  </p>
                ) : null}

                {checkout.state.status === 'payment_pending' && !isGlobal && !qrExpired ? (
                  <p className="mt-5 text-center text-pretty text-sm text-[var(--text-secondary)]">
                    {t('支付完成后，需等待约 15 秒完成下单')}
                  </p>
                ) : null}

                {checkoutStatusNotice ? (
                  <p
                    role="status"
                    aria-live="polite"
                    className="mt-4 text-center text-pretty text-sm leading-relaxed text-[var(--text-secondary)]"
                    data-testid="credit-pack-modal-checkout-status"
                  >
                    {checkoutStatusNotice}
                  </p>
                ) : null}

                {checkout.state.dealName && checkout.state.status !== 'delivered' ? (
                  <p
                    className="mt-1 text-center text-xs text-[var(--text-tertiary)]"
                    data-testid="credit-pack-modal-order-number"
                  >
                    {t('订单号：{{deal}}', { deal: checkout.state.dealName })}
                  </p>
                ) : null}

                <div className="mt-6 flex flex-col gap-3">
                  {checkout.payUrl && checkout.state.status === 'payment_pending' ? (
                    <button
                      type="button"
                      onClick={handleReopenPayPage}
                      data-testid="credit-pack-reopen-pay"
                      className="h-11 w-full rounded-md bg-[var(--text-primary)] px-4 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                    >
                      {t('重新打开支付页面')}
                    </button>
                  ) : null}
                  {checkout.state.status === 'payment_pending' || checkout.state.status === 'delivery_exception' ? (
                    <button
                      type="button"
                      onClick={() => void handleManualRecheck()}
                      disabled={checkingPayment}
                      data-testid="credit-pack-recheck"
                      className="h-11 w-full rounded-md border border-[var(--text-primary)] bg-white px-4 text-sm font-semibold text-[var(--text-primary)] transition-colors duration-150 hover:bg-[var(--surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {checkingPayment ? t('刷新中...') : t('刷新')}
                    </button>
                  ) : null}
                  {checkout.state.status === 'failed' && !checkoutNeedsRealname || isExpiredQrOrder ? (
                    <button
                      type="button"
                      onClick={handleReorder}
                      data-testid="credit-pack-reorder"
                      className="h-11 w-full rounded-md bg-[var(--text-primary)] px-4 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                    >
                      {t('重新下单')}
                    </button>
                  ) : null}
                  {checkout.state.status === 'payment_pending' ||
                  checkout.state.status === 'delivery_exception' ||
                  checkout.state.status === 'failed' && !checkoutNeedsRealname ? (
                    <button
                      type="button"
                      onClick={() => setModalOpen(false)}
                      className="h-10 w-full rounded-md px-4 text-sm font-medium text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                    >
                      {t('暂不处理')}
                    </button>
                  ) : null}
                  {checkoutNeedsRealname ? (
                    <button
                      type="button"
                      onClick={onRequireRealname}
                      data-testid="credit-pack-modal-realname-action"
                      className="h-11 w-full rounded-md bg-[var(--text-primary)] px-4 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                    >
                      {t('去实名认证')}
                    </button>
                  ) : null}
                  {checkout.state.status === 'delivered' || checkout.state.status === 'delivery_pending' ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (checkout.state.status === 'delivered') {
                          navigate(ACCOUNT_BILLING_PATH);
                          return;
                        }
                        setModalOpen(false);
                      }}
                      className="h-11 w-full rounded-md bg-[var(--text-primary)] px-4 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                    >
                      {checkout.state.status === 'delivered' ? t('完成') : t('暂不处理')}
                    </button>
                  ) : null}
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
};
