#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
	exec "$script_dir/with-autonomy-operation-lock.sh" -- "$0" "$@"
fi

service_src=$script_dir/systemd/autonomy-audit-control.service
timer_src=$script_dir/systemd/autonomy-audit-control.timer
entrypoint_src=$script_dir/autonomy-reviewed-source-entrypoint.sh
cell=${CELL:?CELL must name the exact Cell}
cell_namespace=${CELL_NAMESPACE:-actor-fdb-cell-system}
kubeconfig=${KUBECONFIG_PATH:?KUBECONFIG_PATH must name the exact Cell kubeconfig}
qualification_mode=${AUTONOMY_QUALIFICATION_MODE:-standalone}
auto_publish_qualification=${AUTONOMY_AUTO_PUBLISH_QUALIFICATION:-0}
prom_namespace=${PROM_NAMESPACE:-observability}
prom_service=${PROM_SERVICE:-actor-observability-prometheus}
engine_metrics_service=${ENGINE_METRICS_SERVICE:-actor-fleet-engine-metrics}
runtime_metrics_service=${RUNTIME_METRICS_SERVICE:-${cell}-runtime-hosts}
runtime_receipts_dir=${RUNTIME_RECEIPTS_DIR:-/data/actor-qualification/receipts}
release_receipts_dir=${RELEASE_RECEIPTS_DIR:-$runtime_receipts_dir}
dr_receipts_dir=${DR_RECEIPTS_DIR:-/data/actor-qualification/receipts}
audit_receipt_dir=${AUTONOMY_AUDIT_RECEIPT_DIR:-/var/lib/actor/autonomy/receipts}
control_output_dir=${AUTONOMY_CONTROL_OUTPUT_DIR:-/var/lib/actor/autonomy/decisions}
reviewed_source_link=${AUTONOMY_REVIEWED_SOURCE_LINK:?AUTONOMY_REVIEWED_SOURCE_LINK must name the atomically promoted source symlink}

[[ $cell =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || {
	echo "CELL is not a DNS-safe Cell identity: $cell" >&2
	exit 2
}
[[ $cell_namespace =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || {
	echo "CELL_NAMESPACE is not DNS-safe: $cell_namespace" >&2
	exit 2
}
for name in "$prom_namespace" "$prom_service" "$engine_metrics_service" "$runtime_metrics_service"; do
	[[ $name =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || {
		echo "autonomy Kubernetes identity is not DNS-safe: $name" >&2
		exit 2
	}
done
[[ $qualification_mode == standalone || $qualification_mode == initial-cell || $qualification_mode == autoscaling-cell ]] || {
	echo "AUTONOMY_QUALIFICATION_MODE must be standalone, initial-cell, or autoscaling-cell" >&2
	exit 2
}
[[ $auto_publish_qualification == 0 || $auto_publish_qualification == 1 ]] || {
	echo "AUTONOMY_AUTO_PUBLISH_QUALIFICATION must be 0 or 1" >&2
	exit 2
}
for path in "$kubeconfig" "$runtime_receipts_dir" "$release_receipts_dir" "$dr_receipts_dir" \
	"$audit_receipt_dir" "$control_output_dir" "$reviewed_source_link"; do
	[[ $path =~ ^/[A-Za-z0-9._/-]+$ ]] || {
		echo "autonomy path must use the safe absolute path alphabet: $path" >&2
		exit 2
	}
done
[[ -f $kubeconfig ]] || { echo "Cell kubeconfig does not exist: $kubeconfig" >&2; exit 2; }
kubeconfig=$(readlink -e "$kubeconfig")
[[ -L $reviewed_source_link ]] || { echo "reviewed source path is not a symlink: $reviewed_source_link" >&2; exit 2; }
reviewed_source=$(readlink -e "$reviewed_source_link")
installer_source=$(readlink -e "$script_dir/../../../../../..")
[[ -n $reviewed_source && $reviewed_source == "$installer_source" ]] || {
	echo "installer must execute from the currently promoted reviewed source" >&2
	exit 2
}
reviewed_source_name=${reviewed_source##*/}
[[ $reviewed_source_name =~ ^[a-z0-9-]+-src-([0-9a-f]{40})-([0-9a-f]{64})$ ]] || {
	echo "reviewed source has no immutable identity: $reviewed_source" >&2
	exit 2
}
reviewed_source_revision=${BASH_REMATCH[1]}
reviewed_source_manifest=${BASH_REMATCH[2]}
[[ -f $service_src && -f $timer_src && -x $entrypoint_src \
	&& -x $script_dir/hydrate-qualification-receipts.sh ]] || {
	echo "autonomy systemd source is incomplete under $fleet_root" >&2
	exit 2
}

install -d -m 0755 /etc/actor /etc/systemd/system /usr/local/libexec
install -d -m 0700 "$audit_receipt_dir" "$control_output_dir"
install -d -m 0750 "$runtime_receipts_dir" "$release_receipts_dir" "$dr_receipts_dir"
install -m 0644 "$service_src" /etc/systemd/system/autonomy-audit-control.service
install -m 0644 "$timer_src" /etc/systemd/system/autonomy-audit-control.timer
install -m 0755 "$entrypoint_src" /usr/local/libexec/actor-autonomy-reviewed-source-entrypoint

temporary=$(mktemp /etc/actor/rivet-autonomy-audit.env.XXXXXX)
cleanup() { rm -f -- "$temporary"; }
trap cleanup EXIT INT TERM
cat >"$temporary" <<ENVEOF
CELL=$cell
CELL_NAMESPACE=$cell_namespace
CLUSTER_PREFIX=$cell
PROM_NAMESPACE=$prom_namespace
PROM_SERVICE=$prom_service
ENGINE_METRICS_SERVICE=$engine_metrics_service
RUNTIME_METRICS_SERVICE=$runtime_metrics_service
AUTONOMY_REVIEWED_SOURCE_LINK=$reviewed_source_link
AUTONOMY_AUDIT_RECEIPT_DIR=$audit_receipt_dir
AUTONOMY_CONTROL_OUTPUT_DIR=$control_output_dir
AUTONOMY_QUALIFICATION_MODE=$qualification_mode
AUTONOMY_AUTO_PUBLISH_QUALIFICATION=$auto_publish_qualification
RUNTIME_RECEIPTS_DIR=$runtime_receipts_dir
RELEASE_RECEIPTS_DIR=$release_receipts_dir
DR_RECEIPTS_DIR=$dr_receipts_dir
KUBECONFIG_PATH=$kubeconfig
ENVEOF
chmod 0600 "$temporary"
mv -Tf "$temporary" /etc/actor/rivet-autonomy-audit.env
trap - EXIT INT TERM

systemctl daemon-reload
systemctl enable autonomy-audit-control.timer >/dev/null
# Run once synchronously so a wrong Cell, kubeconfig, receipt root, or source
# tree fails during installation instead of five minutes later. The installer
# already owns the Cell operation lock; invoking the reviewed entrypoint in
# this process preserves that lock FD. Starting the systemd service here would
# create a new process that cannot inherit the FD and must correctly refuse the
# nested lock acquisition.
started_epoch=$(date +%s)
set -a
# shellcheck disable=SC1091
source /etc/actor/rivet-autonomy-audit.env
set +a
set +e
AUTONOMY_OPERATION_LOCK_HELD=1 \
	/usr/local/libexec/actor-autonomy-reviewed-source-entrypoint
initial_control_status=$?
set -e
# Governance exit 1/2 is an intentional degraded/block decision. The fresh,
# source-bound receipt below is the proof that execution was valid; a Cell
# awaiting qualification must still keep its timer active so it can converge
# automatically when evidence arrives.
((initial_control_status == 0 || initial_control_status == 1 || initial_control_status == 2)) || {
	echo "initial autonomy governance returned an invalid status: $initial_control_status" >&2
	exit 1
}
systemctl restart autonomy-audit-control.timer
systemctl is-enabled --quiet autonomy-audit-control.timer
systemctl is-active --quiet autonomy-audit-control.timer

latest=$(find "$control_output_dir" -maxdepth 1 -type f -name "autonomy-control-${cell}-*.json" \
	-newermt "@$started_epoch" -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)
[[ -n $latest && -s $latest ]] || {
	echo "autonomy installation did not produce a fresh control receipt for $cell" >&2
	exit 1
}
python3 - "$latest" "$cell" "$cell_namespace" "$reviewed_source_revision" \
	"$reviewed_source_manifest" "$reviewed_source" <<'PY'
import json
import sys

path, cell, namespace, revision, manifest, target = sys.argv[1:]
payload = json.load(open(path))
if payload.get("cell") != cell or payload.get("namespace") != namespace:
    raise SystemExit("fresh autonomy receipt is bound to the wrong Cell")
if payload.get("sourceIdentity") != {
    "revision": revision,
    "manifest_sha256": manifest,
    "target": target,
}:
    raise SystemExit("fresh autonomy receipt is not bound to the installed reviewed source")
print("autonomy_systemd_install=passed cell={} control={} receipt={}".format(
    cell, payload.get("control"), path
))
PY
