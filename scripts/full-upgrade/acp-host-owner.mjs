import { readPrivateJson, invariant } from './durable.mjs';

/** Fixed, private deployment descriptor. The caller owns the signed recipe,
 * existing host activation lock, service supervision and durable parent intent.
 * No service names, executable paths or credentials are accepted over IPC. */
export function acpHostOwner(descriptorPath) {
  const read = async () => {
    const descriptor = await readPrivateJson(descriptorPath), url = new URL(descriptor.controlUrl);
    invariant(descriptor.schemaVersion === 1 && url.protocol === 'http:' && url.hostname === '127.0.0.1'
      && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash
      && Number.isSafeInteger(descriptor.pid) && descriptor.pid > 0 && typeof descriptor.token === 'string', 'invalid-acp-owner-descriptor');
    return { descriptor, url };
  };
  const rpc = async (action, input) => {
    const { descriptor, url } = await read();
    const response = await fetch(new URL(action ? '/owner-handoff' : '/health', url), {
      method: action ? 'POST' : 'GET', headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' },
      ...(action ? { body: JSON.stringify({ action, ...input }) } : {}), signal: AbortSignal.timeout(15000),
    });
    invariant(response.ok, 'acp-owner-control-rejected');
    const bytes = await response.text(); invariant(bytes.length <= 1024 * 1024, 'acp-owner-response-limit');
    const value = JSON.parse(bytes);
    invariant(value.pid === descriptor.pid && typeof value.bootId === 'string' && typeof value.handoff?.owner === 'string', 'acp-owner-identity-unavailable');
    return value;
  };
  return {
    snapshot: () => rpc(),
    acquireFence: input => rpc('fence', input),
    inspectDrain: input => rpc('inspect', input),
    releaseWriter: input => rpc('release', input),
    coldReady: input => rpc('cold-ready', input),
    releaseFence: (input, ready) => rpc('resume', { ...input, identity: ready.handoff.ready.identity }),
  };
}
