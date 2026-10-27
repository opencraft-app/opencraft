import { MAX_HOPS, validHubId, type HubRoute } from './contract.js';
import { validService, type Invitation, type Peer } from './store.js';

/** Snapshot advertisements are scoped to one authenticated connection generation. */
export class HubRouting {
  readonly entries = new Map<string, { epoch: number; routes: HubRoute[] }>();
  constructor(readonly id: string) {}
  receive(peerId: string, epoch: number, input: unknown, policy: Pick<Invitation | Peer, 'allowTransit' | 'origins'>) {
    if (!Number.isSafeInteger(epoch) || epoch < 1 || epoch <= (this.entries.get(peerId)?.epoch ?? 0) || !Array.isArray(input) || input.length > 256) throw new Error('Invalid route generation');
    const routes: HubRoute[] = [];
    for (const candidate of input) {
      const service = validService(candidate?.service), path = candidate.path;
      if (!Array.isArray(path) || path.length < 1 || path.length >= MAX_HOPS || path[0] !== peerId || path.at(-1) !== service.hubId
        || path.some(p => !validHubId(p)) || new Set(path).size !== path.length || path.includes(this.id)) continue;
      if ((!policy.allowTransit && service.hubId !== peerId) || !policy.origins.includes(service.origin)) continue;
      if (!routes.some(r => r.service.hubId === service.hubId)) routes.push({ service, path: [...path] });
    }
    this.entries.set(peerId, { epoch, routes });
  }
  remove(peerId: string) { this.entries.delete(peerId); }
  all(): HubRoute[] {
    const result = new Map<string, HubRoute>();
    for (const entry of this.entries.values()) for (const route of entry.routes) {
      const prior = result.get(route.service.hubId);
      if (!prior || route.path.length < prior.path.length || (route.path.length === prior.path.length && route.path.join() < prior.path.join())) result.set(route.service.hubId, route);
    }
    // A conflicting public origin never chooses an arbitrary resource authority.
    const origins = new Map<string, number>(); for (const route of result.values()) { const host = new URL(route.service.origin).host; origins.set(host, (origins.get(host) ?? 0) + 1); }
    return [...result.values()].filter(r => origins.get(new URL(r.service.origin).host) === 1);
  }
  find(target: string, visited: readonly string[] = []): HubRoute | null { return this.all().find(r => r.service.hubId === target && !r.path.some(id => visited.includes(id))) ?? null; }
}
