#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

for command in kubectl jq python3 sha256sum date flock; do require_command "${command}"; done
mkdir -p "${MESH_STATE_DIR}"
exec 9>"${MESH_STATE_DIR}/fdb-scale-down-e2e.lock"
flock 9

namespace=fdb-scale-sim
cell=actor-local-f01
cluster=actor-local-f01
machine_set=np-fdbsim01
controller_namespace=actor-fleet-controller-system
controller=actor-fleet-controller
profile=local-fdb-operator-cbs-v1
class=local-fdb-operator-cbs-v1
connection_string='localfdb:local@127.0.0.1:4500'
cleaned=false

hub() { kubectl_for "${HUB_KUBECONFIG}" "$@"; }

wait_until() {
	local predicate=$1 timeout=$2 description=$3
	local deadline=$((SECONDS + timeout))
	while (( SECONDS < deadline )); do
		if "${predicate}"; then return; fi
		sleep 2
	done
	die "timed out waiting for ${description}"
}

controller_replicas() {
	hub -n "${controller_namespace}" get deployment "${controller}" -o jsonpath='{.spec.replicas}' 2>/dev/null || printf '1'
}

stop_controller() {
	hub -n "${controller_namespace}" scale deployment/${controller} --replicas=0 >/dev/null
	hub -n "${controller_namespace}" wait pod -l app.kubernetes.io/name=actor-fleet-controller \
		--for=delete --timeout=2m >/dev/null 2>&1 || true
}

start_controller() {
	hub -n "${controller_namespace}" scale deployment/${controller} --replicas=1 >/dev/null
	hub -n "${controller_namespace}" rollout status deployment/${controller} --timeout=3m >/dev/null
}

cleanup() {
	[[ ${cleaned} == true ]] && return
	log "cleaning the isolated FDB/TKE/CBS simulation estate"
	stop_controller >/dev/null 2>&1 || true
	hub delete shardclass "${class}" --ignore-not-found >/dev/null 2>&1 || true
	hub delete rivetcellprofile "${profile}" --ignore-not-found >/dev/null 2>&1 || true
	hub delete machineset.node.tke.cloud.tencent.com "${machine_set}" --ignore-not-found >/dev/null 2>&1 || true
	hub -n "${namespace}" patch rivetcell "${cell}" --type=merge -p '{"metadata":{"finalizers":[]}}' >/dev/null 2>&1 || true
	hub -n "${namespace}" delete pod --all --force --grace-period=0 --wait=false >/dev/null 2>&1 || true
	for pvc in $(hub -n "${namespace}" get pvc -o name 2>/dev/null); do
		hub -n "${namespace}" patch "${pvc}" --type=merge -p '{"metadata":{"finalizers":[]}}' >/dev/null 2>&1 || true
	done
	hub delete namespace "${namespace}" --ignore-not-found --wait=true --timeout=2m >/dev/null 2>&1 || true
	for i in $(seq -w 1 12); do
		hub delete pv "local-fdb-pv-${i}" --ignore-not-found --wait=true --timeout=30s >/dev/null 2>&1 || true
		hub delete node "local-fdb-node-${i}" --ignore-not-found --wait=true --timeout=30s >/dev/null 2>&1 || true
	done
	start_controller >/dev/null 2>&1 || true
	cleaned=true
}
trap cleanup EXIT

operation_name() {
	hub -n "${namespace}" get fdbscaleoperation -o json 2>/dev/null | jq -r '.items[0].metadata.name // empty'
}

operation_phase_is() {
	local name phase
	name=$(operation_name)
	[[ -n ${name} ]] || return 1
	phase=$(hub -n "${namespace}" get fdbscaleoperation "${name}" -o jsonpath='{.status.phase}' 2>/dev/null)
	[[ ${phase} == "$1" ]]
}

operation_created() { [[ -n $(operation_name) ]]; }
operation_scaling() { operation_phase_is Scaling; }
operation_verifying() { operation_phase_is Verifying; }
refresh_backup_report() {
	local now
	now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	hub -n "${namespace}" patch rivetcellreport "${cell}" --type=merge -p \
		"{\"spec\":{\"observedAt\":\"${now}\"}}" >/dev/null 2>&1 || true
}
retirements_created() {
	refresh_backup_report
	[[ $(hub -n "${namespace}" get fdbvolumeretirement -o json 2>/dev/null | jq '.items | length') == 3 ]]
}
capacity_target_published() {
	refresh_backup_report
	[[ $(hub get machineset.node.tke.cloud.tencent.com "${machine_set}" -o jsonpath='{.spec.replicas}' 2>/dev/null) == 9 ]]
}
operation_succeeded() { refresh_backup_report; operation_phase_is Succeeded; }

retirements_quarantined() {
	local body
	body=$(hub -n "${namespace}" get fdbvolumeretirement -o json 2>/dev/null) || return 1
	[[ $(jq '.items | length' <<<"${body}") == 3 && $(jq '[.items[] | select(.status.phase == "Quarantined")] | length' <<<"${body}") == 3 ]]
}

profile_spec=$(python3 -c 'import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read()), separators=(",", ":"), sort_keys=True))' <<'YAML'
driverABI: rivet-fdb-cos-kubernetes-v1
region: local
topology:
  zoneLabelKey: topology.kubernetes.io/zone
  zoneCount: 3
  maxSkew: 1
  whenUnsatisfiable: DoNotSchedule
foundationDB:
  version: 7.3.79
  processCount: 9
  coordinatorCount: 9
  redundancyMode: three_data_hall
  localityKey: data_hall
  storageEngine: ssd-2
  exclusiveCluster: true
  supervisor: foundationdb-kubernetes-operator
  kubernetes:
    operatorVersion: v2.34.0
    imageType: unified
    imageRepository: foundationdb/fdb-kubernetes-monitor
    imageTagDigest: 7.3.79@sha256:45f5b7632984a4835326f45a7bcfd662886db64d82333796ee14cbb3a7537c8c
    storageClassName: actor-fdb-cbs-wffc-retain
    fdbServiceAccountName: fdb-kubernetes
    placementMode: DedicatedNodes
    priorityClassName: actor-fdb-critical
    faultDomainKey: kubernetes.io/hostname
    nodeSelector:
      fleet.actor.dev/fdb-dedicated: "true"
    nodeCapacity:
      provider: TKENativeMachineSet
      machineSetName: np-fdbsim01
      processesPerNode: 1
    resources:
      cpuRequest: "2"
      memoryRequest: 8Gi
      cpuLimit: "2"
      memoryLimit: 8Gi
    tls:
      mode: Required
      secretNameTemplate: "{clusterName}-fdb-tls"
      peerVerificationRules: S.OU=actor-fdb
  autoscaling:
    mode: Automatic
    minProcessCount: 9
    maxProcessCount: 15
    stepProcessCount: 3
    scaleUp:
      headroomBytes: 85899345920
      etaSeconds: 259200
      sustainSeconds: 1800
      cooldownSeconds: 7200
      minimumSamples: 600
    scaleDown:
      headroomBytes: 171798691840
      writeUtilizationPercent: 20
      sustainSeconds: 86400
      cooldownSeconds: 604800
      minimumSamples: 1200
    volumeRetentionSeconds: 2592000
    volumeGCMode: ObserveOnly
  dataDisk:
    type: CLOUD_BSSD
    sizeGiB: 200
    encrypted: false
    retain: true
runtime:
  deploymentMode: kubernetes
  minEngineHosts: 1
  minWorkerdHosts: 1
  localStateDisposable: true
cos:
  coldBucketPrefix: local-fdb-cold-
  backupBucketPrefix: local-fdb-backup-
  multiAZ: false
  versioning: NeverEnabled
  objectKeyLayout: depot-cold-v2
  exactKeyRecovery: true
  listIndependent: true
  inCommitPath: false
capacity:
  healthyWriteUtilizationLimitPercent: 50
  degradedWriteUtilizationLimitPercent: 70
  scaleOutAtPercent: 80
YAML
)
profile_digest="sha256:$(jq -cSj . <<<"${profile_spec}" | sha256sum | awk '{print $1}')"

initial_replicas=$(controller_replicas)
stop_controller

log "installing an isolated 12-process, three-zone FDB estate on the Hub API"
hub apply -f - >/dev/null <<YAML
apiVersion: fleet.actor.dev/v1alpha1
kind: RivetCellProfile
metadata:
  name: ${profile}
spec: ${profile_spec}
---
apiVersion: fleet.actor.dev/v1alpha1
kind: ShardClass
metadata:
  name: ${class}
spec:
  controllerName: fleet.actor.dev/rivet-fdb-cos
  driverABI: rivet-fdb-cos-kubernetes-v1
  profileRef:
    name: ${profile}
    digest: ${profile_digest}
  mobilityPolicy: DriverControlled
  retirementPolicy: ProofRequired
---
apiVersion: v1
kind: Namespace
metadata:
  name: ${namespace}
---
apiVersion: fleet.actor.dev/v1alpha1
kind: RivetCell
metadata:
  name: ${cell}
  namespace: ${namespace}
spec:
  cellId: ${cell}
  className: ${class}
  region: local
  managementCluster: local-fdb-sim
  desiredState: Ready
  foundationDB:
    exclusive: true
    clusterRef:
      name: ${cluster}
      namespace: ${namespace}
  cos:
    coldBucket: local-fdb-cold-${cell}
    backupBucket: local-fdb-backup-${cell}
  retirement:
    generation: 1
    proofRequired: true
    rollbackRetentionSeconds: 604800
---
apiVersion: node.tke.cloud.tencent.com/v1beta1
kind: MachineSet
metadata:
  name: ${machine_set}
spec:
  type: Native
  replicas: 12
  scaling:
    createPolicy: ZoneEquality
    deletePolicy: Newest
    minReplicas: 12
    maxReplicas: 15
  deletePolicy: Newest
  template:
    spec:
      metadata:
        labels:
          fleet.actor.dev/cell-name: ${cell}
          fleet.actor.dev/fdb-dedicated: "true"
YAML

# The API server applies CRD defaults before the controller hashes the stored
# spec. Bind the class to that authoritative representation, not the source
# YAML representation used above.
profile_digest="sha256:$(hub get rivetcellprofile "${profile}" -o json | jq -cSj '.spec' | sha256sum | awk '{print $1}')"
hub patch shardclass "${class}" --type=merge -p \
	"{\"spec\":{\"profileRef\":{\"name\":\"${profile}\",\"digest\":\"${profile_digest}\"}}}" >/dev/null

hub patch machineset.node.tke.cloud.tencent.com "${machine_set}" --subresource=status --type=merge -p \
	'{"status":{"observedGeneration":1,"replicas":12,"readyReplicas":12,"availableReplicas":12}}' >/dev/null

cell_uid=$(hub -n "${namespace}" get rivetcell "${cell}" -o jsonpath='{.metadata.uid}')
hub apply -f - >/dev/null <<YAML
apiVersion: apps.foundationdb.org/v1beta2
kind: FoundationDBCluster
metadata:
  name: ${cluster}
  namespace: ${namespace}
  labels:
    fleet.actor.dev/cell-name: ${cell}
    fleet.actor.dev/cell-namespace: ${namespace}
    fleet.actor.dev/cell-uid: ${cell_uid}
spec:
  version: 7.3.79
  processCounts:
    storage: 12
  databaseConfiguration:
    storage: 12
    redundancy_mode: three_data_hall
    storage_engine: ssd-2
YAML
cluster_uid=$(hub -n "${namespace}" get foundationdbcluster "${cluster}" -o jsonpath='{.metadata.uid}')
cluster_generation=$(hub -n "${namespace}" get foundationdbcluster "${cluster}" -o jsonpath='{.metadata.generation}')
identity_hash="sha256:$(printf 'foundationdb-kubernetes-v1\0%s\0%s' "${cluster_uid}" localfdb | sha256sum | awk '{print $1}')"
hub -n "${namespace}" patch rivetcell "${cell}" --type=merge -p \
	"{\"spec\":{\"foundationDB\":{\"clusterRef\":{\"name\":\"${cluster}\",\"namespace\":\"${namespace}\",\"uid\":\"${cluster_uid}\"},\"clusterIdentityHash\":\"${identity_hash}\"}}}" >/dev/null

hub -n "${namespace}" patch foundationdbcluster "${cluster}" --subresource=status --type=merge -p \
	"{\"status\":{\"generations\":{\"reconciled\":${cluster_generation}},\"desiredProcessGroups\":12,\"reconciledProcessGroups\":12,\"runningVersion\":\"7.3.79\",\"configured\":true,\"connectionString\":\"${connection_string}\",\"health\":{\"available\":true,\"healthy\":true,\"fullReplication\":true}}}" >/dev/null

for n in $(seq 1 12); do
	i=$(printf '%02d' "${n}")
	if (( n <= 4 )); then zone=local-a; elif (( n <= 8 )); then zone=local-b; else zone=local-c; fi
	hub apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Node
metadata:
  name: local-fdb-node-${i}
  labels:
    topology.kubernetes.io/zone: ${zone}
    fleet.actor.dev/cell-name: ${cell}
    fleet.actor.dev/fdb-dedicated: "true"
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: local-fdb-pvc-${i}
  namespace: ${namespace}
  labels:
    foundationdb.org/fdb-cluster-name: ${cluster}
    foundationdb.org/fdb-process-class: storage
    foundationdb.org/fdb-process-group-id: storage-${i}
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: actor-fdb-cbs-wffc-retain
  volumeName: local-fdb-pv-${i}
  resources:
    requests: {storage: 1Gi}
---
apiVersion: v1
kind: Pod
metadata:
  name: local-fdb-storage-${i}
  namespace: ${namespace}
  labels:
    foundationdb.org/fdb-cluster-name: ${cluster}
    foundationdb.org/fdb-process-class: storage
    foundationdb.org/fdb-process-group-id: storage-${i}
spec:
  nodeName: local-fdb-node-${i}
  containers:
    - name: fdb
      image: registry.k8s.io/pause:3.10
YAML
	pvc_uid=$(hub -n "${namespace}" get pvc "local-fdb-pvc-${i}" -o jsonpath='{.metadata.uid}')
	hub apply -f - >/dev/null <<YAML
apiVersion: v1
kind: PersistentVolume
metadata:
  name: local-fdb-pv-${i}
spec:
  capacity: {storage: 1Gi}
  accessModes: [ReadWriteOnce]
  storageClassName: actor-fdb-cbs-wffc-retain
  persistentVolumeReclaimPolicy: Retain
  claimRef:
    namespace: ${namespace}
    name: local-fdb-pvc-${i}
    uid: ${pvc_uid}
  csi:
    driver: com.tencent.cloud.csi.cbs
    volumeHandle: disk-localfdb${i}
YAML
	hub -n "${namespace}" patch pvc "local-fdb-pvc-${i}" --subresource=status --type=merge -p '{"status":{"phase":"Bound"}}' >/dev/null
	hub patch pv "local-fdb-pv-${i}" --subresource=status --type=merge -p '{"status":{"phase":"Bound"}}' >/dev/null
	hub -n "${namespace}" patch pod "local-fdb-storage-${i}" --subresource=status --type=merge -p \
		'{"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True","lastTransitionTime":"2026-01-01T00:00:00Z"}]}}' >/dev/null
done

last_scale_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)
hub -n "${namespace}" patch rivetcell "${cell}" --subresource=status --type=merge -p \
	"{\"status\":{\"foundationDBAutoscaling\":{\"mode\":\"Automatic\",\"phase\":\"ScaleDownRecommended\",\"desiredProcessCount\":9,\"recommendedProcessCount\":9,\"observedProcessCount\":12,\"lastScaleTime\":\"${last_scale_time}\",\"lastScaleDirection\":\"Down\",\"reason\":\"LocalE2E\",\"volumeRetentionSeconds\":2592000,\"volumeGCMode\":\"ObserveOnly\"}}}" >/dev/null

start_controller
wait_until operation_created 120 "production reconciler to create an FDBScaleOperation"
wait_until operation_scaling 120 "production reconciler to publish the 12 -> 9 removal plan"
operation=$(operation_name)
operation_uid=$(hub -n "${namespace}" get fdbscaleoperation "${operation}" -o jsonpath='{.metadata.uid}')
selected_before=$(hub -n "${namespace}" get fdbscaleoperation "${operation}" -o json | jq -c '.spec.selectedProcessGroups')
topology=$(hub -n "${namespace}" get fdbscaleoperation "${operation}" -o json | jq -c '.spec.selectedProcessGroupTopology')
[[ $(jq 'length' <<<"${selected_before}") == 3 ]] || die "scale-down did not select exactly three process groups"
[[ $(jq '[.[].zone] | unique | length' <<<"${topology}") == 3 ]] || die "scale-down plan is not balanced across three zones"
[[ $(hub -n "${namespace}" get foundationdbcluster "${cluster}" -o jsonpath='{.spec.processCounts.storage}') == 9 ]] || die "FDB target was not published"

log "restarting the production controller at the uncertain Scaling boundary"
hub -n "${controller_namespace}" rollout restart deployment/${controller} >/dev/null
hub -n "${controller_namespace}" rollout status deployment/${controller} --timeout=3m >/dev/null
sleep 5
[[ $(hub -n "${namespace}" get fdbscaleoperation "${operation}" -o jsonpath='{.metadata.uid}') == "${operation_uid}" ]] || die "controller restart replaced the operation identity"
[[ $(hub -n "${namespace}" get fdbscaleoperation "${operation}" -o json | jq -c '.spec.selectedProcessGroups') == "${selected_before}" ]] || die "controller restart drifted the removal plan"
[[ $(hub get machineset.node.tke.cloud.tencent.com "${machine_set}" -o jsonpath='{.spec.replicas}') == 12 ]] || die "MachineSet shrank before FDB exclusion and replication completed"

log "simulating FDB Operator exclusion, data movement, and retained CBS release"
for pg in $(jq -r '.[]' <<<"${selected_before}"); do
	i=${pg#storage-}
	hub -n "${namespace}" delete pod "local-fdb-storage-${i}" --wait=false >/dev/null
	hub -n "${namespace}" delete pvc "local-fdb-pvc-${i}" --wait=true >/dev/null
	hub patch pv "local-fdb-pv-${i}" --subresource=status --type=merge -p '{"status":{"phase":"Released"}}' >/dev/null
done
cluster_generation=$(hub -n "${namespace}" get foundationdbcluster "${cluster}" -o jsonpath='{.metadata.generation}')
hub -n "${namespace}" patch foundationdbcluster "${cluster}" --subresource=status --type=merge -p \
	"{\"status\":{\"generations\":{\"reconciled\":${cluster_generation}},\"desiredProcessGroups\":9,\"reconciledProcessGroups\":9,\"runningVersion\":\"7.3.79\",\"configured\":true,\"connectionString\":\"${connection_string}\",\"health\":{\"available\":true,\"healthy\":true,\"fullReplication\":true}}}" >/dev/null
wait_until operation_verifying 120 "a post-target Restorable backup gate"

# Verifying persists targetReadyAt. Publish backup evidence strictly after that
# durable boundary; pre-scale Restorable evidence must never satisfy the gate.
sleep 2
cell_generation=$(hub -n "${namespace}" get rivetcell "${cell}" -o jsonpath='{.metadata.generation}')
observed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
hub apply -f - >/dev/null <<YAML
apiVersion: fleet.actor.dev/v1alpha1
kind: RivetCellReport
metadata:
  name: ${cell}
  namespace: ${namespace}
spec:
  cellRef: {name: ${cell}, uid: ${cell_uid}}
  observedCellGeneration: ${cell_generation}
  observedAt: ${observed_at}
  profileDigest: ${profile_digest}
  foundationDB:
    clusterIdentityHash: ${identity_hash}
    available: true
    healthy: true
    topologyConforming: true
  health:
    runtimeReadyHosts: 1
    backupReady: true
    credentialsReady: true
    correctnessViolation: false
  capacity:
    riskLevel: Normal
    placementCount: 0
    pendingReservations: 0
    activeWriters: 0
    inFlightCommits: 0
    migrationBacklog: 0
    compactionBacklog: 0
    gcBacklog: 0
    reconciliationBacklog: 0
  qualification: {ready: false}
YAML
wait_until retirements_created 120 "retained PV inventory creation"
wait_until capacity_target_published 120 "the TKE capacity reclaim boundary"
[[ $(hub get machineset.node.tke.cloud.tencent.com "${machine_set}" -o jsonpath='{.spec.replicas}') == 9 ]] || die "MachineSet target was not reduced after volume quarantine"
[[ $(hub get machineset.node.tke.cloud.tencent.com "${machine_set}" -o jsonpath='{.status.replicas}') == 12 ]] || die "external TKE simulator moved before its explicit event"

hub patch machineset.node.tke.cloud.tencent.com "${machine_set}" --subresource=status --type=merge -p \
	'{"status":{"observedGeneration":2,"replicas":9,"readyReplicas":9,"availableReplicas":9}}' >/dev/null
wait_until operation_succeeded 120 "the verified FDB scale-down receipt"
wait_until retirements_quarantined 120 "all three exact CBS disks to enter quarantine"

receipt=$(hub -n "${namespace}" get fdbscaleoperation "${operation}" -o json)
[[ $(jq -r '.status.receiptDigest' <<<"${receipt}") == sha256:* ]] || die "operation has no content-addressed receipt"
[[ $(jq -r '.status.nodeCapacity.desiredNodes' <<<"${receipt}") == 9 ]] || die "receipt did not bind the final TKE capacity"
for pg in $(jq -r '.[]' <<<"${selected_before}"); do
	i=${pg#storage-}
	[[ $(hub get pv "local-fdb-pv-${i}" -o jsonpath='{.status.phase}') == Released ]] || die "retained PV ${i} disappeared or left Released quarantine"
done

log "live 12 -> 9 passed: deterministic AZ-balanced drain, restart-safe identity, backup gate, TKE reclaim, and three retained CBS quarantines"
cleanup
if [[ ${initial_replicas} == 0 ]]; then stop_controller; fi
"${MESH_DIR}/verify-federated-placement.sh"
