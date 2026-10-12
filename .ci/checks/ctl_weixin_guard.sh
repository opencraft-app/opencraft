#!/usr/bin/env bash
set -euo pipefail
cd "${GUARD_REPO_ROOT:-$(pwd)}"
source .ci/init.sh
ci_init_repo_root
if [[ "$(uname -s)" == Linux ]]; then
  ci_ensure_go
else
  ci_require_commands go
fi
ci_require_commands python3
CTL_TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/lightclaw-ctl-weixin.XXXXXX")"
trap 'rm -rf "$CTL_TEST_ROOT"' EXIT
python3 -m venv "$CTL_TEST_ROOT/python"
export HERMES_TEST_PYTHON="$CTL_TEST_ROOT/python/bin/python"
"$HERMES_TEST_PYTHON" -m pip install --disable-pip-version-check -r .ci/checks/ctl_weixin_test_requirements.txt
"$HERMES_TEST_PYTHON" -c 'import dotenv, yaml'
export GOWORK=off CGO_ENABLED=0
cd ctl
if ! go test ./pkg/instance ./main/api -run 'Test(Weixin|ChannelBinding|WhatsApp|FinishWeixin|CreateWeixin|ExecWeixin|NormalizeWeixin|ParseWeixin|OpenclawWeixin|WriteHTTPError|DeleteInstanceBotRejects|DeleteBotChannelConflict)' -count=1 -json > "$CTL_TEST_ROOT/results.jsonl"; then
  cat "$CTL_TEST_ROOT/results.jsonl" >&2
  exit 1
fi
"$HERMES_TEST_PYTHON" - "$CTL_TEST_ROOT/results.jsonl" <<'PYTHON'
import json, sys
results = [json.loads(line) for line in open(sys.argv[1])]
skipped = [row['Test'] for row in results if row.get('Action') == 'skip' and row.get('Test')]
if skipped:
    raise SystemExit('required CTL tests skipped: ' + ', '.join(skipped))
passed = [row for row in results if row.get('Action') == 'pass' and row.get('Test')]
if not passed:
    raise SystemExit('no CTL tests executed')
print('CTL Weixin guard: ' + str(len(passed)) + ' test cases passed; none skipped')
PYTHON
go vet ./pkg/instance ./main/api
