import { request as httpRequest } from 'node:http';
import { fingerprint } from './inventory.mjs';
import { invariant } from './durable.mjs';

// Endpoint/configuration come from the fixed deployment recipe, never IPC.
// Credentials remain in memory and responses never enter the parent journal.
export function generationOwner({ kind, endpoint, token, definition }) {
  invariant(kind === 'acp', 'unsupported-generation-owner');
  const rpc = (method, path, body) => new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    invariant(url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password && url.pathname === '/', 'loopback-owner-required');
    const options = { hostname: url.hostname, port: url.port, path };
    const req = httpRequest({ ...options, method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, response => {
      let size = 0, chunks = [];
      response.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) response.destroy(new Error('owner-response-limit')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        try { invariant(response.statusCode === 200, 'owner-rejected'); resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error('owner-rejected')); }
      });
    });
    req.setTimeout(90_000, () => req.destroy(new Error('owner-timeout'))); req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const invoke = (action, params) => rpc('POST', '/generations', { action, ...params });
  const owner = {
    id: kind,
    async snapshot() {
      const value = await rpc('GET', '/health');
      invariant(typeof value.ownerIncarnation === 'string', 'generation-protocol-unavailable');
      const generations = value.generations.filter(g => !['retired', 'discarded'].includes(g.state)).map(g => ({ id: g.id, state: g.state,
        incarnation: g.incarnation, identity: fingerprint({ pid: g.pid, configurationDigest: g.configurationDigest }) }));
      return { owner: value.ownerIncarnation, epoch: value.admissionEpoch, host: value.ownerIncarnation,
        lastActivation: value.lastActivation ?? null, current: value.current, generations };
    },
    prepare: (id, state) => invoke('add', { id, configPath: definition.configPath, expectedCurrent: state.current, expectedEpoch: state.epoch, expectedOwner: state.owner }),
    async preparation(id, state) { return (await invoke('preparation', { id, expectedOwner: state.owner, expectedEpoch: state.epoch, expectedCurrent: state.current })).preparation; },
    activate: (id, state, preparation, operationId) => invoke('activate', { id, expectedCurrent: state.current, expectedEpoch: state.epoch, preparation, expectedOwner: state.owner, operationId }),
    async cleanup(id, state) {
      const raw = await rpc('GET', '/health'), candidate = raw.generations.find(g => g.id === id);
      invariant(candidate && candidate.occupancy && Object.values(candidate.occupancy).every(n => n === 0), 'candidate-busy');
      const action = candidate.bindings === 0 ? 'retire' : 'suspend';
      await invoke(action, { id, expectedCurrent: state.current, expectedEpoch: state.epoch, preparation: await owner.preparation(id, state) });
      return { disposition: action === 'retire' ? 'retired' : 'dormant' };
    },
  };
  return owner;
}
