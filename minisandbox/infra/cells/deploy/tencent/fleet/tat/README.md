# Tencent builder operations

These helpers make a same-VPC builder the controlled entry point when the TKE
API is not reliably reachable from the operator workstation. They do not store
Tencent credentials, kubeconfigs, registry tokens, or runtime tokens.

Supply Tencent credentials through the normal `tccli` environment or a
short-lived role, then resolve exactly one builder from the current converged bootstrap receipt:

```sh
state=/data/agents/cloud/tencent-beijing-qualification/state/bootstrap-node.json
export TAT_INSTANCE_ID=$(jq -er \
  '.InstanceIdSet | if length == 1 then .[0] else error("not one current builder") end' "$state")
export TENCENT_REGION=ap-beijing
export TENCENT_PROFILE=xinqi-root  # optional named tccli profile
```

Do not copy an instance ID from `preflight/builder-instance.json`, a retired receipt, an old TAT
invocation, or shell history. Those are evidence about a historical builder, not desired-state
authority. A command can still execute successfully on an old online instance and observe an old
release ledger, so TAT reachability alone does not prove ownership. Argo desired state must be
republished whenever the converged bootstrap identity changes.

Run a reviewed program from a file or standard input:

```sh
./tat-run.sh --name actor-fleet-health --timeout 300 --file ./health-check.sh
printf '%s\n' 'kubectl --kubeconfig /secure/cell.kubeconfig get pods -A' |
  ./tat-run.sh --name actor-fleet-pods --timeout 300
```

Transfer a reviewed artifact or retrieve a qualification receipt:

```sh
./tat-upload.sh ./deploy-bundle.tar.gz /var/lib/actor-build/incoming/deploy-bundle.tar.gz
./tat-download.sh /var/lib/actor-build/receipts/release.json ./receipts/release.json
```

Both transfer directions use bounded TAT payloads, validate byte counts and
SHA-256, and install the target atomically. Existing targets are rejected by
default; set `TAT_UPLOAD_OVERWRITE=1` or `TAT_DOWNLOAD_OVERWRITE=1` only after
resolving the exact path. `tat-run.sh` succeeds only after terminal
`TaskStatus=SUCCESS` and exit code zero.

`tat-run.sh` prints the immutable invocation ID to standard error. If the local
client disconnects, resume that invocation instead of repeating its mutation:

```sh
./tat-wait.sh inv-example
```

Long release qualifications should be submitted without holding the local
terminal open:

```sh
invocation_id=$(./tat-run.sh --detach --name bottomless-production \
  --timeout 7200 --file /secure/run-bottomless-production.sh)
printf '%s\n' "$invocation_id"
```

`--detach` starts the exact command once and immediately prints its invocation
ID. Later, use `tat-wait.sh "$invocation_id"`, download the immutable receipt,
and run `runtime/verify_bottomless_receipt.py --profile production`. Do not
resubmit merely because the release gate is intentionally slow.

After modifying a helper, run its platform-independent local test:

```sh
./test-tat-tools.sh
python3 -m unittest discover -s . -p 'test_install_helm.py'
```

For stock nodes without reliable public egress, relay the official
`helm-v3.17.3-linux-amd64.tar.gz` through COS using the reviewed relay helper,
then set `ACTOR_HELM_ARCHIVE` to its absolute node-local path before running
`install-helm.sh`. Both local and public downloads must match the same pinned
SHA-256; neither the version nor checksum is configurable. Local input must be
a regular, non-symlink file. Public fallback is HTTPS-only and bounded to 120
seconds. This is a tool artifact, not a runtime rebuild or a dependency on an
old node's filesystem.
