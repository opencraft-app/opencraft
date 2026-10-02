#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target=$script_dir/reset-qualification-application-state-on-builder.sh
bash -n "$target"
python3 - "$target" <<'PY'
import pathlib, sys

source = pathlib.Path(sys.argv[1]).read_text()
required = (
    'cell=actor-bj-q01',
    'ALLOW_Q01_APPLICATION_STATE_RESET',
    'CENTRAL_Q01_ABSENT',
    'EXPECTED_FDB_UID',
    '.actor-source/SOURCE_REVISION',
    '.actor-source/RELEASE_SHA256SUMS',
    'release-ledger',
    'readyForPlacement==false',
    'placementCount==0',
    'activeWriters==0',
    "clearrange \"\" \\xff",
    "getrange \"\" \\xff 1",
    'foundationDBSystemKeysPreserved:true',
    'persistentVolumesPreserved:true',
    'legacyColdBucketUntouched:true',
    'targetColdBucketRequiredEmpty:true',
    'RESET_PREFLIGHT_ONLY',
    'clear_committed=true',
    'public clients remain fail-closed',
    'cold-tier identity mismatch',
    'fdbbackup describe',
    'Restorable: true',
    'actor-bj-q01-application-state-reset/v1',
    'scale request did not reach the API server',
    'kubectl --request-timeout=30s -n "$namespace" scale',
    'observation=$(kubectl --request-timeout=30s',
    'continue',
    'reconcile_workerd_runner_config',
    'exec /opt/actor/bin/init-workerd-pool',
    '"fleet.actor.dev/component":"pool-reset"',
    'phase=reconcile-runner-config',
)
for value in required:
    if value not in source:
        raise SystemExit("q01 application-state reset lost invariant: " + value)
for forbidden in (
    'delete foundationdbcluster',
    'delete pvc',
    'delete pv',
    'rm cos://',
    'actor-depot-cold-prod-bj-k01-nv1-1388575217/ -r',
):
    if forbidden in source.lower():
        raise SystemExit("q01 application-state reset gained forbidden operation: " + forbidden)
print("q01 application-state reset static invariants passed")
PY
