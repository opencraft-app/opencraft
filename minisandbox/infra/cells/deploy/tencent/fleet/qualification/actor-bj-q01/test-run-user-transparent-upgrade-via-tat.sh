#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python3 - \
	"$script_dir/run-user-transparent-upgrade-on-builder.sh" \
	"$script_dir/run-user-transparent-upgrade-via-tat.sh" <<'PY'
import pathlib, sys

for path in map(pathlib.Path, sys.argv[1:]):
    source = path.read_text()
    for expected in (
        "export RUNTIME_AUTOSCALING_FIELD_MANAGER=actor-q01-autoscaling",
        "export RUNTIME_CAPACITY_MIN_REPLICAS=3",
        "export RUNTIME_CAPACITY_MAX_REPLICAS=30",
        "export RUNTIME_CAPACITY_TARGET_ACTIVE_ACTORS=16",
        "AUTONOMY_OPERATION_LOCK_WAIT_SECONDS=120",
        'with-autonomy-operation-lock.sh" --',
    ):
        if expected not in source:
            raise SystemExit(
                f"q01 release entrypoint {path.name} lost its ownership/lock contract: {expected}"
            )
PY
temporary=$(mktemp -d /data/tmp/q01-upgrade-via-tat-test.XXXXXX)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT
install -d "$temporary/bin"
cat >"$temporary/bin/tccli" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$2" >>"${MOCK_TCCLI_ACTIONS:?}"
case "$1:$2" in
tat:InvokeCommand)
  printf '%s\n' '{"InvocationId":"inv-mocked"}'
  ;;
tat:DescribeInvocationTasks)
  output=$(printf '%s\n' "${MOCK_COMMAND_RESULT:?}" | base64 | tr -d '\n')
  printf '%s\n' "{\"InvocationTaskSet\":[{\"TaskStatus\":\"FAILED\",\"TaskResult\":{\"Output\":\"$output\",\"ExitCode\":1}}]}"
  ;;
*) exit 2 ;;
esac
MOCK
chmod 0755 "$temporary/bin/tccli"

run_id=$(printf 'a%.0s' {1..32})
remote=/data/actor-qualification/receipts/actor-bj-q01-user-transparent-upgrade-${run_id}.json
export MOCK_TCCLI_ACTIONS="$temporary/actions"
export MOCK_COMMAND_RESULT
MOCK_COMMAND_RESULT=$(python3 - "$run_id" "$remote" <<'PY'
import json, sys
run_id, remote = sys.argv[1:]
document = {
    "schema": "actor-approved-release-command-result/v1", "cell": "actor-bj-q01",
    "releaseRunID": run_id, "phase": "upgrade", "commandExitCode": 1,
    "fullReceipt": {
        "location": "protected-builder", "path": remote, "present": True,
        "sha256": "b" * 64, "sizeBytes": 123,
        "schema": "actor-bj-q01-user-transparent-upgrade/v2", "verdict": "failed",
    },
}
print("actor_release_command_result=" + json.dumps(document, separators=(",", ":")))
PY
)
export PATH="$temporary/bin:$PATH"
export TENCENTCLOUD_SECRET_ID=mock-id
export TENCENTCLOUD_SECRET_KEY=mock-key
export TAT_INSTANCE_ID=ins-mocked
export TAT_COMMAND_ID=cmd-12345678
export ACTOR_RELEASE_TEST_MODE=1
export RIVET_UPGRADE_RUN_ID=$run_id
export RIVET_UPGRADE_LOCAL_RECEIPT=/data/tmp/q01-compact-upgrade-${run_id}.json
export RIVET_RELEASE_ORCHESTRATOR=argocd
export RIVET_RELEASE_APPLICATION=actor-runtime-release-q01
export RIVET_RELEASE_APPLICATION_NAMESPACE=argocd
export RIVET_RELEASE_HOOK_JOB=actor-runtime-release
export RIVET_RELEASE_HOOK_PHASE=Sync
export RIVET_RELEASE_ATTEMPT=initial
export RIVET_RELEASE_POD_NAMESPACE=actor-release-system
export RIVET_RELEASE_POD_NAME=actor-runtime-release-abcde
export RIVET_RELEASE_POD_UID=12345678-1234-1234-1234-123456789abc
export TMPDIR=$temporary
rm -f -- "$RIVET_UPGRADE_LOCAL_RECEIPT"
runtime=actor-fleet-beijing.tencentcloudcr.com/actor-fleet/rivet-runtime@sha256:$(printf '1%.0s' {1..64})
reporter=actor-fleet-beijing.tencentcloudcr.com/actor-fleet/actor-fleet-controller@sha256:$(printf '2%.0s' {1..64})
export ACTOR_IMAGE_INVENTORY=$temporary/inventory.json
export RIVET_COLD_BUCKET=actor-depot-cold-prod-bj-q01-nv1-1234567890
python3 - "$script_dir/../../gitops/image-seed" "$ACTOR_IMAGE_INVENTORY" "$runtime" "$reporter" <<'PY'
import json, pathlib, sys
root, output, runtime, reporter = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3], sys.argv[4]
sys.path.insert(0, str(root))
import image_contract as contract

upstream = contract.validate_upstream(contract.load(root / "upstream-images.lock.json"))
registry, namespace = "actor-fleet-beijing.tencentcloudcr.com", "actor-fleet"
seed = {
    "schemaVersion": 1, "result": "passed", "registry": registry,
    "namespace": namespace, "platform": upstream["platform"],
    "sourceLockDigest": contract.digest(upstream),
    "images": [{
        "repository": item["repository"], "source": item["source"],
        "destination": f"{registry}/{namespace}/{item['repository']}@sha256:" + "b" * 64,
        "destinationDigest": "sha256:" + "b" * 64,
    } for item in upstream["images"]],
}
products = {
    "schemaVersion": 1, "registry": registry, "namespace": namespace,
    "images": [{
        "repository": repository,
        "ref": (runtime if repository == "rivet-runtime" else reporter if repository == "actor-fleet-controller"
                else f"{registry}/{namespace}/{repository}@sha256:" + "c" * 64),
        "sourceRevision": "d" * 40, "sourceManifestDigest": "sha256:" + "e" * 64,
        "buildReceiptDigest": "sha256:" + "f" * 64,
    } for repository in sorted(contract.PRODUCT_REPOSITORIES)],
}
output.write_text(json.dumps(contract.assemble(upstream, seed, products)))
PY
export RIVET_APPROVED_COMMANDS_RECEIPT=$temporary/approved-commands.json
python3 - "$RIVET_APPROVED_COMMANDS_RECEIPT" "$run_id" "$runtime" "$reporter" "$ACTOR_IMAGE_INVENTORY" <<'PY'
import hashlib, json, sys
output, run_id, runtime, reporter, inventory = sys.argv[1:]
identity = lambda image, revision, manifest: {
    "image": image, "sourceRevision": revision, "sourceManifestSHA256": manifest,
}
document = {
    "schema": "actor-approved-release-commands/v2", "cell": "actor-bj-q01",
    "runID": run_id,
    "control": {"sourceRevision": "7" * 40, "sourceManifestSHA256": "8" * 64},
    "upgrade": {"commandID": "cmd-12345678", "contentSHA256": "9" * 64},
    "rollback": {"commandID": "cmd-r0llback", "contentSHA256": "a" * 64},
    "candidate": {
        "runtime": identity(runtime, "3" * 40, "4" * 64),
        "reporter": identity(reporter, "5" * 40, "6" * 64),
    },
    "previous": {
        "runtime": identity(runtime, "3" * 40, "4" * 64),
        "reporter": identity(reporter, "5" * 40, "6" * 64),
    },
    "imageInventorySHA256": hashlib.sha256(open(inventory, "rb").read()).hexdigest(),
    "coldBucket": "actor-depot-cold-prod-bj-q01-nv1-1234567890",
    "qualificationCandidate": None,
    "approvalTag": "actor-release-approved=true", "parameterized": False,
    "verdict": "passed",
}
open(output, "w").write(json.dumps(document))
PY
set +e
"$script_dir/run-user-transparent-upgrade-via-tat.sh" \
  "$runtime" "$(printf '3%.0s' {1..40})" "$(printf '4%.0s' {1..64})" "$reporter" \
  "$(printf '5%.0s' {1..40})" "$(printf '6%.0s' {1..64})" \
  >"$temporary/stdout" 2>"$temporary/stderr"
status=$?
set -e
[[ $status == 1 ]]
if [[ ! -f $RIVET_UPGRADE_LOCAL_RECEIPT ]]; then
  cat "$temporary/stderr" >&2
  echo "approved command wrapper did not persist its compact receipt" >&2
  exit 1
fi
python3 - "$RIVET_UPGRADE_LOCAL_RECEIPT" <<'PY'
import json, sys
with open(sys.argv[1]) as stream:
    document = json.load(stream)
assert document["phase"] == "upgrade"
assert document["commandExitCode"] == 1
assert document["fullReceipt"]["verdict"] == "failed"
assert document["orchestration"]["kind"] == "argocd"
assert document["orchestration"]["hookPhase"] == "Sync"
assert document["orchestration"]["pod"]["uid"] == "12345678-1234-1234-1234-123456789abc"
PY
grep -Fxq InvokeCommand "$MOCK_TCCLI_ACTIONS"
grep -Fxq DescribeInvocationTasks "$MOCK_TCCLI_ACTIONS"
if grep -Fxq RunCommand "$MOCK_TCCLI_ACTIONS"; then
  echo "approved command path unexpectedly created a dynamic TAT command" >&2
  exit 1
fi
rm -f -- "$RIVET_UPGRADE_LOCAL_RECEIPT"
echo "approved command TAT wrapper tests passed"
