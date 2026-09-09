import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpgradePassModal } from '../upgrade-pass-modal';
import type { Pass, PassModifyOption } from '@/domain/types';

const { plans, region } = vi.hoisted(() => ({ plans: { getModifyCheckout: vi.fn(), listModifyBundles: vi.fn(), createModifyOrder: vi.fn(), getModifyOrderUrl: vi.fn(), getOrderStatus: vi.fn(), listMyPasses: vi.fn(), refreshModifyPaymentAuthorization: vi.fn() }, region: { global: true } }));
vi.mock('@/contexts/repository-context', () => ({ useRepositories: () => ({ plans }) }));
vi.mock('@/contexts/session-context', () => ({ useSession: () => ({ session: { user: { id: 'u' } } }) }));
vi.mock('@/lib/region', () => ({ get isGlobal() { return region.global; } }));
vi.mock('@/i18n/t', () => { const translate = (key: string) => key; return { useT: () => translate }; });
const pass: Pass = { pass_id: 'p', user_id: 'u', bundle_id: 'source', bundle_name: '启航', status: 'active', created_time: '', expired_time: '2099-01-01', credit_total: 100, credit_available: 100 };
const option: PassModifyOption = { target_bundle_id: 'target', bundle: { bundle_id: 'target', bundle_name: '巡游', cpu: 4, memory: 8, system_disk_size: 80, credit: 200 }, modify_price: { price: 167, real_total_cost: 167, total_cost: 167, tax_price: 0, currency: 'USD', discount: 1 } };
beforeEach(() => {
  vi.clearAllMocks(); region.global = true;
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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount(onSuccess = vi.fn()) { render(<UpgradePassModal pass={pass} targetBundleId="target" onClose={vi.fn()} onSuccess={onSuccess} />); return onSuccess; }
describe('upgrade checkout modal', () => {
  it('clears only a server-confirmed cancelled checkout so the user can quote again', async () => {
    window.localStorage.setItem('lightvela-upgrade-v1:u:p', JSON.stringify({ targetBundleId: 'target', phase: 'ordered', dealName: 'd' }));
    plans.getOrderStatus.mockResolvedValue({ deal_name: 'd', order_type: 'modify', status: 'cancelled', local_status: 'cancelled', source: 'local' });
    mount();
    await screen.findByText('USD 1.67');
    expect(window.localStorage.getItem('lightvela-upgrade-v1:u:p')).toBeNull();
    expect(plans.createModifyOrder).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '确认升级并支付' })).toBeTruthy();
  });
  it('fails closed when the live quote cannot be loaded', async () => {
    plans.listModifyBundles.mockRejectedValue(new Error('quote unavailable'));
    mount();
    await screen.findByRole('alert');
    expect((screen.getByRole('button', { name: '确认升级并支付' }) as HTMLButtonElement).disabled).toBe(true);
    expect(plans.createModifyOrder).not.toHaveBeenCalled();
  });
  it('retries payment URL for the same order, never places a second order', async () => {
    plans.getModifyOrderUrl.mockRejectedValueOnce(new Error('url unavailable'));
    mount();
    await screen.findByText('USD 1.67');
    fireEvent.click(screen.getByRole('button', { name: '确认升级并支付' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: '刷新升级结果' }));
    await waitFor(() => expect(plans.getOrderStatus.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新升级结果' })).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('url unavailable');
    fireEvent.click(screen.getByRole('button', { name: '继续支付' }));
    await waitFor(() => expect(plans.getModifyOrderUrl).toHaveBeenCalledTimes(2));
    expect(plans.createModifyOrder).toHaveBeenCalledTimes(1);
    expect(plans.getModifyOrderUrl.mock.calls[1]?.[1].deal_names).toEqual(['d']);
  });
  it('does not call success for payment alone; waits for the active target and local delivery', async () => {
    plans.getModifyOrderUrl.mockResolvedValue({ deal_name: 'd', pay_url: '', need_charge: 0 });
    plans.getOrderStatus.mockResolvedValue({ deal_name: 'd', order_type: 'modify', local_status: 'paid_pending_provision', status: 'paid', source: 'local' });
    const success = mount();
    await screen.findByText('USD 1.67');
    fireEvent.click(screen.getByRole('button', { name: '确认升级并支付' }));
    await screen.findByText('已支付，套餐升级中');
    expect(success).not.toHaveBeenCalled();
    plans.getOrderStatus.mockResolvedValue({ deal_name: 'd', order_type: 'modify', local_status: 'provisioned', status: 'success', source: 'local' });
    plans.listMyPasses.mockResolvedValue([{ ...pass, bundle_id: 'target' }]);
    fireEvent.click(screen.getByRole('button', { name: '刷新升级结果' }));
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
  });
  it('requires confirmation again if the fresh quote changes', async () => {
    mount(); await screen.findByText('USD 1.67');
    plans.listModifyBundles.mockResolvedValue({ source_bundle_id: 'source', modify_bundle_set: [{ ...option, modify_price: { ...option.modify_price, real_total_cost: 200 } }] });
    fireEvent.click(screen.getByRole('button', { name: '确认升级并支付' }));
    await screen.findByText('USD 2.00');
    expect(plans.createModifyOrder).not.toHaveBeenCalled();
  });
  it('clears the local creating marker for an explicit pre-order rejection', async () => {
    plans.createModifyOrder.mockRejectedValue(Object.assign(new Error('not active'), { status: 400, code: 'PASS_NOT_ACTIVE' }));
    mount(); await screen.findByText('USD 1.67');
    fireEvent.click(screen.getByRole('button', { name: '确认升级并支付' }));
    await screen.findByRole('alert');
    expect(window.localStorage.getItem('lightvela-upgrade-v1:u:p')).toBeNull();
    expect(screen.getByRole('button', { name: '确认升级并支付' })).toBeTruthy();
  });
  it('does not create a second order while another tab holds the checkout lock', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_key: string, _options: unknown, callback: (lock: null) => Promise<void>) => callback(null) } });
    mount(); await screen.findByText('USD 1.67');
    fireEvent.click(screen.getByRole('button', { name: '确认升级并支付' }));
    await screen.findByRole('alert');
    expect(plans.createModifyOrder).not.toHaveBeenCalled();
  });
  it('restores a server order on another device without placing a new one', async () => {
    plans.getModifyCheckout.mockResolvedValue({ checkout: { deal_name: 'd', big_order_id: 'b', target_bundle_id: 'target', local_status: 'pending_pay' } });
    mount();
    await screen.findByText('等待支付');
    expect(plans.createModifyOrder).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '继续支付' }));
    await waitFor(() => expect(plans.getModifyOrderUrl).toHaveBeenCalledWith('p', expect.objectContaining({ deal_names: ['d'] })));
  });
  it('keeps an unknown creation locked when no durable server order can be found', async () => {
    window.localStorage.setItem('lightvela-upgrade-v1:u:p', JSON.stringify({ targetBundleId: 'target', phase: 'creating' }));
    mount();
    await screen.findByText('下单结果待确认，请勿重复下单，请联系支持核对。');
    fireEvent.click(screen.getByRole('button', { name: '恢复已有订单' }));
    await screen.findByRole('alert');
    expect(plans.createModifyOrder).not.toHaveBeenCalled();
  });
});
