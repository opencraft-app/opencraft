import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useRepositories } from '@/contexts/repository-context';
import { useSession } from '@/contexts/session-context';
import type { Pass, PassModifyOption, PassOrderStatus } from '@/domain/types';
import { useT } from '@/i18n/t';
import { getBillingErrorCode, resolveBillingErrorMessage } from '@/lib/billing-error';
import { isGlobal } from '@/lib/region';
import { buildPayPlan, type PayPlan } from '@/lib/wx-pay';
import { type PaidUpgradeCheckout, readUpgradeCheckout, saveUpgradeCheckout, saveUpgradeReturn, UPGRADE_RETURN_QUERY, upgradeCheckoutKey, validUpgradeQuote, type UpgradeCheckoutRecord } from '@/lib/upgrade-checkout';

interface Props { pass: Pass; targetBundleId: string; initialOption?: PassModifyOption; onClose: () => void; onPaid: (checkout: PaidUpgradeCheckout) => void | Promise<void> }
// Match the new-purchase checkout's fixed 16 / 12 / 8 px corner radii.
const actionClass = 'h-12 flex-1 rounded-[8px] shadow-none transition-colors duration-150 hover:translate-y-0 motion-reduce:transition-none';
const quoteFingerprint = (option: PassModifyOption) => JSON.stringify([option.target_bundle_id, option.modify_price.currency, option.modify_price.real_total_cost, option.modify_price.tax_price ?? 0]);

/** Reuses the existing checkout visual language; no alternate catalog or payment mock. */
export function UpgradePassModal({ pass, targetBundleId, initialOption, onClose, onPaid }: Props) {
  const { session } = useSession();
  if (!session.user?.id) return null;
  return <UpgradePassModalContent pass={pass} targetBundleId={targetBundleId} initialOption={initialOption} onClose={onClose} onPaid={onPaid} />;
}

function UpgradePassModalContent({ pass, targetBundleId, initialOption, onClose, onPaid }: Props) {
  const t = useT();
  const { plans } = useRepositories();
  const { session } = useSession();
  const userId = session.user?.id ?? '';
  const [record, setRecord] = useState<UpgradeCheckoutRecord | null>(() => {
    const previous = typeof window === 'undefined' ? null : readUpgradeCheckout(window.localStorage, userId, pass.pass_id);
    // An unknown submission is not a confirmed abandoned/unpaid checkout.
    return previous?.phase === 'creating' ? previous : null;
  });
  const effectiveTarget = record?.targetBundleId ?? targetBundleId;
  const suppliedOption = initialOption?.target_bundle_id === targetBundleId && initialOption.bundle.bundle_id === targetBundleId && validUpgradeQuote(initialOption) ? initialOption : null;
  const [option, setOption] = useState<PassModifyOption | null>(suppliedOption);
  const [quoteAttempt, setQuoteAttempt] = useState(0);
  const [pricing, setPricing] = useState(!suppliedOption);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [orderStatus, setOrderStatus] = useState<PassOrderStatus | null>(null);
  const [bridge, setBridge] = useState<PayPlan | null>(null);
  const [payUrl, setPayUrl] = useState('');
  const [paymentOpened, setPaymentOpened] = useState(false);
  const [zeroPaid, setZeroPaid] = useState(false);
  const [handedOff, setHandedOff] = useState(false);
  const [now, setNow] = useState(Date.now());
  const inFlight = useRef(false);
  const statusInFlight = useRef(false);
  const paymentRetryAt = useRef(0);
  const finished = useRef(false);
  const alive = useRef(true);
  const paymentWindow = useRef<Window | null>(null);
  const callbacks = useRef({ onPaid });
  callbacks.current = { onPaid };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; paymentWindow.current?.close(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (record) { setPricing(false); return; }
    // The subscribe CTA already fetched this quote; only explicit retries fetch again here.
    if (quoteAttempt === 0 && suppliedOption) { setPricing(false); return; }
    setPricing(true); setOption(null); setError(null);
    void plans.listModifyBundles(pass.pass_id).then(result => {
      if (cancelled) return;
      const selected = result.modify_bundle_set.find(item => item.target_bundle_id === effectiveTarget);
      if (result.source_bundle_id !== pass.bundle_id || !selected || !validUpgradeQuote(selected)) {
        setError(t('当前套餐已变化或该升级目标暂不可用，请刷新后重试。')); return;
      }
      setOption(selected);
    }).catch(err => { if (!cancelled) setError(resolveBillingErrorMessage(err, t('升级询价失败，请稍后重试。'))); })
      .finally(() => { if (!cancelled) setPricing(false); });
    return () => { cancelled = true; };
  }, [effectiveTarget, pass.bundle_id, pass.pass_id, plans, quoteAttempt, record, suppliedOption, t]);

  const finishPayment = useCallback(async (dealName: string, target: string) => {
    if (finished.current) return;
    finished.current = true;
    setHandedOff(true);
    try {
      await callbacks.current.onPaid({ dealName, targetBundleId: target });
      const current = readUpgradeCheckout(window.localStorage, userId, pass.pass_id);
      if (current?.dealName === dealName) window.localStorage.removeItem(upgradeCheckoutKey(userId, pass.pass_id));
    } catch (err) {
      finished.current = false;
      if (alive.current) setHandedOff(false);
      throw err;
    }
  }, [pass.pass_id, userId]);

  const checkStatus = useCallback(async () => {
    if (!record?.dealName || statusInFlight.current || finished.current) return;
    statusInFlight.current = true;
    try {
      const status = await plans.getOrderStatus(record.dealName);
      if (!alive.current) return;
      if (status.deal_name !== record.dealName || status.order_type !== 'modify') throw new Error(t('订单信息不匹配，请联系支持。'));
      setOrderStatus(status); setStatusError(null);
      if (status.status === 'cancelled' && status.local_status === 'cancelled') {
        const current = readUpgradeCheckout(window.localStorage, userId, pass.pass_id);
        if (current?.dealName === record.dealName) window.localStorage.removeItem(upgradeCheckoutKey(userId, pass.pass_id));
        setRecord(null); setOrderStatus(null); setBridge(null); setPayUrl(''); setPaymentOpened(false); setZeroPaid(false); setError(null);
        setQuoteAttempt(value => value + 1);
        return;
      }
      if (status.status === 'paid' || status.status === 'success') {
        await finishPayment(record.dealName, record.targetBundleId);
      }
    } catch (err) {
      if (alive.current) setStatusError(resolveBillingErrorMessage(err, t('暂时无法确认升级结果，请稍后刷新。')));
    } finally { statusInFlight.current = false; }
  }, [finishPayment, pass.pass_id, plans, record, t, userId]);

  useEffect(() => {
    if (!record?.dealName || handedOff || orderStatus?.status === 'failed') return;
    void checkStatus();
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void checkStatus();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [checkStatus, handedOff, record?.dealName, orderStatus?.status]);

  function persist(next: UpgradeCheckoutRecord) {
    saveUpgradeCheckout(window.localStorage, userId, pass.pass_id, next);
    setRecord(next);
  }

  async function preparePayment(dealName: string, authCode?: string) {
    paymentRetryAt.current = Date.now() + 3000;
    if (isGlobal) {
      const cancelUrl = `${window.location.origin}${window.location.pathname}`;
      const returnUrl = `${window.location.origin}/agents/?${UPGRADE_RETURN_QUERY}=${encodeURIComponent(dealName)}`;
      saveUpgradeReturn(window.localStorage, userId, { passId: pass.pass_id, dealName, targetBundleId: effectiveTarget });
      const result = await plans.getModifyOrderUrl(pass.pass_id, { deal_names: [dealName], platform: 'pc', return_url: returnUrl, cancel_url: cancelUrl });
      if (!alive.current) return;
      if (result.deal_name !== dealName) throw new Error(t('订单信息不匹配，请联系支持。'));
      if (result.need_charge === 0) { setZeroPaid(true); await finishPayment(dealName, effectiveTarget); return; }
      if (!result.pay_url || !/^https:\/\//i.test(result.pay_url)) throw new Error(t('获取支付链接失败，请重试。'));
      setPayUrl(result.pay_url);
      if (paymentWindow.current && !paymentWindow.current.closed) {
        paymentWindow.current.location.href = result.pay_url;
        paymentWindow.current = null;
        setPaymentOpened(true);
      } else {
        // Same fallback as new purchase; the return marker restores loading after navigation.
        window.location.assign(result.pay_url);
      }
    } else {
      const ticket = authCode || (await plans.refreshModifyPaymentAuthorization(pass.pass_id, { deal_names: [dealName] })).auth_code;
      setBridge(buildPayPlan({ dealName, authCode: ticket, passId: pass.pass_id, operation: 'modify', bundleName: option?.bundle.bundle_name ?? pass.bundle_name }));
      setNow(Date.now());
    }
  }

  async function submit() {
    if (inFlight.current || record || !option || !userId || userId !== pass.user_id) return;
    inFlight.current = true; setBusy(true); setSubmitting(true); setError(null);
    try {
      // Match new purchase: reserve the hosted-payment tab within the click gesture.
      // If blocked, keep this modal polling and provide an explicit payment link.
      if (isGlobal) {
        paymentWindow.current = window.open('about:blank', '_blank');
        if (paymentWindow.current) paymentWindow.current.opener = null;
      }
      // Follow purchase checkout's in-flight guard; Web Locks add cross-tab protection where available.
      if (navigator.locks) {
        await navigator.locks.request(upgradeCheckoutKey(userId, pass.pass_id), { ifAvailable: true }, async lock => {
          if (!lock) throw new Error(t('另一个页面正在提交升级，请在该页面继续操作。'));
          await submitLocked();
        });
      } else await submitLocked();
    } catch (err) { if (alive.current) setError(resolveBillingErrorMessage(err, t('升级订单处理失败，请稍后重试。'))); }
    finally {
      paymentWindow.current?.close(); paymentWindow.current = null;
      inFlight.current = false;
      if (alive.current) { setBusy(false); setSubmitting(false); }
    }
  }

  async function submitLocked() {
    if (!option) return;
    let creating = false;
    try {
      const existing = readUpgradeCheckout(window.localStorage, userId, pass.pass_id);
      if (existing?.phase === 'creating') { setRecord(existing); return; }
      // Requote immediately before order creation; changed amounts require another explicit click.
      const latest = await plans.listModifyBundles(pass.pass_id);
      if (!alive.current) return;
      const fresh = latest.modify_bundle_set.find(item => item.target_bundle_id === targetBundleId);
      if (latest.source_bundle_id !== pass.bundle_id || !fresh || !validUpgradeQuote(fresh)) {
        setOption(null); throw new Error(t('当前套餐已变化或该升级目标暂不可用，请刷新后重试。'));
      }
      if (quoteFingerprint(fresh) !== quoteFingerprint(option)) {
        setOption(fresh); setError(t('差价已更新，请确认最新金额后再次提交。')); return;
      }
      const concurrentlyCreated = readUpgradeCheckout(window.localStorage, userId, pass.pass_id);
      if (concurrentlyCreated?.phase === 'creating') { setRecord(concurrentlyCreated); return; }
      persist({ targetBundleId, phase: 'creating' }); creating = true;
      const order = await plans.createModifyOrder(pass.pass_id, { target_bundle_id: targetBundleId });
      if (!order.deal_name) throw new Error(t('暂时无法确认订单状态，请稍后查询，避免重复付款。'));
      persist({ targetBundleId, phase: 'ordered', dealName: order.deal_name });
      creating = false;
      if (!alive.current) return;
      await preparePayment(order.deal_name, order.auth_code);
    } catch (err) {
      const code = getBillingErrorCode(err);
      const definiteRejection = code && ['UNAUTHORIZED', 'PASS_NOT_FOUND', 'PASS_INVALID_PARAM', 'PASS_NOT_ACTIVE', 'PASS_NOT_MODIFIABLE', 'PASS_MODIFYING', 'PASS_ISOLATED', 'PASS_EXPIRED', 'PASS_RENEWING', 'PASS_DELETING', 'PASS_TERMINATING', 'PASS_MODIFY_TARGET_NOT_ALLOWED', 'PASS_MODIFY_INSTANCE_NOT_READY', 'REALNAME_REQUIRED', 'ORDER_NOT_PAYABLE', 'MODIFY_CHECKOUT_CONFLICT'].includes(code);
      if (creating && definiteRejection) {
        window.localStorage.removeItem(upgradeCheckoutKey(userId, pass.pass_id));
        setRecord(null); setOption(null); creating = false;
      }
      if (alive.current) setError(creating ? t('暂时无法确认订单状态，请稍后查询，避免重复付款。') : resolveBillingErrorMessage(err, t('升级订单处理失败，请稍后重试。')));
    }
  }

  async function continuePayment() {
    if (!record?.dealName || inFlight.current || handedOff) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const status = await plans.getOrderStatus(record.dealName);
      if (!alive.current) return;
      if (status.deal_name !== record.dealName || status.order_type !== 'modify') throw new Error(t('订单信息不匹配，请联系支持。'));
      setOrderStatus(status);
      if (status.status === 'paid' || status.status === 'success') {
        await finishPayment(record.dealName, record.targetBundleId);
        return;
      }
      if (status.status !== 'pending') { await checkStatus(); return; }
      await preparePayment(record.dealName);
    } catch (err) {
      if (getBillingErrorCode(err) === 'ORDER_NOT_PAYABLE') await checkStatus();
      else if (alive.current) setError(resolveBillingErrorMessage(err, t('获取支付链接失败，请重试。')));
    }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }

  const paid = zeroPaid || orderStatus?.status === 'paid' || orderStatus?.status === 'success';
  const terminal = orderStatus?.status === 'cancelled' || orderStatus?.status === 'failed';
  const bridgeExpired = bridge !== null && now >= bridge.expiresAt;
  // Restore/refresh only this order's payment authorization. Never create another order.
  const resumePayment = useRef(continuePayment);
  resumePayment.current = continuePayment;
  useEffect(() => {
    if (!record?.dealName || busy || handedOff || paid || terminal || orderStatus?.status !== 'pending') return;
    if (isGlobal ? Boolean(payUrl) : Boolean(bridge && !bridgeExpired)) return;
    if (Date.now() < paymentRetryAt.current) return;
    paymentRetryAt.current = Date.now() + 3000;
    void resumePayment.current();
  }, [record?.dealName, busy, handedOff, paid, terminal, orderStatus?.status, payUrl, bridge, bridgeExpired, now]);
  const formatAmount = (cents: number) => `${option?.modify_price.currency === 'CNY' ? '¥' : '$'}${(cents / 100).toFixed(2)}`;
  const amount = option ? formatAmount(option.modify_price.real_total_cost) : '';
  const paymentPending = Boolean(record?.dealName && !handedOff && !terminal && !paid);
  // Keep the complete confirmation visible while the initial payment is being prepared.
  // Refreshes and unknown/failed submissions retain their existing recovery screen.
  const showConfirmation = !record || (submitting && !bridge && !payUrl && !paid && !terminal);

  return <Dialog open onOpenChange={open => { if (!open && !inFlight.current) onClose(); }}>
    <DialogContent
      closeLabel={t('关闭')}
      overlayClassName="bg-black/45 backdrop-blur-sm"
      onInteractOutside={event => event.preventDefault()}
      className="top-1/2 bottom-auto max-h-[90dvh] -translate-y-1/2 overflow-y-auto rounded-[16px] border-none bg-white p-7 text-[var(--text-primary)] md:w-[440px]"
    >
      <DialogHeader className="mb-5 flex flex-col gap-1.5 space-y-0 pr-4">
        <DialogTitle className="text-balance text-lg tracking-normal">{showConfirmation ? t('确认订单') : t('请完成支付')}</DialogTitle>
        <DialogDescription className="text-pretty text-[13px] leading-6">
          {showConfirmation ? t('订单详情') : paid ? t('支付成功，正在进入 Agent 页面...') : isGlobal ? t('请在卡支付页面完成支付，支付成功后将自动进入 Agent 页面。') : t('请使用微信扫描下方二维码完成支付')}
        </DialogDescription>
      </DialogHeader>

      {showConfirmation ? <>
        <section aria-label={t('订单详情')} className="mb-5 rounded-[12px] border border-black/10 p-5 text-sm">
          {option ? <>
            <div className="mb-4 break-words font-semibold">{option.bundle.bundle_name}</div>
            <dl className="space-y-3 text-[var(--text-secondary)]">
              <div className="flex items-start justify-between gap-4"><dt className="shrink-0">{t('套餐配置')}</dt><dd className="text-right leading-6 text-[var(--text-primary)]">{option.bundle.cpu} {t('核')} CPU · {option.bundle.memory} GB {t('内存')}<br />{option.bundle.system_disk_size} GB {t('存储')}</dd></div>
              <div className="flex items-start justify-between gap-4"><dt>{t('模型积分')}</dt><dd className="text-right tabular-nums text-[var(--text-primary)]">{option.bundle.credit.toLocaleString()} {t('积分')}</dd></div>
            </dl>
            <div className="mt-4 border-t border-black/10 pt-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2"><span className="text-[var(--text-secondary)]">{t('应补差价')}</span><strong className="text-[28px] font-bold tabular-nums">{amount}</strong></div>
              {(option.modify_price.tax_price ?? 0) > 0 && <p className="mt-1 text-right text-xs tabular-nums text-[var(--text-secondary)]">{t('其中税费')}：{formatAmount(option.modify_price.tax_price ?? 0)}</p>}
            </div>
          </> : <p role="status" className="py-4 text-[var(--text-secondary)]">{pricing ? t('正在查询升级差价...') : t('升级询价失败，请稍后重试。')}</p>}
        </section>
        <div className="mb-6 flex items-center gap-2.5 rounded-[12px] border border-black/10 px-5 py-4 text-sm font-medium">
          <span aria-hidden="true" className="flex size-[18px] shrink-0 items-center justify-center rounded-full border-2 border-[var(--text-primary)]"><span className="size-2.5 rounded-full bg-[var(--text-primary)]" /></span>
          {!isGlobal && <svg aria-hidden="true" viewBox="0 0 24 24" className="size-[22px] shrink-0">
            <circle cx="12" cy="12" r="12" fill="#07C160" />
            <path d="M17.2 10.8c-.4-2.1-2.5-3.6-5-3.6-2.8 0-5.1 1.9-5.1 4.3 0 1.4.8 2.6 2 3.5l-.5 1.5 1.8-1c.6.2 1.2.3 1.8.3.3 0 .5 0 .8-.1-.2-.4-.2-.8-.2-1.2 0-2.1 2-3.7 4.4-3.7z" fill="#fff" />
            <path d="M19.5 14.5c0-1.7-1.7-3.1-3.8-3.1s-3.8 1.4-3.8 3.1 1.7 3.1 3.8 3.1c.4 0 .9-.1 1.3-.2l1.2.7-.3-1.1c1-0.6 1.6-1.5 1.6-2.5z" fill="#fff" />
          </svg>}
          {isGlobal ? t('卡支付') : t('微信支付')}
        </div>
      </> : <div className="mb-5">
        {!isGlobal && paymentPending && bridge && !bridgeExpired ? <div className="flex justify-center rounded-[12px] bg-[#F7F6F5] p-4"><QRCodeSVG value={bridge.bridgeUrl} size={180} aria-label={t('微信扫码支付')} /></div> : <div role="status" className="rounded-[12px] bg-[#F7F6F5] px-5 py-10 text-center text-sm leading-6 text-[var(--text-secondary)]">
          {terminal ? t('订单已关闭或失败，请联系支持确认后再操作。') : paid ? t('支付成功，正在进入 Agent 页面...') : record?.phase === 'creating' ? t('暂时无法确认订单状态，请稍后查询，避免重复付款。') : isGlobal ? payUrl ? t('卡支付') : t('正在获取支付链接...') : t('正在更新支付二维码...')}
        </div>}
        {paymentPending && <div className="mt-5 text-center text-pretty text-[13px] leading-6 text-[var(--text-secondary)]">{t('支付完成后，将自动进入 Agent 页面升级套餐。')}</div>}
      </div>}

      {error && <p role="alert" className="mb-4 text-pretty text-sm text-[var(--danger)]">{error}</p>}
      {statusError && <p role="alert" className="mb-4 text-pretty text-sm text-[var(--danger)]">{statusError}</p>}

      {showConfirmation ? <div className="flex gap-3">
        <Button variant="outline" className={actionClass} disabled={busy} onClick={onClose}>{t('取消')}</Button>
        {!pricing && !option ? <Button className={actionClass} onClick={() => setQuoteAttempt(value => value + 1)}>{t('重新询价')}</Button> : <Button className={actionClass} aria-busy={busy || undefined} disabled={busy || pricing || !option || !userId || userId !== pass.user_id} onClick={() => void submit()}>{busy ? <><Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />{t('正在处理...')}</> : option ? t('支付 {{amount}}', { amount }) : t('支付')}</Button>}
      </div> : paymentPending ? isGlobal && payUrl ? <Button asChild className={`${actionClass} w-full`}><a href={payUrl} target="_blank" rel="noopener noreferrer" onClick={() => setPaymentOpened(true)}>{paymentOpened ? t('重新打开支付页') : t('前往支付')}</a></Button> : <Button variant="outline" className={`${actionClass} w-full border-[var(--text-primary)]`} disabled={busy} onClick={() => void continuePayment()}>{busy ? t('刷新中...') : t('刷新')}</Button> : null}
    </DialogContent>
  </Dialog>;
}
