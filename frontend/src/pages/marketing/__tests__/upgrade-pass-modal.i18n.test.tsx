import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpgradePassModal } from '../upgrade-pass-modal';
import { LocaleOverrideProvider, type I18nLocale } from '@/i18n/t';
import { ensureLocaleDictionary } from '@/i18n';
import { RepositoryError } from '@/repositories/http-repositories';
import type { Pass, PassModifyOption } from '@/domain/types';

const { plans } = vi.hoisted(() => ({ plans: {
  listModifyBundles: vi.fn(), createModifyOrder: vi.fn(),
  getModifyOrderUrl: vi.fn(), getOrderStatus: vi.fn(),
} }));
vi.mock('@/contexts/repository-context', () => ({ useRepositories: () => ({ plans }) }));
vi.mock('@/contexts/session-context', () => ({ useSession: () => ({ session: { user: { id: 'u' } } }) }));
vi.mock('@/lib/region', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/region')>(), isGlobal: true,
}));

const pass: Pass = { pass_id: 'p', user_id: 'u', bundle_id: 'source', bundle_name: 'Launch', status: 'active', created_time: '', expired_time: '2099-01-01', credit_total: 100, credit_available: 100 };
const option: PassModifyOption = { target_bundle_id: 'target', bundle: { bundle_id: 'target', bundle_name: 'Cruise', cpu: 4, memory: 8, system_disk_size: 80, credit: 200 }, modify_price: { price: 167, real_total_cost: 167, total_cost: 167, tax_price: 0, currency: 'USD', discount: 1 } };

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  window.localStorage.clear();
  vi.spyOn(window, 'open').mockReturnValue({ closed: false, location: { href: '' }, close: vi.fn() } as unknown as Window);
  plans.listModifyBundles.mockResolvedValue({ source_bundle_id: 'source', modify_bundle_set: [option] });
  plans.createModifyOrder.mockResolvedValue({ deal_name: 'd', big_order_id: 'b' });
  plans.getModifyOrderUrl.mockResolvedValue({ deal_name: 'd', pay_url: 'https://pay.example/test', need_charge: 1 });
  plans.getOrderStatus.mockResolvedValue({ deal_name: 'd', order_type: 'modify', status: 'pending', local_status: 'pending', source: 'local' });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function mount(locale: I18nLocale = 'en-US') {
  await ensureLocaleDictionary(locale);
  await act(async () => { render(<LocaleOverrideProvider locale={locale}><UpgradePassModal pass={pass} targetBundleId="target" initialOption={option} onClose={vi.fn()} onPaid={vi.fn()} /></LocaleOverrideProvider>); });
}
async function pay() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /\$1\.67/ })); });
}

describe('upgrade checkout localized errors with real dictionaries', () => {
  it.each([
    ['en-US', 'Please sign in before continuing.'],
    ['es', 'Inicia sesión antes de continuar.'],
    ['id-ID', 'Silakan masuk sebelum melanjutkan.'],
    ['ja-JP', '続行する前にログインしてください。'],
    ['ko-KR', '계속하려면 먼저 로그인해 주세요.'],
    ['zh-Hant', '請先登錄後再操作。'],
  ] as const)('uses the route locale %s for a known billing error', async (locale, expected) => {
    plans.createModifyOrder.mockRejectedValue(new RepositoryError('服务端原文', 401, 'UNAUTHORIZED'));
    await mount(locale);
    await pay();
    expect(screen.getByRole('alert')).toHaveTextContent(expected);
  });
  it.each(['quote', 'create', 'payment', 'status'] as const)('localizes a known billing error during %s', async stage => {
    const request = { quote: plans.listModifyBundles, create: plans.createModifyOrder, payment: plans.getModifyOrderUrl, status: plans.getOrderStatus }[stage];
    request.mockRejectedValue(new RepositoryError('服务端原文', 401, 'UNAUTHORIZED'));
    await mount();
    await pay();
    expect(screen.getByRole('alert')).toHaveTextContent('Please sign in before continuing.');
    expect(screen.queryByText('服务端原文')).toBeNull();
  });

  it.each([
    new RepositoryError('服务端内部错误详情', 500, 'UNRECOGNIZED_CODE'),
    new Error('网络连接已中断'),
  ])('uses translated fallback for an unknown pay-time quote error: %s', async error => {
    plans.listModifyBundles.mockRejectedValue(error);
    await mount();
    await pay();
    expect(screen.getByRole('alert').textContent).not.toMatch(/[\u4e00-\u9fff]/);
    expect(screen.getByRole('alert')).not.toHaveTextContent(error.message);
    expect(plans.createModifyOrder).not.toHaveBeenCalled();
  });

  it('preserves a trusted, localized order mismatch warning', async () => {
    plans.getModifyOrderUrl.mockResolvedValue({ deal_name: 'wrong-order', pay_url: 'https://pay.example/test', need_charge: 1 });
    await mount(); await pay();
    expect(screen.getByRole('alert')).toHaveTextContent('The order details do not match. Please contact support.');
    expect(screen.getByRole('alert').textContent).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('retains Chinese copy for the Chinese locale', async () => {
    plans.listModifyBundles.mockRejectedValue(new RepositoryError('server text', 403, 'FORBIDDEN'));
    await mount('zh-CN');
    await pay();
    expect(screen.getByRole('alert')).toHaveTextContent('当前操作被拒绝，请刷新页面或联系客服。');
  });
});
