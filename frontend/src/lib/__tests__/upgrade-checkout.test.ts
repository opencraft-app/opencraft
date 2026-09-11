import { describe, expect, it } from 'vitest';
import { isUpgradeDelivered, validUpgradeQuote, readUpgradeCheckout, saveUpgradeCheckout, saveUpgradeReturn, readUpgradeReturn } from '@/lib/upgrade-checkout';
import type { Pass, PassOrderStatus, PassModifyOption } from '@/domain/types';

const pass: Pass = { pass_id: 'p', user_id: 'u', bundle_id: 'target', bundle_name: 'target', status: 'active', created_time: '', expired_time: '2099-01-01', credit_total: 200, credit_available: 200 };
const status: PassOrderStatus = { deal_name: 'd', order_type: 'modify', status: 'success', local_status: 'provisioned', source: 'local' };
describe('upgrade delivery and recovery', () => {
  it('scopes card return recovery to the same user and order for at most 24 hours', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
    saveUpgradeReturn(storage, 'u', { passId: 'p', targetBundleId: 'target', dealName: 'd' }, 1000);
    expect(readUpgradeReturn(storage, 'u', '?upgrade_return=d', 1001)?.passId).toBe('p');
    expect(readUpgradeReturn(storage, 'other', '?upgrade_return=d', 1001)).toBeNull();
    expect(readUpgradeReturn(storage, 'u', '?upgrade_return=other', 1001)).toBeNull();
    expect(readUpgradeReturn(storage, 'u', '?upgrade_return=d', 86_401_001)).toBeNull();
    expect(readUpgradeReturn(storage, 'u', '?upgrade_return=d', 0)).toBeNull();
    expect([...values.values()].join()).not.toMatch(/auth_code|pay_url/);
  });
  it('requires local delivery AND the exact active target Pass', () => {
    expect(isUpgradeDelivered(status, pass, 'p', 'target')).toBe(true);
    expect(isUpgradeDelivered({ ...status, local_status: 'paid_pending_provision' }, pass, 'p', 'target')).toBe(false);
    expect(isUpgradeDelivered(status, { ...pass, status: 'modifying' }, 'p', 'target')).toBe(false);
    expect(isUpgradeDelivered(status, pass, 'other', 'target')).toBe(false);
    expect(isUpgradeDelivered(status, pass, 'p', 'other')).toBe(false);
    expect(isUpgradeDelivered({ ...status, order_type: 'renew' }, pass, 'p', 'target')).toBe(false);
  });
  it('rejects missing, negative, and nonfinite quote values', () => {
    const option = { target_bundle_id: 't', modify_price: { real_total_cost: 10, tax_price: 0, currency: 'CNY' } } as PassModifyOption;
    expect(validUpgradeQuote(option)).toBe(true);
    expect(validUpgradeQuote({ ...option, modify_price: { ...option.modify_price, real_total_cost: NaN } })).toBe(false);
    expect(validUpgradeQuote({ ...option, modify_price: { ...option.modify_price, real_total_cost: -1 } })).toBe(false);
  });
  it('restores identifiers per user/pass without payment secrets', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
    saveUpgradeCheckout(storage, 'u', 'p', { targetBundleId: 't', dealName: 'd', phase: 'ordered' });
    expect(readUpgradeCheckout(storage, 'u', 'p')?.dealName).toBe('d');
    expect(readUpgradeCheckout(storage, 'another-user', 'p')).toBeNull();
    expect([...values.values()].join()).not.toContain('auth_code');
  });
});
