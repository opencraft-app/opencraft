import { acceptManifest, sha256 } from '../full-release/contract.mjs';
import { fingerprint, inventoryIdentity } from './inventory.mjs';

const check = (id, status, reason, details = null) => ({ id, status, reason, details });
const impact = strategy => ({
  'web-transaction': 'reconnect', generation: 'preserve-existing-bindings',
  'drained-owner': 'drain-or-interrupt', helper: 'maintenance', external: 'external-maintenance',
})[strategy] ?? 'unknown';

// No execution operation is exported. A P2b executor must re-collect, re-verify
// and compare every CAS expectation; this advisory object is never authority.
export function createPlan({ inventory, manifestBytes, signature, trust, releasePolicy = null, now = Date.now() }) {
  if (inventory?.schemaVersion !== 1 || inventory.kind !== 'opencraft.upgrade-inventory' || inventory.mode !== 'read-only') throw new Error('Invalid upgrade inventory');
  const { resources } = inventory;
  if (fingerprint(inventoryIdentity(inventory)) !== inventory.fingerprint) throw new Error('Inventory fingerprint mismatch');
  const replayStates = inventory.deployments.map(d => d.replay).filter(Boolean);
  const replayVerified = inventory.deployments.length > 0 && inventory.deployments.every(d => d.replayObservation?.status === 'observed' && d.replay);
  const state = { highestSequence: Math.max(0, ...replayStates.map(s => s.highestSequence ?? 0)),
    revocationSequence: Math.max(1, ...replayStates.map(s => s.revocationSequence ?? 1)),
    revokedKeyIds: [...new Set(replayStates.flatMap(s => s.revokedKeyIds ?? []))],
    revokedReleaseIds: [...new Set(replayStates.flatMap(s => s.revokedReleaseIds ?? []))] };
  const highest = replayStates.find(s => s.highestSequence === state.highestSequence);
  if (new Set(replayStates.filter(s => s.highestSequence === state.highestSequence).map(s => s.manifestSha256)).size > 1) throw new Error('Conflicting full release replay watermarks');
  if (highest) state.manifestSha256 = highest.manifestSha256;
  const { record: target } = acceptManifest(manifestBytes, signature, trust, state, null, now);
  const manifestSha256 = sha256(manifestBytes);
  const installedTarget = inventory.deployments.length === 0 ? 'unknown' : inventory.deployments.some(d => d.current?.fullRelease?.manifestSha256 === manifestSha256)
    ? 'target-pointer-present' : 'target-pointer-differs';
  const units = inventory.owners.flatMap(o => o.units), applicableUnits = units.filter(u => u.status !== 'not-installed');
  const stability = applicableUnits.some(u => u.stable === false) ? 'blocked' : !units.length || applicableUnits.some(u => u.status === 'unknown' || u.stable !== true) ? 'unknown' : 'verified';
  const checks = [check('upgrade-recipes', releasePolicy?.recipes.length ? 'verified' : 'blocked', 'signed-owner-recipes-required'), check('signed-upgrade-policy', releasePolicy ? 'verified' : 'blocked', releasePolicy ? 'release-bound-policy-accepted' : 'signed-compatibility-and-recipes-unavailable'), check('release-signature-policy', 'verified', 'signature-product-channel-expiry-platform-accepted', { manifestSha256, keyId: signature.keyId }),
    check('release-authentication', replayVerified ? 'verified' : 'unknown', replayVerified ? 'current-sequence-and-revocation-state-accepted' : 'current-sequence-or-revocation-state-unavailable'),
    check('product-channel-profile', target.release.product === inventory.product && target.release.channel === inventory.channel
      && target.targets.some(t => t.profile === inventory.profile && t.platform === inventory.platform && t.arch === inventory.arch) ? 'verified' : 'blocked', 'exact-profile-required'),
    check('runtime-platform', 'unknown', 'observed-node-abi-does-not-certify-target-native-closure', { probe: resources.probeNode,
      owners: [...new Set(inventory.owners.flatMap(o => o.units.flatMap(u => u.processes.map(p => p.node?.abi).filter(Boolean))))] }),
    check('inventory-stability', stability, 'per-unit-incarnation-double-read-or-explicit-absence', { applicableUnits: applicableUnits.length, absentUnits: units.length - applicableUnits.length }),
    check('discovery-completeness', 'unknown', 'bounded-store-and-owner-discovery-needs-owner-attestation', { unmanagedUnits: inventory.unmanagedUnits }),
    check('rollback', 'unknown', 'retained-package-pointer-is-not-content-or-schema-recovery-proof'),
    check('storage-backups', 'unknown', 'all-writers-migrations-and-isolated-restore-required', { observedStores: inventory.stores.length, targetStores: target.stores }),
    check('ports-processes-permissions-network', 'unknown', 'read-only-probe-does-not-reserve-or-prove-update-authority'),
    check('agent-helper', 'unknown', 'unit-observation-needs-live-agent-helper-protocol-and-authority-attestation', {
      units: inventory.owners.filter(o => o.ownerId === 'upgrade-control').flatMap(o => o.units.map(u => ({ unit: u.unit, status: u.status, stable: u.stable ?? null }))) })];
  const disk = resources.storage;
  checks.push(check('disk-peak', 'unknown', 'additional-peak-needs-reuse-retention-unpack-and-backup-proof', {
    targetPayloadBytes: target.components.reduce((sum, c) => sum + c.content.unpackedBytes, 0),
    budgetCeilingBytes: target.budgets.recursive.diskBytes, requiredAdditionalBytes: null, measured: disk }));
  checks.push(check('memory-peak', 'unknown', 'owner-coexistence-working-set-proof-required', {
    budgetCeilingBytes: target.budgets.recursive.memoryBytes, requiredAdditionalBytes: null, observedAvailableBytes: resources.availableMemoryBytes }));
  const components = target.components.map(c => {
    const owners = c.role === 'distribution' ? [] : inventory.owners.filter(o => o.roles?.includes(c.role) || o.role === c.role);
    const reasons = [];
    if (!owners.length) reasons.push('distribution-root-has-no-independent-runtime-owner');
    if (c.activation.authority !== 'verified') reasons.push('target-activation-' + c.activation.authority);
    reasons.push('running-target-content-and-mixed-version-compatibility-unproven');
    for (const o of owners) {
      if (o.status === 'unknown') reasons.push('owner-inventory-unknown');
      if (o.status === 'not-installed') reasons.push('owner-not-installed-preserve-enabled-state');
      if (o.capabilities.status === 'unknown') reasons.push('owner-fence-occupancy-cold-ready-unknown');
      if (o.retained.status === 'unknown') reasons.push('historical-binding-and-lease-retention-unknown');
    }
    return { componentId: c.componentId, role: c.role, ownerIds: owners.map(o => o.ownerId),
      target: { version: c.version, buildId: c.buildId, sourceRevision: c.sourceRevision, contentRoot: c.content.root, fileListSha256: c.content.fileListSha256 },
      current: owners.map(o => ({ ownerId: o.ownerId, status: o.status, units: o.units.map(u => ({ unit: u.unit, mainPid: u.mainPid ?? null,
        processes: u.processes.map(p => ({ pid: p.pid, bootId: p.bootId, startTicks: p.startTicks, entry: p.entry, installedEntry: p.installedEntry, runningSource: p.runningSource })) })) })),
      proposedAction: c.activation.strategy === 'external' ? 'external-prerequisite' : c.activation.strategy,
      comparison: { installed: installedTarget, running: 'unknown', contentVerification: 'unknown',
        explanation: 'package-pointer-is-separate-from-each-owner-running-content' },
      proposedSteps: ({ generation: ['verify-target-and-cold-ready', 'prepare-generation', 'activate-default-with-owner-cas', 'retain-existing-bindings'],
        'web-transaction': ['verify-target-and-mixed-browser-contract', 'delegate-official-web-transaction', 'verify-running-identity'],
        'drained-owner': ['verify-target-and-storage-compatibility', 'fence-and-drain-owner', 'replace-owner-and-verify-ready'],
        helper: ['verify-fixed-helper-and-old-new-protocols', 'maintain-fixed-owner', 'verify-running-identity-and-recovery'],
        external: ['satisfy-external-prerequisite'] })[c.activation.strategy],
      enabledPolicy: c.enabledPolicy, required: c.required, interruption: impact(c.activation.strategy),
      recovery: 'compatible-retained-code-only-no-data-snapshot-restore', status: 'blocked', blockedReasons: [...new Set(reasons)] };
  });
  const matrix = [];
  // Every dependency is checked in final, forward mixed, and rollback mixed
  // states. Empty declarations cannot certify existing consumers or browsers.
  for (const c of target.components) for (const r of c.requires) {
    const provider = target.components.find(p => p.componentId === r.componentId);
    matrix.push({ consumer: c.componentId, provider: r.componentId, capability: r.name, expected: r.version,
      combination: 'target-target', status: provider?.provides.some(p => p.name === r.name && p.version === r.version) ? 'verified' : 'blocked' });
  }
  for (const c of target.components) for (const combination of ['old-consumer-new-provider', 'new-consumer-old-provider', 'rollback', 'retained-cli-host-browser']) {
    matrix.push({ componentId: c.componentId, combination, status: 'unknown', reason: 'no-signed-current-target-combination-proof' });
  }
  const expected = { inventoryFingerprint: inventory.fingerprint, bootId: inventory.bootId, adapterProfileSha256: inventory.adapterProfileSha256,
    manifestSha256, releaseSequence: target.release.releaseSequence, replayStateSha256: fingerprint(replayStates),
    deploymentPointers: inventory.deployments.map(d => ({ stateDirectory: d.stateDirectory, pointerSha256: d.pointerSha256 })),
    processes: inventory.owners.flatMap(o => o.units.flatMap(u => u.processes.map(p => ({ unit: u.unit, pid: p.pid, bootId: p.bootId, startTicks: p.startTicks,
      managedEnvironmentSha256: p.managedEnvironmentSha256 })))), policySha256: fingerprint({ mode: 'read-only', trust, profile: inventory.profile }) };
  const body = { schemaVersion: 1, kind: 'opencraft.upgrade-plan', mode: 'read-only', status: 'blocked', executable: false,
    target: { ...target.release, manifestSha256 }, expected, checks, components,
    owners: inventory.owners.map(o => ({ ownerId: o.ownerId, role: o.role, status: o.status, management: o.management,
      proposedAction: o.management === 'external' ? 'external-prerequisite' : o.status === 'not-installed' ? 'preserve-not-installed' : 'inspect-before-maintenance',
      blockedReasons: ['owner-specific-protocol-storage-retention-and-impact-proof-required'] })),
    compatibilityMatrix: matrix, blockedReasons: checks.filter(c => c.status !== 'verified').map(c => c.id),
    executionOrder: [], replanOnDrift: true, automaticSnapshotRestore: false };
  const planDigest = fingerprint(body);
  return { ...body, planId: 'plan-' + planDigest, planDigest, generatedAt: new Date(now).toISOString() };
}

export function checkPlanExpectations(plan, inventory, manifestBytes) {
  return fingerprint(inventoryIdentity(inventory)) === inventory.fingerprint
    && plan.expected.inventoryFingerprint === inventory.fingerprint && plan.expected.bootId === inventory.bootId
    && plan.expected.manifestSha256 === sha256(manifestBytes);
}
