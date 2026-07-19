#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
REGRESSION_DIR="$ROOT_DIR/test/regression"
NAMESPACE=${LLMGATEWAY_REGRESSION_NAMESPACE:-llmgateway}
IMAGE=${LLMGATEWAY_REGRESSION_IMAGE:-}
TARGET_SETS=${LLMGATEWAY_REGRESSION_TARGET_SETS:-}
SCENARIO=${LLMGATEWAY_REGRESSION_SCENARIO:-preprod_release_gate}
CONTROL_URL=${LLMGATEWAY_REGRESSION_CONTROL_URL:-http://llmgateway-control}
TRAFFIC_URL=${LLMGATEWAY_REGRESSION_TRAFFIC_URL:-http://llmgateway-traffic}
PLAN_ID=${LLMGATEWAY_REGRESSION_PLAN_ID:-regression-monthly}
CHANNEL_BUNDLE_ID=${LLMGATEWAY_REGRESSION_CHANNEL_BUNDLE_ID:-regression-mock-channel}
PRICING_BUNDLE_ID=${LLMGATEWAY_REGRESSION_PRICING_BUNDLE_ID:-golden-channels}
MODEL=${LLMGATEWAY_REGRESSION_MODEL:-llmgw-regression-chat}
LONG_STREAM_MODEL=${LLMGATEWAY_REGRESSION_LONG_MODEL:-llmgw-regression-long}
MARKER=${LLMGATEWAY_REGRESSION_MARKER:-cloud regression answer}
SSE_DURATION=${LLMGATEWAY_REGRESSION_SSE_DURATION:-3m}
PINNED_STREAM_HEADROOM=${LLMGATEWAY_REGRESSION_PINNED_STREAM_HEADROOM:-30s}
REQUEST_INTERVAL=${LLMGATEWAY_REGRESSION_REQUEST_INTERVAL:-1s}
ROLLOUT_TIMEOUT=${LLMGATEWAY_REGRESSION_ROLLOUT_TIMEOUT:-15m}
TARGET_RELEASE_ID=${LLMGATEWAY_REGRESSION_TARGET_RELEASE_ID:-}
EXPECTED_RINGS=${LLMGATEWAY_REGRESSION_EXPECTED_RINGS:-}
CAMPAIGN_TIMEOUT=${LLMGATEWAY_REGRESSION_CAMPAIGN_TIMEOUT:-45m}
CAMPAIGN_POLL_INTERVAL=${LLMGATEWAY_REGRESSION_CAMPAIGN_POLL_INTERVAL:-2s}
CAMPAIGN_REQUEST_INTERVAL=${LLMGATEWAY_REGRESSION_CAMPAIGN_REQUEST_INTERVAL:-1s}
CAMPAIGN_MIN_SAMPLES=${LLMGATEWAY_REGRESSION_CAMPAIGN_MIN_SAMPLES:-30}
TARGET_IMAGE=${LLMGATEWAY_REGRESSION_TARGET_IMAGE:-}
UPGRADE_SOURCE=${LLMGATEWAY_REGRESSION_UPGRADE_SOURCE:-prod}
UPGRADE_FLEET=${LLMGATEWAY_REGRESSION_UPGRADE_FLEET:-prod}
MANAGER_CRONJOB=${LLMGATEWAY_REGRESSION_MANAGER_CRONJOB:-llmgateway-set-manager}
UPGRADE_PROBE_MODEL=${LLMGATEWAY_REGRESSION_UPGRADE_PROBE_MODEL:-llmgw-regression-upgrade-probe}
DISRUPTION_TIMEOUT=${LLMGATEWAY_REGRESSION_DISRUPTION_TIMEOUT:-20m}
UPGRADE_DRAIN_TIMEOUT=${LLMGATEWAY_REGRESSION_UPGRADE_DRAIN_TIMEOUT:-15s}
UPGRADE_ROLLBACK_WINDOW=${LLMGATEWAY_REGRESSION_UPGRADE_ROLLBACK_WINDOW:-60s}
DISRUPTION_POLL_INTERVAL=${LLMGATEWAY_REGRESSION_DISRUPTION_POLL_INTERVAL:-200ms}
OUTAGE_CONTROL_DEPLOYMENT=${LLMGATEWAY_REGRESSION_OUTAGE_CONTROL_DEPLOYMENT:-llmgateway-control}
OUTAGE_WORKER_DEPLOYMENTS=${LLMGATEWAY_REGRESSION_OUTAGE_WORKER_DEPLOYMENTS:-llmgateway-worker-admin,llmgateway-worker-byok,llmgateway-worker-core,llmgateway-worker-maintenance,llmgateway-worker-observer}
OUTAGE_MANAGER_CRONJOB=${LLMGATEWAY_REGRESSION_OUTAGE_MANAGER_CRONJOB:-llmgateway-set-manager}
OUTAGE_BACKLOG_JOB=${LLMGATEWAY_REGRESSION_OUTAGE_BACKLOG_JOB:-refresh_set_capacity}
OUTAGE_DURATION=${LLMGATEWAY_REGRESSION_OUTAGE_DURATION:-90s}
OUTAGE_TRAFFIC_INTERVAL=${LLMGATEWAY_REGRESSION_OUTAGE_TRAFFIC_INTERVAL:-1s}
OUTAGE_MIN_SAMPLES=${LLMGATEWAY_REGRESSION_OUTAGE_MIN_SAMPLES:-60}
OUTAGE_RECOVERY_TIMEOUT=${LLMGATEWAY_REGRESSION_OUTAGE_RECOVERY_TIMEOUT:-5m}
JOB_ACTIVE_DEADLINE_SECONDS=${LLMGATEWAY_REGRESSION_JOB_ACTIVE_DEADLINE_SECONDS:-3600}
PACER_UPSTREAM=${LLMGATEWAY_REGRESSION_PACER_UPSTREAM:-http://cloud-mockllm:8080}
MOCK_URL=${LLMGATEWAY_REGRESSION_MOCK_URL:-$PACER_UPSTREAM}
RUN_ID=${LLMGATEWAY_REGRESSION_RUN_ID:-$(date -u +%Y%m%dt%H%M%Sz)-$(openssl rand -hex 4)}
ARTIFACT_DIR=${LLMGATEWAY_REGRESSION_ARTIFACT_DIR:-$ROOT_DIR/artifacts/regression/$RUN_ID}
TMP_DIR=$(mktemp -d)

cleanup_tmp() { rm -rf "$TMP_DIR"; }
trap cleanup_tmp EXIT

if [[ -z "$IMAGE" ]]; then
  echo "LLMGATEWAY_REGRESSION_IMAGE is required" >&2
  exit 2
fi
if [[ -z "$TARGET_SETS" ]]; then
  echo "LLMGATEWAY_REGRESSION_TARGET_SETS is required (comma-separated Set IDs)" >&2
  exit 2
fi
MANAGER_IMAGE=$IMAGE
SERVICE_ACCOUNT=llmgateway-regression-runner
if [[ "$SCENARIO" == "set_upgrade_rollback_gate" || "$SCENARIO" == "set_manager_takeover_gate" || "$SCENARIO" == "control_plane_outage_gate" ]]; then
  SERVICE_ACCOUNT=llmgateway-regression-disruptive
  if [[ "$SCENARIO" != "control_plane_outage_gate" && -z "$TARGET_IMAGE" ]]; then
    echo "LLMGATEWAY_REGRESSION_TARGET_IMAGE is required for disruptive scenarios and must use @sha256" >&2
    exit 2
  fi
  if [[ ! "$IMAGE" =~ @sha256:[0-9a-fA-F]{64}$ ]]; then
    echo "LLMGATEWAY_REGRESSION_IMAGE must be pinned by @sha256 for disruptive scenarios" >&2
    exit 2
  fi
fi

export NAMESPACE LLMGATEWAY_IMAGE="$IMAGE" RUN_ID TARGET_SETS SCENARIO CONTROL_URL TRAFFIC_URL
export PLAN_ID CHANNEL_BUNDLE_ID PRICING_BUNDLE_ID MODEL LONG_STREAM_MODEL MARKER SSE_DURATION PINNED_STREAM_HEADROOM REQUEST_INTERVAL ROLLOUT_TIMEOUT PACER_UPSTREAM MOCK_URL
export TARGET_RELEASE_ID EXPECTED_RINGS CAMPAIGN_TIMEOUT CAMPAIGN_POLL_INTERVAL CAMPAIGN_REQUEST_INTERVAL CAMPAIGN_MIN_SAMPLES JOB_ACTIVE_DEADLINE_SECONDS
export TARGET_IMAGE UPGRADE_SOURCE UPGRADE_FLEET MANAGER_CRONJOB MANAGER_IMAGE UPGRADE_PROBE_MODEL DISRUPTION_TIMEOUT UPGRADE_DRAIN_TIMEOUT UPGRADE_ROLLBACK_WINDOW DISRUPTION_POLL_INTERVAL SERVICE_ACCOUNT
export OUTAGE_CONTROL_DEPLOYMENT OUTAGE_WORKER_DEPLOYMENTS OUTAGE_MANAGER_CRONJOB OUTAGE_BACKLOG_JOB OUTAGE_DURATION OUTAGE_TRAFFIC_INTERVAL OUTAGE_MIN_SAMPLES OUTAGE_RECOVERY_TIMEOUT

python3 - "$REGRESSION_DIR/manifests/infrastructure.yaml" "$TMP_DIR/infrastructure.yaml" <<'PY'
import json, os, re, sys
from pathlib import Path
if not re.fullmatch(r"[a-z0-9](?:[-a-z0-9]*[a-z0-9])?", os.environ["RUN_ID"]) or len(os.environ["RUN_ID"]) > 48:
    raise SystemExit("LLMGATEWAY_REGRESSION_RUN_ID must be a lowercase Kubernetes label of at most 48 characters")
content = Path(sys.argv[1]).read_text()
for key in ("NAMESPACE", "LLMGATEWAY_IMAGE", "PACER_UPSTREAM", "SSE_DURATION", "LONG_STREAM_MODEL"):
    content = content.replace("${" + key + "}", json.dumps(os.environ[key]))
Path(sys.argv[2]).write_text(content)
PY

if [[ "$SERVICE_ACCOUNT" == "llmgateway-regression-disruptive" ]]; then
  python3 - "$REGRESSION_DIR/manifests/disruptive-rbac.yaml" "$TMP_DIR/disruptive-rbac.yaml" <<'PY'
import json, os, sys
from pathlib import Path
content = Path(sys.argv[1]).read_text().replace("${NAMESPACE}", json.dumps(os.environ["NAMESPACE"]))
Path(sys.argv[2]).write_text(content)
PY
fi

python3 - "$REGRESSION_DIR/manifests/job.yaml.template" "$TMP_DIR/job.yaml" <<'PY'
import json, os, sys
from pathlib import Path
content = Path(sys.argv[1]).read_text()
values = {
    "RUN_ID": os.environ["RUN_ID"],
    "NAMESPACE": os.environ["NAMESPACE"],
    "LLMGATEWAY_IMAGE": os.environ["LLMGATEWAY_IMAGE"],
    "TARGET_SETS_JSON": json.dumps([v.strip() for v in os.environ["TARGET_SETS"].split(",") if v.strip()]),
    "EXPECTED_RINGS_JSON": json.dumps([v.strip() for v in os.environ["EXPECTED_RINGS"].split(",") if v.strip()]),
    "CAMPAIGN_MIN_SAMPLES": os.environ["CAMPAIGN_MIN_SAMPLES"],
    "JOB_ACTIVE_DEADLINE_SECONDS": os.environ["JOB_ACTIVE_DEADLINE_SECONDS"],
    "SERVICE_ACCOUNT": os.environ["SERVICE_ACCOUNT"],
    "OUTAGE_WORKER_DEPLOYMENTS_JSON": json.dumps([v.strip() for v in os.environ["OUTAGE_WORKER_DEPLOYMENTS"].split(",") if v.strip()]),
}
for key in ("SCENARIO", "CONTROL_URL", "TRAFFIC_URL", "MOCK_URL", "PLAN_ID", "CHANNEL_BUNDLE_ID", "PRICING_BUNDLE_ID", "MODEL", "LONG_STREAM_MODEL", "MARKER", "SSE_DURATION", "PINNED_STREAM_HEADROOM", "REQUEST_INTERVAL", "ROLLOUT_TIMEOUT", "TARGET_RELEASE_ID", "CAMPAIGN_TIMEOUT", "CAMPAIGN_POLL_INTERVAL", "CAMPAIGN_REQUEST_INTERVAL", "TARGET_IMAGE", "UPGRADE_SOURCE", "UPGRADE_FLEET", "MANAGER_CRONJOB", "MANAGER_IMAGE", "UPGRADE_PROBE_MODEL", "DISRUPTION_TIMEOUT", "UPGRADE_DRAIN_TIMEOUT", "UPGRADE_ROLLBACK_WINDOW", "DISRUPTION_POLL_INTERVAL", "OUTAGE_CONTROL_DEPLOYMENT", "OUTAGE_MANAGER_CRONJOB", "OUTAGE_BACKLOG_JOB", "OUTAGE_DURATION", "OUTAGE_TRAFFIC_INTERVAL", "OUTAGE_RECOVERY_TIMEOUT"):
    values[key] = json.dumps(os.environ[key])
values["LLMGATEWAY_IMAGE"] = json.dumps(values["LLMGATEWAY_IMAGE"])
values["OUTAGE_MIN_SAMPLES"] = os.environ["OUTAGE_MIN_SAMPLES"]
for key, value in values.items():
    content = content.replace("${" + key + "}", value)
if "${" in content:
    raise SystemExit("unresolved regression manifest placeholder")
Path(sys.argv[2]).write_text(content)
PY

echo "Regression target: context=$(kubectl config current-context) namespace=$NAMESPACE scenario=$SCENARIO deployment=llmgateway-traffic sets=$TARGET_SETS"
kubectl apply -f "$TMP_DIR/infrastructure.yaml"
if [[ -f "$TMP_DIR/disruptive-rbac.yaml" ]]; then kubectl apply -f "$TMP_DIR/disruptive-rbac.yaml"; fi
kubectl -n "$NAMESPACE" rollout status deployment/llmgateway-regression-pacer --timeout=180s
kubectl apply -f "$TMP_DIR/job.yaml"

JOB="llmgateway-regression-$RUN_ID"
deadline=$((SECONDS + JOB_ACTIVE_DEADLINE_SECONDS))
status=running
while (( SECONDS < deadline )); do
  succeeded=$(kubectl -n "$NAMESPACE" get job "$JOB" -o jsonpath='{.status.succeeded}' 2>/dev/null || true)
  failed=$(kubectl -n "$NAMESPACE" get job "$JOB" -o jsonpath='{.status.failed}' 2>/dev/null || true)
  if [[ "$succeeded" == "1" ]]; then status=succeeded; break; fi
  if [[ -n "$failed" && "$failed" != "0" ]]; then status=failed; break; fi
  sleep 5
done
if [[ "$status" == "running" ]]; then status=timeout; fi

mkdir -p "$ARTIFACT_DIR"
kubectl -n "$NAMESPACE" logs "job/$JOB" > "$ARTIFACT_DIR/job.log" 2>&1 || true
REPORT="llmgateway-regression-report-$RUN_ID"
if kubectl -n "$NAMESPACE" get configmap "$REPORT" -o json > "$TMP_DIR/report-configmap.json" 2>/dev/null; then
  python3 - "$TMP_DIR/report-configmap.json" "$ARTIFACT_DIR" <<'PY'
import hashlib, json, sys
from pathlib import Path
doc = json.loads(Path(sys.argv[1]).read_text())
data = doc.get("data", {})
report = data.get("report.json", "")
junit = data.get("junit.xml", "")
actual = hashlib.sha256(report.encode() + b"\0" + junit.encode()).hexdigest()
expected = doc.get("metadata", {}).get("annotations", {}).get("llmgateway.io/report-sha256", "")
if not expected or actual != expected:
    raise SystemExit(f"report hash mismatch expected={expected} actual={actual}")
out = Path(sys.argv[2])
(out / "report.json").write_text(report)
(out / "junit.xml").write_text(junit)
(out / "sha256").write_text(actual + "\n")
PY
fi

if [[ "$status" == "succeeded" && -s "$ARTIFACT_DIR/report.json" ]]; then
  kubectl -n "$NAMESPACE" delete "job/$JOB" "configmap/llmgateway-regression-config-$RUN_ID" "configmap/$REPORT" --ignore-not-found
  echo "Regression passed. Artifacts: $ARTIFACT_DIR"
  exit 0
fi

echo "Regression $status. Job, report and run-created business resources were preserved. Artifacts: $ARTIFACT_DIR" >&2
exit 1
