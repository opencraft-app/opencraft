/** A trusted, compiled server adapter. Configuration never names an executable module. */
export function validateHeadlessIdentity(identity) {
  if (identity == null) return;
  if (typeof identity !== 'object' || !Array.isArray(identity.providers)
    || identity.providers.some(provider => !provider || typeof provider.authenticate !== 'function')
    || typeof identity.close !== 'function'
    || (identity.service != null && ['admissionStatus', 'connectionContext', 'handle'].some(method => typeof identity.service[method] !== 'function'))
    || (identity.capabilityProviders !== undefined && (!Array.isArray(identity.capabilityProviders)
      || identity.capabilityProviders.some(p => !p || typeof p.id !== 'string' || typeof p.tools !== 'function' || typeof p.call !== 'function')))
    || (identity.createThreadMetadata !== undefined && typeof identity.createThreadMetadata !== 'function')
    || (identity.getStorageOutcomes !== undefined && typeof identity.getStorageOutcomes !== 'function')
    || (identity.sshAccess !== undefined && (!identity.sshAccess
      || ['publicKeys', 'authorize'].some(method => typeof identity.sshAccess[method] !== 'function')))
    || (identity.admissionPolicy !== undefined && (!identity.admissionPolicy
      || ['prepare', 'allows', 'allowsBinding'].some(method => typeof identity.admissionPolicy[method] !== 'function')))) {
    throw new Error('Invalid Headless identity adapter');
  }
}
