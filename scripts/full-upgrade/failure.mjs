// Only fixed diagnostic codes cross process boundaries; raw stderr stays private.
const codes = new Set(['operation-failed', 'command-failed', 'owner-controller-failed',
  'operator-sandbox-policy-changed', 'parent-controller-drift', 'parent-target-changed-under-lock',
  'parent-preflight-rejected', 'official-delivery-failed', 'official-delivery-not-terminal',
  'parent-plan-changed', 'immutable-artifact-conflict', 'parent-step-not-healthy',
  'owner-operation-failed', 'parent-idempotency-conflict', 'parent-process-failed']);
const stages = new Set(['parent-prepare', 'owner-inspect', 'owner-apply', 'owner-recover',
  'command', 'verify-target', 'resolve-topology', 'sandbox-policy', 'install-recipe', 'control-services']);
export function failureSummary(error, stage = 'parent-prepare', ownerId) {
  const value = error?.failure ?? error;
  return { stage: stages.has(value?.stage) ? value.stage : stage,
    code: codes.has(value?.code) ? value.code : codes.has(error?.message) ? error.message : 'operation-failed',
    ...((ownerId ?? value?.ownerId) ? { ownerId: ownerId ?? value.ownerId } : {}) };
}
export function structuredFailure(stderr) {
  for (const line of stderr.slice(-8192).split('\n').reverse()) {
    try {
      const value = JSON.parse(line).opencraftFailure;
      if (value && codes.has(value.code) && stages.has(value.stage)) return failureSummary({ stage: value.stage, code: value.code });
    } catch { /* Ordinary stderr is deliberately not propagated. */ }
  }
  return undefined;
}
