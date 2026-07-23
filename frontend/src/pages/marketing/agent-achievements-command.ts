export const JSON_START = "__LIGHTVELA_ACHIEVEMENTS_JSON_START__";
export const JSON_END = "__LIGHTVELA_ACHIEVEMENTS_JSON_END__";

/*
 * LightVela currently reads Hermes achievements through the bundled
 * hermes-achievements dashboard plugin. The plugin contract lives in
 * `plugins/hermes-achievements/dashboard/plugin_api.py`:
 *
 * - `compute_all(progress_every=0)` builds a fresh snapshot.
 * - `load_snapshot()` returns the cached snapshot when present.
 * - `_is_snapshot_stale(data)` and `_scan_status_payload()` are private plugin
 *   helpers used here only to preserve the dashboard's stale/scan status.
 *
 * Longer term, this should move behind a structured backend API. Until then,
 * keep this command module isolated from the UI/parser code so the shell/Python
 * bridge stays easy to audit and replace.
 */
export const buildHermesAchievementsCommand = (forceRescan = false) => String.raw`set -e
HERMES_ROOT="$HERMES_HOME"
if [ -z "$HERMES_ROOT" ]; then
  HERMES_ROOT="$HOME/.hermes"
fi
export HERMES_ROOT
PYTHON_BIN="$HERMES_ROOT/hermes-agent/venv/bin/python"
if [ ! -x "$PYTHON_BIN" ]; then
  PYTHON_BIN="python3"
fi
"$PYTHON_BIN" <<'PY'
import importlib.util
import json
import os
import sys
from pathlib import Path

START = "${JSON_START}"
END = "${JSON_END}"
force_rescan = ${forceRescan ? "True" : "False"}

home = Path(os.environ["HERMES_ROOT"])
candidates = [
    home / "hermes-agent" / "plugins" / "hermes-achievements" / "dashboard" / "plugin_api.py",
    home / "plugins" / "hermes-achievements" / "dashboard" / "plugin_api.py",
    Path.cwd() / "plugins" / "hermes-achievements" / "dashboard" / "plugin_api.py",
    Path("/usr/local/lib/hermes-agent/plugins/hermes-achievements/dashboard/plugin_api.py"),
]
plugin_path = next((path for path in candidates if path.exists()), None)
if plugin_path is None:
    raise SystemExit("hermes-achievements plugin_api.py not found")

repo_root = plugin_path.parents[3] if len(plugin_path.parents) > 3 else plugin_path.parent
for path in (str(repo_root), str(plugin_path.parent)):
    if path not in sys.path:
        sys.path.insert(0, path)

spec = importlib.util.spec_from_file_location("lightvela_hermes_achievements_plugin_api", plugin_path)
if spec is None or spec.loader is None:
    raise SystemExit("failed to load hermes-achievements plugin_api.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

compute_all = getattr(module, "compute_all", None)
load_snapshot = getattr(module, "load_snapshot", None)
if not callable(compute_all):
    raise SystemExit("hermes-achievements compute_all is not available")

if force_rescan or not callable(load_snapshot):
    data = compute_all(progress_every=0)
else:
    data = load_snapshot()
    if not isinstance(data, dict):
        data = compute_all(progress_every=0)

payload = {
    key: data.get(key)
    for key in [
        "achievements",
        "unlocked_count",
        "discovered_count",
        "secret_count",
        "total_count",
        "error",
        "generated_at",
        "scan_meta",
    ]
    if key in data
}

is_snapshot_stale = getattr(module, "_is_snapshot_stale", None)
payload["is_stale"] = bool(is_snapshot_stale(data)) if callable(is_snapshot_stale) else False

scan_meta = payload.get("scan_meta") if isinstance(payload.get("scan_meta"), dict) else {}
scan_status_payload = getattr(module, "_scan_status_payload", None)
scan_meta["status"] = scan_status_payload() if callable(scan_status_payload) else {}
payload["scan_meta"] = scan_meta

print(START)
print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
print(END)
PY`;
