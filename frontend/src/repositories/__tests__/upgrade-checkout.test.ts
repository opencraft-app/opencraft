import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpRepositories } from '@/repositories/http-repositories';

afterEach(() => vi.unstubAllGlobals());
describe('upgrade checkout API contract', () => {
  it('lists authoritative targets and creates only in the order call', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'SUCCESS', data: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const plans = createHttpRepositories('https://test.example').plans;
    await plans.listModifyBundles('pass/1');
    expect(fetch.mock.calls[0]?.[0]).toBe('https://test.example/v1/passes/pass%2F1/modify/bundles');
    fetch.mockResolvedValue(new Response(JSON.stringify({ code: 'SUCCESS', data: { deal_name: 'deal-1' } }), { status: 200 }));
    await plans.createModifyOrder('pass/1', { target_bundle_id: 'target' });
    expect(JSON.parse(fetch.mock.calls[1]?.[1].body)).toEqual({ target_bundle_id: 'target' });
    fetch.mockResolvedValue(new Response(JSON.stringify({ code: 'SUCCESS', data: {} }), { status: 200 }));
    await plans.getModifyOrderUrl('pass/1', { deal_names: ['deal-1'], platform: 'pc' });
    expect(JSON.parse(fetch.mock.calls[2]?.[1].body)).toEqual({ deal_names: ['deal-1'], platform: 'pc' });
    expect(fetch.mock.calls[2]?.[0]).toBe('https://test.example/v1/passes/pass%2F1/modify/order-url');
  });
  it('queries the owned order status without a mutation', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'SUCCESS', data: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await createHttpRepositories('https://test.example').plans.getOrderStatus('deal/1');
    expect(fetch.mock.calls[0]?.[0]).toBe('https://test.example/v1/orders/deal%2F1/status');
    expect(fetch.mock.calls[0]?.[1].method).toBe('GET');
  });
});
