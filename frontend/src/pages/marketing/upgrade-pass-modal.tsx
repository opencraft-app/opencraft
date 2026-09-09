import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useRepositories } from '@/contexts/repository-context';
import { useSession } from '@/contexts/session-context';
import type { Pass, PassModifyOption, PassOrderStatus } from '@/domain/types';
import { useT } from '@/i18n/t';
import { getBillingErrorCode, resolveBillingErrorMessage } from '@/lib/billing-error';
import { isGlobal } from '@/lib/region';
import { buildPayPlan, type PayPlan } from '@/lib/wx-pay';
import { isUpgradeDelivered, readUpgradeCheckout, saveUpgradeCheckout, upgradeCheckoutKey, validUpgradeQuote, type UpgradeCheckoutRecord } from '@/lib/upgrade-checkout';

interface Props { pass: Pass; targetBundleId: string; onClose: () => void; onSuccess: () => void | Promise<void> }
const primaryButton = 'w-full rounded-full bg-[#202020] px-5 py-3 text-sm font-semibold text-white hover:bg-black disabled:opacity-45';
const secondaryButton = 'rounded-full border border-[#E6E9EF] bg-white px-5 py-2.5 text-sm font-semibold text-[#333] hover:bg-black/[0.02] disabled:opacity-45';
const quoteFingerprint = (option: PassModifyOption) => JSON.stringify([option.target_bundle_id, option.modify_price.currency, option.modify_price.real_total_cost, option.modify_price.tax_price ?? 0]);

/** Reuses the existing checkout visual language; no alternate catalog or payment mock. */
export function UpgradePassModal({ pass, targetBundleId, onClose, onSuccess }: Props) {
  const t = useT();
  const { plans } = useRepositories();
  const { session } = useSession();
  const userId = session.user?.id ?? '';
  const [record, setRecord] = useState<UpgradeCheckoutRecord | null>(() => typeof window === 'undefined' ? null : readUpgradeCheckout(window.localStorage, userId, pass.pass_id));
  const effectiveTarget = record?.targetBundleId ?? targetBundleId;
  const [option, setOption] = useState<PassModifyOption | null>(null);
  const [quoteAttempt, setQuoteAttempt] = useState(0);
  const [pricing, setPricing] = useState(true);
  const [recovering, setRecovering] = useState(true);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [orderStatus, setOrderStatus] = useState<PassOrderStatus | null>(null);
  const [bridge, setBridge] = useState<PayPlan | null>(null);
  const [payUrl, setPayUrl] = useState('');
  const [zeroPaid, setZeroPaid] = useState(false);
  const [done, setDone] = useState(false);
  const [now, setNow] = useState(Date.now());
  const inFlight = useRef(false);
  const statusInFlight = useRef(false);
  const finished = useRef(false);
  const alive = useRef(true);
  const callbacks = useRef({ onSuccess });
  callbacks.current = { onSuccess };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    let cancelled = false;
    setRecovering(true);
    void plans.getModifyCheckout(pass.pass_id).then(result => {
      if (cancelled) return;
      if (result.checkout) {
        const restored: UpgradeCheckoutRecord = { targetBundleId: result.checkout.target_bundle_id, phase: 'ordered', dealName: result.checkout.deal_name };
        saveUpgradeCheckout(window.localStorage, userId, pass.pass_id, restored);
        setRecord(restored);
      }
      setRecovering(false);
    }).catch(err => {
      if (!cancelled) { setPricing(false); setError(resolveBillingErrorMessage(err, t('暂时无法确认升级结果，请稍后刷新。'))); }
    });
    return () => { cancelled = true; };
  }, [pass.pass_id, plans, userId, quoteAttempt, t]);

  useEffect(() => {
    let cancelled = false;
    if (recovering) return;
    if (record) { setPricing(false); return; }
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
  }, [effectiveTarget, pass.bundle_id, pass.pass_id, plans, quoteAttempt, record, recovering, t]);

  const checkStatus = useCallback(async () => {
    if (!record?.dealName || statusInFlight.current || finished.current) return;
    statusInFlight.current = true; setChecking(true);
    try {
      const [status, passes] = await Promise.all([plans.getOrderStatus(record.dealName), plans.listMyPasses()]);
      if (!alive.current) return;
      if (status.deal_name !== record.dealName || status.order_type !== 'modify') throw new Error(t('订单信息不匹配，请联系支持。'));
      setOrderStatus(status); setStatusError(null);
      if (status.status === 'cancelled' && status.local_status === 'cancelled') {
        const current = readUpgradeCheckout(window.localStorage, userId, pass.pass_id);
        if (current?.dealName === record.dealName) window.localStorage.removeItem(upgradeCheckoutKey(userId, pass.pass_id));
        setRecord(null); setOrderStatus(null); setBridge(null); setPayUrl(''); setZeroPaid(false); setError(null);
        setQuoteAttempt(value => value + 1);
        return;
      }
      if (isUpgradeDelivered(status, passes.find(item => item.pass_id === pass.pass_id && item.user_id === userId), pass.pass_id, record.targetBundleId)) {
        finished.current = true; setDone(true); setError(null);
        window.localStorage.removeItem(upgradeCheckoutKey(userId, pass.pass_id));
        await callbacks.current.onSuccess();
      }
    } catch (err) {
      if (alive.current) setStatusError(resolveBillingErrorMessage(err, t('暂时无法确认升级结果，请稍后刷新。')));
    } finally { statusInFlight.current = false; if (alive.current) setChecking(false); }
  }, [pass.pass_id, plans, record, t, userId]);

  useEffect(() => {
    if (!record?.dealName || done) return;
    void checkStatus();
    const start = Date.now();
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (Date.now() - start < 10 * 60 * 1000) void checkStatus();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [checkStatus, done, record?.dealName]);

  function persist(next: UpgradeCheckoutRecord) {
    saveUpgradeCheckout(window.localStorage, userId, pass.pass_id, next);
    setRecord(next);
  }

  async function preparePayment(dealName: string, authCode?: string) {
    if (isGlobal) {
      const returnUrl = `${window.location.origin}${window.location.pathname}`;
      const result = await plans.getModifyOrderUrl(pass.pass_id, { deal_names: [dealName], platform: 'pc', return_url: returnUrl, cancel_url: returnUrl });
      if (result.deal_name !== dealName) throw new Error(t('订单信息不匹配，请联系支持。'));
      if (result.need_charge === 0) { setZeroPaid(true); return; }
      if (!result.pay_url || !/^https:\/\//i.test(result.pay_url)) throw new Error(t('获取支付链接失败，请重试。'));
      setPayUrl(result.pay_url);
    } else {
      const ticket = authCode || (await plans.refreshModifyPaymentAuthorization(pass.pass_id, { deal_names: [dealName] })).auth_code;
      setBridge(buildPayPlan({ dealName, authCode: ticket, passId: pass.pass_id, operation: 'modify', bundleName: option?.bundle.bundle_name ?? pass.bundle_name }));
      setNow(Date.now());
    }
  }

  async function submit() {
    if (inFlight.current || record || !option || !userId || userId !== pass.user_id) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      // Follow purchase checkout's in-flight guard; Web Locks add cross-tab protection where available.
      if (navigator.locks) {
        await navigator.locks.request(upgradeCheckoutKey(userId, pass.pass_id), { ifAvailable: true }, async lock => {
          if (!lock) throw new Error(t('另一个页面正在提交升级，请在该页面继续操作。'));
          await submitLocked();
        });
      } else await submitLocked();
    } catch (err) { if (alive.current) setError(resolveBillingErrorMessage(err, t('升级订单处理失败，请稍后重试。'))); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }

  async function submitLocked() {
    if (!option) return;
    let creating = false;
    try {
      const existing = readUpgradeCheckout(window.localStorage, userId, pass.pass_id);
      if (existing) { setRecord(existing); return; }
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
      if (concurrentlyCreated) { setRecord(concurrentlyCreated); return; }
      persist({ targetBundleId, phase: 'creating' }); creating = true;
      const order = await plans.createModifyOrder(pass.pass_id, { target_bundle_id: targetBundleId });
      if (!order.deal_name) throw new Error(t('下单结果待确认，请勿重复下单，请联系支持核对。'));
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
      if (alive.current) setError(creating ? t('下单结果待确认，请勿重复下单，请联系支持核对。') : resolveBillingErrorMessage(err, t('升级订单处理失败，请稍后重试。')));
    }
  }

  async function continuePayment() {
    if (!record?.dealName || inFlight.current || done) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const status = await plans.getOrderStatus(record.dealName);
      if (!alive.current) return;
      if (status.deal_name !== record.dealName || status.order_type !== 'modify') throw new Error(t('订单信息不匹配，请联系支持。'));
      setOrderStatus(status);
      if (status.status !== 'pending') { await checkStatus(); return; }
      await preparePayment(record.dealName);
    } catch (err) {
      if (getBillingErrorCode(err) === 'ORDER_NOT_PAYABLE') await checkStatus();
      else if (alive.current) setError(resolveBillingErrorMessage(err, t('获取支付链接失败，请重试。')));
    }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }

  async function recoverOrder() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const result = await plans.getModifyCheckout(pass.pass_id);
      if (!alive.current) return;
      if (!result.checkout) {
        setError(t('尚未找到可恢复的订单，请勿重复下单，请联系支持核对。')); return;
      }
      persist({ targetBundleId: result.checkout.target_bundle_id, phase: 'ordered', dealName: result.checkout.deal_name });
    } catch (err) { if (alive.current) setError(resolveBillingErrorMessage(err, t('暂时无法确认升级结果，请稍后刷新。'))); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }

  const paid = zeroPaid || orderStatus?.status === 'paid' || orderStatus?.status === 'success';
  const terminal = orderStatus?.status === 'cancelled' || orderStatus?.status === 'failed';
  const bridgeExpired = bridge !== null && now >= bridge.expiresAt;
  return <Dialog open onOpenChange={open => { if (!open && !inFlight.current) onClose(); }}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto rounded-xl border-[#E6E9EF] bg-white p-7 text-[#333] md:w-[480px]">
      <DialogHeader><DialogTitle>{done ? t('升级成功') : t('升级套餐')}</DialogTitle><DialogDescription>
        {record ? t('支付完成后将继续确认套餐交付，请勿重复下单。') : t('按剩余有效期补差价，升级后到期时间不变。')}
      </DialogDescription></DialogHeader>
      <div className="space-y-5">
        <div className="rounded-lg border border-[#E6E9EF] bg-[#F9F8F7] p-4 text-sm">
          <p>{pass.bundle_name} → {option?.bundle.bundle_name ?? effectiveTarget}</p>
          {option && <p className="mt-2 text-[#999]">{option.bundle.cpu} CPU · {option.bundle.memory} GB · {option.bundle.system_disk_size} GB · {option.bundle.credit} {t('积分')}</p>}
          <p className="mt-2 text-[#999]">{t('到期时间')}：{pass.expired_time.slice(0, 10)}</p>
        </div>
        {!record && <>
          {pricing ? <p role="status">{t('正在查询升级差价...')}</p> : option && <div className="space-y-2 tabular-nums">
            {(option.modify_price.tax_price ?? 0) > 0 && <p className="text-sm text-[#999]">{t('其中税费')}：{option.modify_price.currency} {((option.modify_price.tax_price ?? 0) / 100).toFixed(2)}</p>}
            <div className="flex items-center justify-between"><span>{t('应补差价')}</span><strong className="text-2xl">{option.modify_price.currency} {(option.modify_price.real_total_cost / 100).toFixed(2)}</strong></div>
          </div>}
          <button className={primaryButton} disabled={busy || pricing || recovering || !option || !userId || userId !== pass.user_id} onClick={() => void submit()}>{busy ? t('正在处理...') : t('确认升级并支付')}</button>
          {!pricing && !option && <button className={secondaryButton} onClick={() => setQuoteAttempt(value => value + 1)}>{t('重新询价')}</button>}
        </>}
        {record && <>
          {record.dealName && <p className="break-all text-xs text-[#999]">{t('订单号')}：{record.dealName}</p>}
          <p role="status" className="font-semibold">{done ? t('目标套餐已生效') : terminal ? t('订单已关闭或失败，请联系支持确认后再操作。') : paid ? t('已支付，套餐升级中') : record.phase === 'creating' ? t('下单结果待确认，请勿重复下单，请联系支持核对。') : t('等待支付')}</p>
          {!done && !terminal && !paid && record.dealName && <>
            {bridge && !bridgeExpired && <div className="flex flex-col items-center gap-3"><QRCodeSVG value={bridge.bridgeUrl} size={192} aria-label={t('微信扫码支付')} /><p className="text-sm text-[#999]">{t('请使用微信扫码支付')}</p><a className="text-sm text-[#333] underline" href={bridge.bridgeUrl}>{t('已在微信中？点击支付')}</a></div>}
            {bridgeExpired && <p className="text-sm text-[#999]">{t('支付二维码已过期，请重新获取。')}</p>}
            {payUrl && <a className="block rounded-full bg-[#202020] px-5 py-3 text-center text-sm font-semibold text-white" href={payUrl} target="_blank" rel="noopener noreferrer">{t('前往支付')}</a>}
            <button className={secondaryButton} disabled={busy} onClick={() => void continuePayment()}>{busy ? t('正在处理...') : t('继续支付')}</button>
          </>}
          {record.dealName && !done && <button className={secondaryButton} disabled={checking} onClick={() => void checkStatus()}>{checking ? t('正在查询...') : t('刷新升级结果')}</button>}
          {!record.dealName && <button className={secondaryButton} disabled={busy} onClick={() => void recoverOrder()}>{t('恢复已有订单')}</button>}
          {done && <button className={primaryButton} onClick={onClose}>{t('完成')}</button>}
        </>}
        {error && <p role="alert" className="text-pretty text-sm text-red-600">{error}</p>}
        {statusError && <p role="alert" className="text-pretty text-sm text-red-600">{statusError}</p>}
      </div>
    </DialogContent>
  </Dialog>;
}
