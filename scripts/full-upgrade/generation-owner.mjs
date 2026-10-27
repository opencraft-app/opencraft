import { request as httpRequest } from 'node:http';
import { fingerprint } from './inventory.mjs';
import { invariant } from './durable.mjs';

// Endpoint/configuration come from the fixed deployment recipe, never IPC.
// Credentials remain in memory and responses never enter the parent journal.
export function generationOwner({ kind, endpoint, token, definition }) {
  invariant(['codex', 'acp'].includes(kind), 'unsupported-generation-owner');
  const rpc = (method, path, body) => new Promise((resolve, reject) => {
    let options;
    if (kind === 'codex') options = { socketPath: endpoint, path };
    else {
      const url = new URL(endpoint);
      invariant(url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password && url.pathname === '/', 'loopback-owner-required');
      options = { hostname: url.hostname, port: url.port, path };
    }
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
  const invoke = (action, params) => rpc('POST', '/generations', kind === 'codex' ? { operation: action, params } : { action, ...params });
  const owner = {
    id: kind,
    async snapshot() {
      const value = await rpc('GET', kind === 'codex' ? '/generations' : '/health');
      invariant(kind === 'codex' ? typeof value.routingEpoch === 'string' : typeof value.ownerIncarnation === 'string', 'generation-protocol-unavailable');
      const generations = value.generations.filter(g => !['retired', 'discarded'].includes(g.state)).map(g => ({ id: g.id, state: g.state,
        incarnation: g.incarnation, identity: fingerprint(kind === 'codex' ? { runtime: g.runtime, executable: g.executable, bundle: g.bundle, node: g.node, home: g.runtimeDataDirectory }
          : { pid: g.pid, configurationDigest: g.configurationDigest }) }));
      return { owner: kind === 'codex' ? value.routingEpoch : value.ownerIncarnation, epoch: value.admissionEpoch,
        host: kind === 'codex' ? value.preparationOwner : value.ownerIncarnation, lastActivation: value.lastActivation ?? null,
        current: kind === 'codex' ? value.generations.find(g => g.state === 'active')?.id : value.current, generations };
    },
    prepare: (id, state) => invoke(kind === 'codex' ? 'prepare' : 'add', kind === 'codex' ? { definition: { ...definition, id }, expectedOwner: state.owner, expectedHost: state.host }
      : { id, configPath: definition.configPath, expectedCurrent: state.current, expectedEpoch: state.epoch, expectedOwner: state.owner }),
    async preparation(id, state) { return (await invoke('preparation', { id, expectedOwner: state.owner, ...(kind === 'codex' ? { expectedHost: state.host } : { expectedEpoch: state.epoch, expectedCurrent: state.current }) })).preparation; },
    activate: (id, state, preparation, operationId) => invoke('activate', kind === 'codex' ? { id, expectedEpoch: state.epoch, preparation, expectedOwner: state.owner, expectedHost: state.host, operationId }
      : { id, expectedCurrent: state.current, expectedEpoch: state.epoch, preparation, expectedOwner: state.owner, operationId }),
    async cleanup(id, state) {
      if (kind === 'codex') {
        const raw = await rpc('GET', '/generations'), candidate = raw.generations.find(g => g.id === id);
        if (candidate?.state === 'candidate') { await invoke('discard', { id }); return { disposition: 'discarded' }; }
        // Previously activated generations always drain normally; never revoke
        // a HOME that could contain newly admitted user work.
        if (candidate?.state === 'ready') { await invoke('revoke', { id, expectedEpoch: state.epoch, preparation: await owner.preparation(id, state) }); return { disposition: 'discarded' }; }
        invariant(candidate && ['active', 'draining', 'retired'].includes(candidate.state), 'candidate-unknown');
        return { disposition: 'retained', state: candidate.state };
      }
      const raw = await rpc('GET', '/health'), candidate = raw.generations.find(g => g.id === id);
      invariant(candidate && candidate.occupancy && Object.values(candidate.occupancy).every(n => n === 0), 'candidate-busy');
      const action = candidate.bindings === 0 ? 'retire' : 'suspend';
      await invoke(action, { id, expectedCurrent: state.current, expectedEpoch: state.epoch, preparation: await owner.preparation(id, state) });
      return { disposition: action === 'retire' ? 'retired' : 'dormant' };
    },
  };
  return owner;
}
