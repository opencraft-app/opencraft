import type { HostProtocolRequest } from './local-agent-settings-service';

/** Read-only setup projection. This checks configured credentials, never their
 * values or external model connectivity, and never changes the default model. */
export async function readHostModelReadiness(request: HostProtocolRequest, hostId: string): Promise<boolean> {
  const [providers, settings, models] = await Promise.all([
    request(hostId, 'runtime/providers/list', {}),
    request(hostId, 'runtime/settings/describe', {}),
    request(hostId, 'runtime/models/list', {}),
  ]);
  const candidates = providers.providers.filter(provider => provider.active && provider.enabled !== false
    && provider.configuration?.modelType !== 'asr'
    && models.groups.some(group => group.id === provider.provider && group.models.some(model => model.enabled !== false && model.type !== 'asr')));
  const refs = candidates.map(provider => {
    let value: unknown = settings.namespaces.find(namespace => namespace.ns === provider.settingsNs)?.value;
    for (const key of provider.settingsPath) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    const ref = value && typeof value === 'object' ? (value as Record<string, unknown>).apiKeyEnv : undefined;
    // Providers without an API-key reference may use native/OAuth credentials.
    // Their active state remains authoritative; do not invent a key requirement.
    return typeof ref === 'string' && ref.trim() ? ref.trim() : null;
  });
  if (refs.includes(null)) return true;
  if (!refs.length) return false;
  const credentials = await request(hostId, 'runtime/credentials/describe', { refs: [...new Set(refs as string[])] });
  return refs.some(ref => ref !== null && credentials.credentials[ref]?.configured === true);
}
