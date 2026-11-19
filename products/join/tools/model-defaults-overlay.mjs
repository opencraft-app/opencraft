import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
/** Focused compatibility delivery: preserve the exact deployed Gateway, including
 * its instance fixes. Refuse source drift instead of replacing the full platform. */
export function modelDefaultsOverlay(source, expectedSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || createHash('sha256').update(source).digest('hex') !== expectedSha256)
    throw Error('Gateway baseline digest changed');
  const declaration = 'function joinIdentityComposition() {';
  const boundary = '// products/join/gateway.mjs';
  const declarationOffset = source.indexOf(declaration);
  const boundaryOffset = source.indexOf(boundary, declarationOffset);
  if (source.split(declaration).length !== 2 || boundaryOffset < 0
    || source.indexOf(boundary, boundaryOffset + boundary.length) >= 0
    || source.includes('__joinAccountModelDefaults')) throw Error('Unsupported Gateway composition baseline');
  const prefix = source.slice(0, boundaryOffset).replace(declaration, 'function __joinOriginalIdentityComposition() {');
  return "import { withTencentOaModelDefaults as __joinAccountModelDefaults } from './account-model-defaults.mjs';\n"
    + prefix + 'function joinIdentityComposition() { return __joinAccountModelDefaults(__joinOriginalIdentityComposition()); }\n\n'
    + source.slice(boundaryOffset);
}

/** Retain an already-audited deployment transform without running its Node loader
 * or starting the old Gateway. The caller pins both input artifacts. */
export function retainCredentialCompatibility(source, loader, expectedSha256) {
  if (createHash('sha256').update(loader).digest('hex') !== expectedSha256)
    throw Error('Credential loader digest changed');
  const start = loader.indexOf('function extendGateway(source) {');
  const end = loader.indexOf('// .local/team-credentials/loader.mjs\nregisterHooks', start);
  if (start < 0 || end < 0) throw Error('Unsupported credential compatibility loader');
  return runInNewContext(loader.slice(start, end) + ';extendGateway(__input)', { __input: source }, { timeout: 1000 });
}
export function modelDefaultsServiceEntry(source, expectedSha256) {
  if (createHash('sha256').update(source).digest('hex') !== expectedSha256)
    throw Error('Service launcher digest changed');
  const pattern = /gateway: (['"])container-gateway\.mjs\1/g;
  if ([...source.matchAll(pattern)].length !== 1) throw Error('Unsupported service launcher');
  return source.replace(pattern, "gateway: 'container-gateway.account-defaults.mjs'");
}

/** This is presentation metadata only. The administrator's rule store and
 * assertModelPolicy admission are retained byte-for-byte. */
export function modelPolicySelectionOverlay(source) {
  const old = 'policyRestricted: rules.some((r) => r.engine === engine),';
  if (source.split(old).length !== 2) throw Error('Unsupported model policy projection baseline');
  return source.replace(old, 'policyRestricted: denied2(rules.filter((r) => r.effort === void 0), engine, m2.model ?? m2.id),');
}
