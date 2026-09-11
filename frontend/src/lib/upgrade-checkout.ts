import type { Pass, PassModifyOption, PassOrderStatus } from '@/domain/types';

export interface PaidUpgradeCheckout {
  dealName: string;
  targetBundleId: string;
}

export const UPGRADE_RETURN_QUERY = 'upgrade_return';
const RETURN_TTL_MS = 24 * 60 * 60 * 1000;
export const upgradeReturnKey = (userId: string, dealName: string) => `lightvela-upgrade-return-v1:${encodeURIComponent(userId)}:${encodeURIComponent(dealName)}`;
interface UpgradeReturn extends PaidUpgradeCheckout { passId: string }

/** Retain non-secret identifiers across the hosted payment window and its return page. */
export function saveUpgradeReturn(storage: Pick<Storage, 'setItem'>, userId: string, checkout: UpgradeReturn, now = Date.now()) {
  storage.setItem(upgradeReturnKey(userId, checkout.dealName), JSON.stringify({ passId: checkout.passId, targetBundleId: checkout.targetBundleId, dealName: checkout.dealName, createdAt: now }));
}

export function readUpgradeReturn(storage: Pick<Storage, 'getItem'>, userId: string, search: string, now = Date.now()): UpgradeReturn | null {
  try {
    const dealName = new URLSearchParams(search).get(UPGRADE_RETURN_QUERY);
    if (!userId || !dealName) return null;
    const raw: unknown = JSON.parse(storage.getItem(upgradeReturnKey(userId, dealName)) ?? 'null');
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as Record<string, unknown>;
    if (value.dealName !== dealName || typeof value.passId !== 'string' || !value.passId || typeof value.targetBundleId !== 'string' || !value.targetBundleId) return null;
    if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || value.createdAt > now || now - value.createdAt > RETURN_TTL_MS) return null;
    return { dealName, passId: value.passId, targetBundleId: value.targetBundleId };
  } catch { return null; }
}

export function isUpgradeDelivered(order: PassOrderStatus, pass: Pass | undefined, passId: string, targetBundleId: string) {
  return order.order_type === 'modify' && order.status === 'success' && order.local_status === 'provisioned'
    && pass?.pass_id === passId && pass.bundle_id === targetBundleId && pass.status === 'active';
}

export function validUpgradeQuote(option: PassModifyOption) {
  const price = option.modify_price;
  return !!price && Number.isFinite(price.real_total_cost) && price.real_total_cost >= 0
    && Number.isFinite(price.tax_price ?? 0) && (price.tax_price ?? 0) >= 0
    && (price.tax_price ?? 0) <= price.real_total_cost && /^(CNY|USD)$/.test(price.currency);
}

export interface UpgradeCheckoutRecord {
  targetBundleId: string;
  dealName?: string;
  phase: 'creating' | 'ordered';
}
type CheckoutStorage = Pick<Storage, 'getItem' | 'setItem'>;
export const upgradeCheckoutKey = (userId: string, passId: string) => `lightvela-upgrade-v1:${encodeURIComponent(userId)}:${encodeURIComponent(passId)}`;

export function readUpgradeCheckout(storage: Pick<Storage, 'getItem'>, userId: string, passId: string): UpgradeCheckoutRecord | null {
  try {
    const raw: unknown = JSON.parse(storage.getItem(upgradeCheckoutKey(userId, passId)) ?? 'null');
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.targetBundleId !== 'string' || !item.targetBundleId || !['creating', 'ordered'].includes(String(item.phase))) return null;
    if (item.phase === 'ordered' && (typeof item.dealName !== 'string' || !item.dealName)) return null;
    return { targetBundleId: item.targetBundleId, phase: item.phase as UpgradeCheckoutRecord['phase'], dealName: typeof item.dealName === 'string' ? item.dealName : undefined };
  } catch { return null; }
}

/** Only non-secret identifiers are persisted. Auth codes and pay URLs remain in memory. */
export function saveUpgradeCheckout(storage: CheckoutStorage, userId: string, passId: string, record: UpgradeCheckoutRecord) {
  storage.setItem(upgradeCheckoutKey(userId, passId), JSON.stringify({ targetBundleId: record.targetBundleId, phase: record.phase, ...(record.dealName ? { dealName: record.dealName } : {}) }));
}
