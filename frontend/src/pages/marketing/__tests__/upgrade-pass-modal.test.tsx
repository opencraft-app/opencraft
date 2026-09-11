import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpgradePassModal } from '../upgrade-pass-modal';
import type { Pass, PassModifyOption } from '@/domain/types';
import userEvent from '@testing-library/user-event';

const { plans, region, session, assignLocation } = vi.hoisted(() => ({ plans: { getModifyCheckout: vi.fn(), listModifyBundles: vi.fn(), createModifyOrder: vi.fn(), getModifyOrderUrl: vi.fn(), getOrderStatus: vi.fn(), listMyPasses: vi.fn(), refreshModifyPaymentAuthorization: vi.fn() }, region: { global: true }, session: { user: { id: 'u' } as { id: string } | null }, assignLocation: vi.fn() }));
vi.mock('@/contexts/repository-context', () => ({ useRepositories: () => ({ plans }) }));
vi.mock('@/contexts/session-context', () => ({ useSession: () => ({ session }) }));
vi.mock('@/lib/region', () => ({ get isGlobal() { return region.global; } }));
vi.mock('@/i18n/t', () => { const translate = (key: string, options?: Record<string, unknown>) => Object.entries(options ?? {}).reduce((text, [name, value]) => text.replace(`{{${name}}}`, String(value)), key); return { useT: () => translate }; });
const pass: Pass = { pass_id: 'p', user_id: 'u', bundle_id: 'source', bundle_name: '启航', status: 'active', created_time: '', expired_time: '2099-01-01', credit_total: 100, credit_available: 100 };
const option: PassModifyOption = { target_bundle_id: 'target', bundle: { bundle_id: 'target', bundle_name: '巡游', cpu: 4, memory: 8, system_disk_size: 80, credit: 200 }, modify_price: { price: 167, real_total_cost: 167, total_cost: 167, tax_price: 0, currency: 'USD', discount: 1 } };
beforeEach(() => {
  vi.clearAllMocks(); region.global = true;
  session.user = { id: 'u' };
  vi.spyOn(window, 'open').mockReturnValue(null);
  vi.stubGlobal('location', { origin: 'http://localhost:3000', hostname: 'localhost', pathname: '/en/subscribe/', href: 'http://localhost:3000/en/subscribe/?code=private#ticket', assign: assignLocation });
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_key: string, _options: unknown, callback: (lock: object) => Promise<void>) => callback({}) } });
  plans.listModifyBundles.mockResolvedValue({ source_bundle_id: 'source', modify_bundle_set: [option] });
  plans.createModifyOrder.mockResolvedValue({ deal_name: 'd', big_order_id: 'b', auth_code: 'test-only' });
  plans.getModifyOrderUrl.mockResolvedValue({ deal_name: 'd', pay_url: 'https://pay.example/test', need_charge: 1 });
  plans.getOrderStatus.mockResolvedValue({ deal_name: 'd', order_type: 'modify', local_status: 'pending', status: 'pending', source: 'local' });
  plans.listMyPasses.mockResolvedValue([pass]);
  plans.getModifyCheckout.mockResolvedValue({ checkout: null });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function mount(onPaid = vi.fn()) { render(<UpgradePassModal pass={pass} targetBundleId="target" onClose={vi.fn()} onPaid={onPaid} />); return onPaid; }
describe('upgrade checkout modal', () => {
  it.each([false, true])('renders the button quote on production without console opt-in or another initial request (global=%s)', async (global) => {
    region.global = global;
    vi.stubGlobal('location', { ...location, hostname: global ? 'lightvela.ai' : 'lightvela.com' });
    render(<UpgradePassModal pass={pass} targetBundleId="target" initialOption={option} onClose={vi.fn()} onPaid={vi.fn()} />);
    expect(screen.getByText('$1.67')).toBeTruthy();
    expect(screen.getByText('巡游')).toBeTruthy();
    expect(screen.queryByText('正在查询升级差价...')).toBeNull();
    expect(plans.listModifyBundles).not.toHaveBeenCalled();
    plans.listModifyBundles.mockResolvedValue({ source_bundle_id: 'source', modify_bundle_set: [{ ...option, modify_price: { ...option.modify_price, real_total_cost: 234 } }] });
    fireEvent.click(screen.getByRole('button', { name: '支付 $1.67' }));
    await screen.findByText('$2.34');
    expect(plans.listModifyBundles).toHaveBeenCalledTimes(1);
    expect(plans.createModifyOrder).not.toHaveBeenCalled();
    expect(screen.getByText('差价已更新，请确认最新金额后再次提交。')).toBeTruthy();
  });
  it('does not render checkout or query pricing when signed out', () => {
    session.user = null;
    mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(plans.listModifyBundles).not.toHaveBeenCalled();
    expect(plans.createModifyOrder).not.toHaveBeenCalled();
  });
  it.each([false, true])('matches new-purchase corner radii in both checkout steps (global=%s)', async (global) => {
    region.global = global;
    mount();
    await screen.findByText('$1.67');
    expect(screen.getByRole('dialog').classList.contains('rounded-[16px]')).toBe(true);
    expect(screen.getByRole('region', { name: '订单详情' }).classList.contains('rounded-[12px]')).toBe(true);
    expect(screen.getByText(global ? '卡支付' : '微信支付').classList.contains('rounded-[12px]')).toBe(true);
    expect(screen.getByRole('button', { name: '取消' }).classList.contains('rounded-[8px]')).toBe(true);
    const payButton = screen.getByRole('button', { name: '支付 $1.67' });
    expect(payButton.classList.contains('rounded-[8px]')).toBe(true);
    fireEvent.click(payButton);
    await screen.findByRole('heading', { name: '请完成支付' });
    const paymentPanel = global
      ? (await screen.findByText('卡支付')).closest('[role="status"]')
      : (await screen.findByLabelText('微信扫码支付')).parentElement;
    expect(paymentPanel?.classList.contains('rounded-[12px]')).toBe(true);
    expect(screen.getByRole('dialog').classList.contains('rounded-[16px]')).toBe(true);
    const paymentAction = global
      ? await screen.findByRole('link', { name: '前往支付' })
      : screen.getByRole('button', { name: '刷新' });
    expect(paymentAction.classList.contains('rounded-[8px]')).toBe(true);
  });
  it('shows only the target details and price before a dedicated QR payment screen', async () => {
    region.global = false;
    mount();
    await screen.findByText('$1.67');
    expect(screen.getByText('微信支付')).toBeTruthy();
    expect(screen.getByText('巡游')).toBeTruthy();
    expect(screen.queryByText('当前套餐')).toBeNull();
    expect(screen.queryByText('启航')).toBeNull();
    expect(document.querySelector('[aria-current="step"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '支付 $1.67' }));
    await screen.findByLabelText('微信扫码支付');
    expect(screen.getByRole('heading', { name: '请完成支付' })).toBeTruthy();
    expect(screen.queryByText('巡游')).toBeNull();
    expect(screen.queryByText('$1.67')).toBeNull();
    expect(screen.queryByText(/订单号/)).toBeNull();
  });
  it('refreshes the QR on demand using the existing order', async () => {
    region.global = false;
    plans.refreshModifyPaymentAuthorization.mockResolvedValue({ auth_code: 'refreshed-ticket' });
    mount();
    await screen.findByText('$1.67');
    fireEvent.click(screen.getByRole('button', { name: '支付 $1.67' }));
    await screen.findByLabelText('微信扫码支付');
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(plans.refreshModifyPaymentAuthorization).toHaveBeenCalledWith('p', { deal_names: ['d'] }));
    expect(plans.createModifyOrder).toHaveBeenCalledTimes(1);
  });
  it('opens international checkout from the confirmation gesture and retains a fallback link', async () => {
    const payWindow = { closed: false, opener: window, location: { href: 'about:blank' }, close: vi.fn() };
    vi.mocked(window.open).mockReturnValue(payWindow as unknown as Window);
    mount();
    await screen.findByText('$1.67');
    expect(screen.getByText('卡支付')).toBeTruthy();
    expect(screen.getByText('巡游')).toBeTruthy();
    expect(screen.getByText('应补差价')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '支付 $1.67' }));
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank');
    await screen.findByRole('link', { name: '重新打开支付页' });
    expect(payWindow.location.href).toBe('https://pay.example/test');
    expect(payWindow.opener).toBeNull();
    expect(plans.getModifyOrderUrl).toHaveBeenCalledWith('p', expect.objectContaining({ return_url: 'http://localhost:3000/agents/?upgrade_return=d', cancel_url: 'http://localhost:3000/en/subscribe/' }));
    expect(assignLocation).not.toHaveBeenCalled();
    expect(screen.queryByText('$1.67')).toBeNull();
  });
  it('navigates the current page when a popup is blocked, matching new purchase', async () => {
    mount();
    await screen.findByText('$1.67');
    fireEvent.click(screen.getByRole('button', { name: '支付 $1.67' }));
    const link = await screen.findByRole('link', { name: '前往支付' });
    expect(link.getAttribute('href')).toBe('https://pay.example/test');
    expect(assignLocation).toHaveBeenCalledWith('https://pay.example/test');
    expect(screen.queryByText('信用卡支付页已在新窗口打开，完成支付后本页将自动跳转')).toBeNull();
  });
  it('closes an unused payment tab after a price change without placing an order', async () => {
    const payWindow = { closed: false, opener: window, location: { href: 'about:blank' }, close: vi.fn() };
    vi.mocked(window.open).mockReturnValue(payWindow as unknown as Window);
    mount();
    await screen.findByText('$1.67');
    plans.listModifyBundles.mockResolvedValue({ source_bundle_id: 'source', modify_bundle_set: [{ ...option, modify_price: { ...option.modify_price, real_total_cost: 200 } }] });
    fireEvent.click(screen.getByRole('button', { name: '支付 $1.67' }));
    await screen.findByText('差价已更新，请确认最新金额后再次提交。');
    expect(payWindow.close).toHaveBeenCalledTimes(1);
    expect(plans.createModifyOrder).not.toHaveBeenCalled();
  });
  it('supports keyboard dismissal and does not close on an outside click', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<UpgradePassModal pass={pass} targetBundleId="target" onClose={onClose} onPaid={vi.fn()} />);
    await screen.findByText('$1.67');
    await user.keyboard('{Tab}');
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    const overlay = document.querySelector('[data-state="open"][aria-hidden="true"]');
    if (!overlay) throw new Error('Missing dialog overlay');
    await user.click(overlay);
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('opens a fresh confirmation after closing and creates a new order only on another explicit click', async () => {
    region.global = false;
    mount();
    await screen.findByText('$1.67');
    expect(plans.createModifyOrder).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '支付 $1.67' }));
    await screen.findByLabelText('微信扫码支付');
    expect(plans.createModifyOrder).toHaveBeenCalledTimes(1);
    cleanup();
    mount();
    await screen.findByText('$1.67');
    expect(screen.queryByLabelText('微信扫码支付')).toBeNull();
    expect(plans.createModifyOrder).toHaveBeenCalledTimes(1);
    plans.createModifyOrder.mockResolvedValue({ deal_name: 'd2', big_order_id: 'b2', auth_code: 'test-only-2' });
    fireEvent.click(screen.getByRole('button', { name: '支付 $1.67' }));
    await screen.findByLabelText('微信扫码支付');
    expect(plans.createModifyOrder).toHaveBeenCalledTimes(2);
    expect(plans.getModifyCheckout).not.toHaveBeenCalled();
  });
  it.each([false, true])('keeps creation loading on the pay button until payment is ready (global=%s)', async (global) => {
    region.global = global;
    let resolveOrder!: (value: unknown) => void;
    let resolvePayment!: (value: unknown) => void;
    plans.createModifyOrder.mockReturnValue(new Promise(resolve => { resolveOrder = resolve; }));
    const paymentRequest = global ? plans.getModifyOrderUrl : plans.refreshModifyPaymentAuthorization;
    paymentRequest.mockReturnValueOnce(new Promise(resolve => { resolvePayment = resolve; }));
    mount();
    await screen.findByText('$1.67');
    const button = screen.getByRole('button', { name: '支付 $1.67' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(plans.createModifyOrder).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('heading', { name: '确认订单' })).toBeTruthy();
    expect(screen.getByText('巡游')).toBeTruthy();
    expect(screen.getByText('$1.67')).toBeTruthy();
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.textContent).toBe('正在处理...');
    expect(button.querySelector('.animate-spin')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '请完成支付' })).toBeNull();
    expect(screen.queryByText('暂时无法确认订单状态，请稍后查询，避免重复付款。')).toBeNull();
    await act(async () => resolveOrder({ deal_name: 'd', big_order_id: 'b' }));
    await waitFor(() => expect(paymentRequest).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('heading', { name: '确认订单' })).toBeTruthy();
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByLabelText('微信扫码支付')).toBeNull();
    await act(async () => resolvePayment(global ? { deal_name: 'd', pay_url: 'https://pay.example/test', need_charge: 1 } : { auth_code: 'test-only' }));
    expect(await screen.findByRole('heading', { name: '请完成支付' })).toBeTruthy();
    if (global) expect(await screen.findByRole('link', { name: '前往支付' })).toBeTruthy();
    else expect(await screen.findByLabelText('微信扫码支付')).toBeTruthy();
    expect(screen.queryByText('巡游')).toBeNull();
    expect(plans.createModifyOrder).toHaveBeenCalledTimes(1);
  });
  it('ignores a historical order and asks for a new confirmation', async () => {
    window.localStorage.setItem('lightvela-upgrade-v1:u:p', JSON.stringify({ targetBundleId: 'target', phase: 'ordered', dealName: 'd' }));
    plans.getOrderStatus.mockResolvedValue({ deal_name: 'd', order_type: 'modify', status: 'cancelled', local_status: 'cancelled', source: 'local' });
    mount();
    await screen.findByText('$1.67');
    expect(plans.getOrderStatus).not.toHaveBeenCalled();
    expect(plans.getModifyCheckout).not.toHaveBeenCalled();
    expect(plans.createModifyOrder).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '支付 $1.67' })).toBeTruthy();
  });
  it('fails closed when the live quote cannot be loaded', async () => {
    plans.listModifyBundles.mockRejectedValue(new Error('quote unavailable'));
    mount();
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: /^支付/ })).toBeNull();
    expect(screen.getByRole('button', { name: '重新询价' })).toBeTruthy();
    expect(plans.createModifyOrder).not.toHaveBeenCalled();
  });
  it('retries payment URL for the same order, never places a second order', async () => {
    plans.getModifyOrderUrl.mockRejectedValueOnce(new Error('url unavailable'));
    mount();
    await screen.findByText('$1.67');
    fireEvent.click(screen.getByRole('button', { name: '支付 $1.67' }));
    await screen.findByRole('alert');
    await waitFor(() => expect(plans.getModifyOrderUrl).toHaveBeenCalledTimes(2), { timeout: 4500 });
    expect(screen.queryByRole('button', { name: '继续支付' })).toBeNull();
    expect(screen.queryByRole('button', { name: '刷新升级结果' })).toBeNull();
    expect(plans.createModifyOrder).toHaveBeenCalledTimes(1);
    expect(plans.getModifyOrderUrl.mock.calls[1]?.[1].deal_names).toEqual(['d']);
  });
  it('hands off immediately after payment without waiting for pass delivery', async () => {
    region.global = false;
    plans.getOrderStatus.mockResolvedValue({ deal_name: 'd', order_type: 'modify', local_status: 'paid_pending_provision', status: 'paid', source: 'local' });
    plans.listMyPasses.mockRejectedValue(new Error('passes not ready'));
    const onPaid = mount();
    await screen.findByText('$1.67');
    fireEvent.click(screen.getByRole('button', { name: '支付 $1.67' }));
    await waitFor(() => expect(onPaid).toHaveBeenCalledWith({ dealName: 'd', targetBundleId: 'target' }));
    expect(onPaid).toHaveBeenCalledTimes(1);
    expect(plans.listMyPasses).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('微信扫码支付')).toBeNull();
  });
  it('hands off card payment immediately to the Agent upgrade flow', async () => {
    const onPaid = mount();
    await screen.findByText('$1.67');
    fireEvent.click(screen.getByRole('button', { name: '支付 $1.67' }));
    await screen.findByRole('link', { name: '前往支付' });
    plans.getOrderStatus.mockResolvedValue({ deal_name: 'd', order_type: 'modify', status: 'paid', local_status: 'paid_pending_provision', source: 'local' });
    await waitFor(() => expect(onPaid).toHaveBeenCalledWith({ dealName: 'd', targetBundleId: 'target' }), { timeout: 4500 });
    expect(plans.listMyPasses).not.toHaveBeenCalled();
  });
  it('hands off zero-charge checkout and closes the unused payment tab', async () => {
    const payWindow = { closed: false, opener: window, location: { href: 'about:blank' }, close: vi.fn() };
    vi.mocked(window.open).mockReturnValue(payWindow as unknown as Window);
    plans.getModifyOrderUrl.mockResolvedValue({ deal_name: 'd', pay_url: '', need_charge: 0 });
    const onPaid = mount();
    await screen.findByText('$1.67');
    fireEvent.click(screen.getByRole('button', { name: '支付 $1.67' }));
    await waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1));
    expect(payWindow.close).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('link', { name: '前往支付' })).toBeNull();
  });

  it('uses the paid response from manual refresh without a second status request', async () => {
    region.global = false;
    const onPaid = mount();
    await screen.findByText('$1.67');
    fireEvent.click(screen.getByRole('button', { name: '支付 $1.67' }));
    await screen.findByLabelText('微信扫码支付');
    await waitFor(() => expect(plans.getOrderStatus).toHaveBeenCalled());
    plans.getOrderStatus.mockResolvedValueOnce({ deal_name: 'd', order_type: 'modify', status: 'paid', source: 'local' }).mockRejectedValue(new Error('offline'));
    const reads = plans.getOrderStatus.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1));
    expect(plans.getOrderStatus).toHaveBeenCalledTimes(reads + 1);
  });

  it('does not clear another tab submission when this order completes', async () => {
    region.global = false;
    const success = mount();
    await screen.findByText('$1.67');
    fireEvent.click(screen.getByRole('button', { name: '支付 $1.67' }));
    await screen.findByLabelText('微信扫码支付');
    const newer = JSON.stringify({ targetBundleId: 'target', phase: 'creating' });
    window.localStorage.setItem('lightvela-upgrade-v1:u:p', newer);
    plans.getOrderStatus.mockResolvedValue({ deal_name: 'd', order_type: 'modify', local_status: 'provisioned', status: 'success', source: 'local' });
    plans.listMyPasses.mockResolvedValue([{ ...pass, bundle_id: 'target' }]);
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1), { timeout: 4500 });
    expect(window.localStorage.getItem('lightvela-upgrade-v1:u:p')).toBe(newer);
  });
  it('requires confirmation again if the fresh quote changes', async () => {
    mount(); await screen.findByText('$1.67');
    plans.listModifyBundles.mockResolvedValue({ source_bundle_id: 'source', modify_bundle_set: [{ ...option, modify_price: { ...option.modify_price, real_total_cost: 200 } }] });
    fireEvent.click(screen.getByRole('button', { name: '支付 $1.67' }));
    await screen.findByText('$2.00');
    expect(plans.createModifyOrder).not.toHaveBeenCalled();
  });
  it('clears the local creating marker for an explicit pre-order rejection', async () => {
    plans.createModifyOrder.mockRejectedValue(Object.assign(new Error('not active'), { status: 400, code: 'PASS_NOT_ACTIVE' }));
    mount(); await screen.findByText('$1.67');
    fireEvent.click(screen.getByRole('button', { name: '支付 $1.67' }));
    await screen.findByRole('alert');
    expect(window.localStorage.getItem('lightvela-upgrade-v1:u:p')).toBeNull();
    expect(screen.getByRole('button', { name: '重新询价' })).toBeTruthy();
  });
  it('does not create a second order while another tab holds the checkout lock', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_key: string, _options: unknown, callback: (lock: null) => Promise<void>) => callback(null) } });
    mount(); await screen.findByText('$1.67');
    fireEvent.click(screen.getByRole('button', { name: '支付 $1.67' }));
    await screen.findByRole('alert');
    expect(plans.createModifyOrder).not.toHaveBeenCalled();
  });
  it('requires price confirmation before submitting an existing checkout to the server', async () => {
    plans.getModifyCheckout.mockResolvedValue({ checkout: { deal_name: 'd', big_order_id: 'b', target_bundle_id: 'target', local_status: 'pending_pay' } });
    mount();
    await screen.findByText('$1.67');
    expect(plans.getModifyOrderUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '支付 $1.67' }));
    await screen.findByRole('heading', { name: '请完成支付' });
    expect(plans.createModifyOrder).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(plans.getModifyOrderUrl).toHaveBeenCalledWith('p', expect.objectContaining({ deal_names: ['d'] })));
  });
  it('shows the domestic QR only after confirmation without extra payment controls', async () => {
    region.global = false;
    plans.refreshModifyPaymentAuthorization.mockResolvedValue({ auth_code: 'test-only' });
    plans.getModifyCheckout.mockResolvedValue({ checkout: { deal_name: 'd', target_bundle_id: 'target', local_status: 'pending_pay' } });
    mount();
    await screen.findByText('$1.67');
    expect(screen.queryByLabelText('微信扫码支付')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '支付 $1.67' }));
    await screen.findByLabelText('微信扫码支付');
    expect(screen.queryByRole('link', { name: '已在微信中？点击支付' })).toBeNull();
    expect(screen.queryByRole('button', { name: '继续支付' })).toBeNull();
    expect(screen.queryByRole('button', { name: '刷新升级结果' })).toBeNull();
    expect(plans.createModifyOrder).toHaveBeenCalledTimes(1);
  });
  it('refreshes an expired QR for the same order and keeps polling beyond ten minutes until delivery', async () => {
    vi.useFakeTimers(); region.global = false;
    plans.refreshModifyPaymentAuthorization.mockResolvedValue({ auth_code: 'test-only' });
    plans.getModifyCheckout.mockResolvedValue({ checkout: { deal_name: 'd', target_bundle_id: 'target', local_status: 'pending_pay' } });
    const success = vi.fn();
    await act(async () => { mount(success); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '支付 $1.67' })); });
    expect(screen.getByLabelText('微信扫码支付')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(11 * 60 * 1000); });
    expect(plans.refreshModifyPaymentAuthorization).toHaveBeenCalledTimes(1);
    expect(plans.createModifyOrder).toHaveBeenCalledTimes(1);
    plans.getOrderStatus.mockResolvedValue({ deal_name: 'd', order_type: 'modify', local_status: 'provisioned', status: 'success', source: 'local' });
    plans.listMyPasses.mockResolvedValue([{ ...pass, bundle_id: 'target' }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(success).toHaveBeenCalledTimes(1);
    const calls = plans.getOrderStatus.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(plans.getOrderStatus).toHaveBeenCalledTimes(calls);
  });
  it('stops polling when the modal is unmounted', async () => {
    vi.useFakeTimers();
    plans.getModifyCheckout.mockResolvedValue({ checkout: { deal_name: 'd', target_bundle_id: 'target', local_status: 'pending_pay' } });
    await act(async () => { mount(); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '支付 $1.67' })); });
    cleanup();
    const calls = plans.getOrderStatus.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(plans.getOrderStatus).toHaveBeenCalledTimes(calls);
  });
  it('keeps an unknown creation locked when no durable server order can be found', async () => {
    window.localStorage.setItem('lightvela-upgrade-v1:u:p', JSON.stringify({ targetBundleId: 'target', phase: 'creating' }));
    mount();
    await screen.findByText('暂时无法确认订单状态，请稍后查询，避免重复付款。');
    expect(screen.queryByRole('button', { name: '查询订单状态' })).toBeNull();
    expect(plans.createModifyOrder).not.toHaveBeenCalled();
  });
});
