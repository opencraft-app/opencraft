#!/usr/bin/env bash
set -euo pipefail
umask 077

CONTROL_URL=${LLMGATEWAY_REGRESSION_CONTROL_URL:-}
ADMIN_TOKEN=${LLMGATEWAY_REGRESSION_ADMIN_TOKEN:-}
TARGET_SETS=${LLMGATEWAY_REGRESSION_TARGET_SETS:-}
PACER_URL=${LLMGATEWAY_REGRESSION_PACER_URL:-http://llmgateway-regression-pacer:18082}
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

if [[ -z "$CONTROL_URL" || -z "$ADMIN_TOKEN" || -z "$TARGET_SETS" ]]; then
  echo "LLMGATEWAY_REGRESSION_CONTROL_URL, LLMGATEWAY_REGRESSION_ADMIN_TOKEN and LLMGATEWAY_REGRESSION_TARGET_SETS are required" >&2
  exit 2
fi

secure_curl() {
  printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_TOKEN" \
    | curl --silent --show-error --fail-with-body --config - "$@"
}

secure_curl "$CONTROL_URL/api/channel-bundles" --output "$TMP_DIR/bundles.json"
secure_curl "$CONTROL_URL/api/sets" --output "$TMP_DIR/sets.json"

python3 - "$TMP_DIR" "$PACER_URL" "$TARGET_SETS" <<'PY'
import copy, json, sys
from pathlib import Path
out, pacer, sets = Path(sys.argv[1]), sys.argv[2].rstrip("/"), [v.strip() for v in sys.argv[3].split(",") if v.strip()]
bundles = json.loads((out / "bundles.json").read_text()).get("data", [])
golden = next((bundle for bundle in bundles if bundle.get("id") == "golden-channels"), None)
if golden is None:
    raise SystemExit('golden channel bundle "golden-channels" is required')
golden_spec = copy.deepcopy(golden.get("spec", {}))
golden_options = copy.deepcopy(golden_spec.get("options", []))
for key in ("CompletionRatio", "ModelRatio"):
    option = next((item for item in golden_options if item.get("key") == key), None)
    if option is None:
        raise SystemExit(f'golden channel bundle is missing {key}')
    value = option.get("value")
    values = json.loads(value) if isinstance(value, str) else dict(value or {})
    values["llmgw-regression-chat"] = 1
    values["llmgw-regression-long"] = 1
    values["llmgw-regression-upgrade-probe"] = 1
    option["value"] = json.dumps(values, separators=(",", ":"), sort_keys=True)
golden_spec["options"] = golden_options
(out / "golden.json").write_text(json.dumps({
    "id": golden["id"], "name": golden.get("name") or "Golden channels",
    "description": golden.get("description", ""), "source_set_id": golden.get("source_set_id", ""),
    "spec": golden_spec,
}))

managed_sets = json.loads((out / "sets.json").read_text()).get("data", [])
eligible = {
    item.get("id") for item in managed_sets
    if item.get("status") == "active" and item.get("setup") is True and int(item.get("admin_user_id") or 0) > 0
}
eligible.update(sets)
set_ids = sorted(item for item in eligible if item)
if not set_ids:
    raise SystemExit("no active managed Sets are available for regression bootstrap")
(out / "plan.json").write_text(json.dumps({
    "id": "regression-monthly", "name": "预发布回归月套餐", "monthly_tokens": 1000000000,
    "period_value": 1, "period_unit": "months", "is_active": True,
}))
(out / "bundle.json").write_text(json.dumps({
    "id": "regression-mock-channel", "name": "预发布回归渠道", "description": "稳定 mockllm 回归渠道；全局定价由 golden-channels 唯一管理",
    "spec": {"version": 1, "kind": "newapi-channel-bundle", "channels": [{
        "id": "regression-mock", "name": "LLMGateway Regression Mock", "type": 1,
        "key": "sk-regression-mock", "base_url": pacer,
        "models": "llmgw-regression-chat,llmgw-regression-long,llmgw-regression-upgrade-probe", "group": "default",
        "model_mapping": json.dumps({"llmgw-regression-chat": "llmgw-mock-chat", "llmgw-regression-long": "llmgw-regression-long", "llmgw-regression-upgrade-probe": "llmgw-regression-upgrade-probe"}, separators=(",", ":")),
        "priority": 0, "weight": 100, "status": "enabled", "remark": "llmgateway regression fixture",
    }]},
}))
(out / "sync.json").write_text(json.dumps({"set_ids": set_ids}))
(out / "set-ids.txt").write_text("".join(f"{set_id}\n" for set_id in set_ids))
PY

call_control() {
  method=$1
  path=$2
  body=$3
  output=${4:-/dev/null}
  secure_curl --request "$method" "$CONTROL_URL$path" \
    --header 'Content-Type: application/json' --data-binary "@$body" --output "$output"
}

call_control POST /api/plans "$TMP_DIR/plan.json"
call_control POST /api/channel-bundles "$TMP_DIR/bundle.json"
call_control POST /api/channel-bundles "$TMP_DIR/golden.json"
call_control POST /api/plans/regression-monthly/sync "$TMP_DIR/sync.json"

while IFS= read -r set_id; do
  python3 - "$TMP_DIR/apply.json" "$set_id" <<'PY'
import json, sys
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps({"set_id": sys.argv[2], "force_drift": False}))
PY
  call_control POST /api/channel-bundles/golden-channels/apply "$TMP_DIR/apply.json" "$TMP_DIR/golden-apply-response.json"
  call_control POST /api/channel-bundles/regression-mock-channel/apply "$TMP_DIR/apply.json" "$TMP_DIR/apply-response.json"
  python3 - "$TMP_DIR/golden-apply-response.json" "$TMP_DIR/apply-response.json" "$set_id" <<'PY'
import json, sys
from pathlib import Path
for response_path, label in ((sys.argv[1], "golden desired config"), (sys.argv[2], "regression channel")):
    response = json.loads(Path(response_path).read_text())
    status = response.get("data", {}).get("status")
    if status not in {"synced", "skipped"}:
        raise SystemExit(f'{label} sync for Set {sys.argv[3]} returned {status!r}')
PY
done < "$TMP_DIR/set-ids.txt"

echo "Regression Plan, golden pricing and dedicated channel fixture are synchronized to every active managed Set."
