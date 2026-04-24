#!/usr/bin/env bash

set -euo pipefail

kd_log_info() { echo "INFO: $*"; }
kd_log_error() { echo "ERROR: $*" >&2; }

kd_kustomize() {
  kubectl kustomize --load-restrictor=LoadRestrictionsNone "$@"
}

kd_require_commands() {
  local missing=0
  local cmd
  for cmd in "$@"; do
    if ! command -v "${cmd}" >/dev/null 2>&1; then
      kd_log_error "missing required command: ${cmd}"
      missing=1
    fi
  done
  if [[ "${missing}" -ne 0 ]]; then
    return 1
  fi
}

kd_require_overlay_dir() {
  local overlay_dir="$1"
  local service_name="$2"
  if [[ ! -d "${overlay_dir}" ]]; then
    kd_log_error "missing ${service_name} kustomize overlay: ${overlay_dir}"
    return 1
  fi
}

kd_require_file() {
  local file_path="$1"
  local guidance="${2:-}"
  if [[ ! -f "${file_path}" ]]; then
    kd_log_error "missing ${file_path}"
    if [[ -n "${guidance}" ]]; then
      kd_log_error "${guidance}"
    fi
    return 1
  fi
}

kd_require_value() {
  local name="$1"
  local value="$2"
  if [[ -z "${value}" ]]; then
    kd_log_error "missing required value: ${name}"
    return 1
  fi
}

kd_cluster_supports_monitoring_crds() {
  kubectl get crd servicemonitors.monitoring.coreos.com >/dev/null 2>&1 &&
    kubectl get crd podmonitors.monitoring.coreos.com >/dev/null 2>&1
}

kd_build_kustomize_output() {
  local overlay_dir="$1"
  local build_output_var="$2"
  local build_output
  build_output="$(mktemp "${TMPDIR:-/tmp}/kustomize-build.XXXXXX")"
  kd_kustomize "${overlay_dir}" > "${build_output}"
  printf -v "${build_output_var}" '%s' "${build_output}"
}

kd_prepare_apply_manifest() {
  local build_output="$1"
  local apply_output_var="$2"
  local resource_label="${3:-resources}"
  local apply_output

  printf -v "${apply_output_var}" '%s' "${build_output}"
  if kd_cluster_supports_monitoring_crds; then
    return 0
  fi

  kd_log_info "target cluster has no ServiceMonitor/PodMonitor CRDs; skipping monitoring.coreos.com ${resource_label}"
  apply_output="$(mktemp "${TMPDIR:-/tmp}/kustomize-apply.XXXXXX")"
  python3 - "${build_output}" "${apply_output}" <<'PY'
import sys
from pathlib import Path
import yaml

src = Path(sys.argv[1])
dst = Path(sys.argv[2])
docs = list(yaml.safe_load_all(src.read_text()))
filtered = []
for doc in docs:
    if not doc:
        continue
    if doc.get("apiVersion") == "monitoring.coreos.com/v1" and doc.get("kind") in {"ServiceMonitor", "PodMonitor"}:
        continue
    filtered.append(doc)

with dst.open("w") as fh:
    yaml.safe_dump_all(filtered, fh, sort_keys=False)
PY
  printf -v "${apply_output_var}" '%s' "${apply_output}"
}

kd_apply_manifest_with_eof_fallback() {
  local manifest_path="$1"
  local service_name="$2"
  local apply_err

  apply_err="$(mktemp "${TMPDIR:-/tmp}/${service_name}-kubectl-apply.XXXXXX")"
  if kubectl apply -f "${manifest_path}" 2> >(tee "${apply_err}" >&2); then
    rm -f "${apply_err}"
    return 0
  fi
  if rg -q 'failed to download openapi: .*EOF' "${apply_err}"; then
    kd_log_info "retrying ${service_name} apply without client-side OpenAPI validation"
    kubectl apply --validate=false -f "${manifest_path}"
    rm -f "${apply_err}"
    return 0
  fi
  rm -f "${apply_err}"
  return 1
}

kd_apply_overlay_with_eof_fallback() {
  local overlay_dir="$1"
  local service_name="$2"
  local apply_err

  apply_err="$(mktemp "${TMPDIR:-/tmp}/${service_name}-kubectl-apply.XXXXXX")"
  if kubectl apply -k "${overlay_dir}" 2> >(tee "${apply_err}" >&2); then
    rm -f "${apply_err}"
    return 0
  fi
  if rg -q 'failed to download openapi: .*EOF' "${apply_err}"; then
    kd_log_info "retrying ${service_name} apply without client-side OpenAPI validation"
    kd_kustomize "${overlay_dir}" | kubectl apply --validate=false -f -
    rm -f "${apply_err}"
    return 0
  fi
  rm -f "${apply_err}"
  return 1
}
