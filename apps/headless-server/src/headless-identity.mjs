/** A trusted, compiled server adapter. Configuration never names an executable module. */
export function validateHeadlessIdentity(identity) {
  if (identity == null) return;
  if (typeof identity !== 'object' || !Array.isArray(identity.providers)
    || identity.providers.some(provider => !provider || typeof provider.authenticate !== 'function')
    || typeof identity.close !== 'function'
    || (identity.service != null && ['admissionStatus', 'connectionContext', 'handle'].some(method => typeof identity.service[method] !== 'function'))
    || (identity.capabilityProviders !== undefined && (!Array.isArray(identity.capabilityProviders)
      || identity.capabilityProviders.some(p => !p || typeof p.id !== 'string' || typeof p.tools !== 'function' || typeof p.call !== 'function')))
    || (identity.notificationDefaultTarget !== undefined && typeof identity.notificationDefaultTarget !== 'function')
    || (identity.createThreadMetadata !== undefined && typeof identity.createThreadMetadata !== 'function')
    || (identity.getStorageOutcomes !== undefined && typeof identity.getStorageOutcomes !== 'function')
    || (identity.sshAccess !== undefined && (!identity.sshAccess
      || ['publicKeys', 'authorize'].some(method => typeof identity.sshAccess[method] !== 'function')))
    || (identity.admissionPolicy !== undefined && (!identity.admissionPolicy
      || ['prepare', 'allows', 'allowsBinding'].some(method => typeof identity.admissionPolicy[method] !== 'function')))
    // Opaque ENV delivery replaces, never accompanies, the synchronous runtime.
    || (identity.environmentLaunch !== undefined && (!identity.environmentLaunch || typeof identity.environmentLaunch.seal !== 'function'
      || typeof identity.environmentLaunch.issuer !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(identity.environmentLaunch.issuer)
      || identity.executionEnvironment != null))) {
    throw new Error('Invalid Headless identity adapter');
  }
}

/** Opaque ENV delivery from the core vault Worker (`'vault-owner'`). It replaces,
 * never accompanies, the synchronous runtime or a downstream vault-owner port. */
export function validateEnvironmentDelivery(delivery, identity) {
  if (delivery === undefined) return false;
  if (delivery !== 'vault-owner') throw new Error('Invalid environment delivery');
  if (identity?.executionEnvironment != null || identity?.environmentLaunch !== undefined)
    throw new Error('Execution ENV cannot have two owners');
  return true;
}
