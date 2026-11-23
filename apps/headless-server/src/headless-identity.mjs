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
      || identity.executionEnvironment != null || !validEnvironmentLaunchParts(identity.environmentLaunch)))) {
    throw new Error('Invalid Headless identity adapter');
  }
}

const METADATA_METHODS = ['admit', 'project', 'bind', 'bindCreator', 'rememberProjects'];
/** A vault-owner port may also own the durable execution admission it seals
 * against and the non-secret ENV metadata. An admission without metadata
 * would leave new Threads without their Project, so it is refused. For Codex
 * it may seal for core's durable records (`launch`, `admitCreation`, the core
 * assets Worker's `environmentLaunchRecord` and `environmentCreationAdmission`;
 * both or neither) and own personal Git execution (`git`). */
function validEnvironmentLaunchParts(port) {
  const { admission, metadata, launch, admitCreation, git } = port;
  if (admission !== undefined && typeof admission !== 'function') return false;
  if (metadata !== undefined && (!metadata || typeof metadata !== 'object'
    || METADATA_METHODS.some(method => typeof metadata[method] !== 'function'))) return false;
  if ((launch !== undefined || admitCreation !== undefined)
    && (typeof launch !== 'function' || typeof admitCreation !== 'function')) return false;
  if (git !== undefined && !validGitExecutionOwner(git)) return false;
  return admission === undefined || metadata !== undefined;
}

/** The members the core assets Worker offers its Git execution owner:
 * configured hosts, the grant authority and the two grant handoffs. */
export function validGitExecutionOwner(git) {
  return !!git && typeof git === 'object' && Array.isArray(git.hosts) && git.hosts.length > 0 && git.hosts.length <= 64
    && git.hosts.every(host => typeof host === 'string' && /^[a-z0-9.-]{1,253}$/u.test(host))
    && new Set(git.hosts).size === git.hosts.length
    && typeof git.authority === 'string' && /^[a-f0-9]{64}$/u.test(git.authority)
    && typeof git.grant === 'function' && typeof git.reservation === 'function';
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

/** Deployment configuration of core ENV delivery. `OPENCRAFT_ENVIRONMENT_ISSUER_FILE`
 * is where the vault owner publishes its issuer public key for the supervisor of
 * independent execution owners; `..._GENERATION` rotates the sealed key
 * explicitly. Empty values are unset; nothing here selects a key. */
export function environmentDeliveryOptions(env) {
  const delivery = env.OPENCRAFT_ENVIRONMENT_DELIVERY || undefined,
    publish = env.OPENCRAFT_ENVIRONMENT_ISSUER_FILE || undefined,
    generation = env.OPENCRAFT_ENVIRONMENT_ISSUER_GENERATION || undefined;
  if (delivery === undefined) {
    if (publish !== undefined || generation !== undefined) throw new Error('The ENV issuer requires OPENCRAFT_ENVIRONMENT_DELIVERY=vault-owner');
    return {};
  }
  if (delivery !== 'vault-owner') throw new Error('OPENCRAFT_ENVIRONMENT_DELIVERY must be vault-owner');
  if (publish !== undefined && (!publish.startsWith('/') || publish.length > 4096)) throw new Error('OPENCRAFT_ENVIRONMENT_ISSUER_FILE must be absolute');
  if (generation !== undefined && !/^[A-Za-z0-9._-]{1,64}$/u.test(generation)) throw new Error('Invalid OPENCRAFT_ENVIRONMENT_ISSUER_GENERATION');
  return { environmentDelivery: delivery, ...(publish || generation ? { environmentIssuer: {
    ...(publish ? { publish } : {}), ...(generation ? { generation } : {}) } } : {}) };
}
