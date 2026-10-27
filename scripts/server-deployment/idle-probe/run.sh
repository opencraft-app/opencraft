#!/usr/bin/env bash
# preflight-cand-20261023 differential suite (r3).
# Per case: unique temp root, explicit kill/wait, leftover-process ASSERTION (pgrep by root),
# numeric field assertions (loaded/active/unknown/failedCode), <10s bound on immediate-failure cases.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PROBE="$HERE/../../../build/idle-probe/preflight-cand.mjs"; FIXTURE="$HERE/fixture-fake-apphost-ingress.mjs"; LEGACY="$HERE/legacy-v1-client.mjs"
LOG_ROOT="${TMPCHOICE_LOG_DIR:-$(mktemp -d)}"
LOG="$LOG_ROOT/results-$(date +%Y%m%d-%H%M%S).log"; : > "$LOG"
FAILS=0
note() { echo "$@" | tee -a "$LOG"; }
flat_json() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const[k,v]of Object.entries(j))process.stdout.write(k+"="+JSON.stringify(v)+" ")' "$1" 2>/dev/null; }
start_case() { ROOT=$(mktemp -d "${TMPDIR_BASE:-}join-pfcand3-XXXXXXXX"); export TMPDIR="$ROOT"; note "### $1 (root=$ROOT)"; }
assert_root_clean() { # leftover assertion: no process whose cmdline references the case root
  if pgrep -f "$ROOT" >/dev/null 2>&1; then note "  LEFTOVER: yes (FAIL)"; pgrep -af "$ROOT" | tee -a "$LOG"; FAILS=$((FAILS+1)); return 1; fi
  note "  leftovers: none"
}
expect_case() { # NAME SCENARIO EXPECT_EXIT "k=v k=v ..." [probelabel]
  local NAME=$1 SC=$2 EXP_EXIT=$3 EXPECTS=$4
  start_case "$NAME"; trap 'case_cleanup' EXIT
  FIXTURE_PORT=0 node "$FIXTURE" "$SC" > "$ROOT/port.txt" 2>"$ROOT/fixture.err" & FPID=$!
  for _ in $(seq 1 60); do [ -s "$ROOT/port.txt" ] && break; sleep 0.1; done
  local PORT; PORT=$(sed 's/FIXTURE_PORT=//' "$ROOT/port.txt" | head -1)
  if [ -z "$PORT" ]; then note "  fixture-did-not-start (FAIL)"; FAILS=$((FAILS+1)); case_cleanup; return; fi
  local T0 T1 WALL CODE
  T0=$(date +%s%3N)
  ( cd "$ROOT" && env PREFLIGHT_ENDPOINT="ws://127.0.0.1:$PORT/apphost" timeout 20 node "$PROBE" ) > "$ROOT/out.json" 2>"$ROOT/err.txt"
  CODE=$?
  T1=$(date +%s%3N); WALL=$((T1-T0))
  kill "$FPID" 2>/dev/null; wait "$FPID" 2>/dev/null; FPID=
  local FLAT; FLAT=$(flat_json "$ROOT/out.json")
  note "  $NAME: exit=$CODE(expect $EXP_EXIT) wall=${WALL}ms"
  note "  out: $(head -c 420 "$ROOT/out.json")"
  [ "$CODE" = "$EXP_EXIT" ] || { note "  EXIT-FAIL"; FAILS=$((FAILS+1)); }
  for kv in $EXPECTS; do
    local k=${kv%%=*} v=${kv#*=}
    local got; got=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const p=process.argv[2].split(".");let v=j;for(const s of p){if(v==null){v=undefined;break}v=v[s]}process.stdout.write(String(v===undefined?"<absent>":v))' "$ROOT/out.json" "$k")
    if [ "$got" = "$v" ]; then note "  $k=$v ok"; else note "  $k expect=$v got=$got (FAIL)"; FAILS=$((FAILS+1)); fi
  done
  # <10s bound for immediate-failure expectations
  case "$EXPECTS" in *verdict=preflight-failed*) local EL; EL=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.elapsedMs))' "$ROOT/out.json" 2>/dev/null || echo 99999)
    if [ "${EL:-99999}" -lt 10000 ]; then note "  elapsed=$EL ok(<10s)"; else note "  ELAPSED>=10s (FAIL)"; FAILS=$((FAILS+1)); fi;; esac
  assert_root_clean "$ROOT"
  rm -rf "$ROOT"; trap - EXIT
}
case_cleanup() { [ -n "${FPID:-}" ] && kill "$FPID" 2>/dev/null; wait "${FPID:-0}" 2>/dev/null; FPID=; }

note "### preflight-cand-20261023 r3 suite $(date -Iseconds)"
note "### original preflight sha256 (host, must be unchanged):"
# no external-gate reads: this suite is self-contained
note "### positive ordering note: fixture always ACKs success first, host/frame result arrives +25ms later; a success ACK resolving an RPC early would break T2/T3-T6"

# T0 connect failure (nothing listening): exit 3 immediate
start_case "T0-connect-failure"; trap 'case_cleanup' EXIT
( cd "$ROOT" && env PREFLIGHT_ENDPOINT="ws://127.0.0.1:9/apphost" timeout 20 node "$PROBE" ) > "$ROOT/out.json" 2>"$ROOT/err.txt"
CODE=$?
flat=$(flat_json "$ROOT/out.json"); note "  T0: exit=$CODE $flat"
[ "$CODE" = 3 ] || FAILS=$((FAILS+1))
flat_json "$ROOT/out.json" | grep -q 'failedStage="connect"' || FAILS=$((FAILS+1))
flat_json "$ROOT/out.json" | grep -qE "elapsedMs=[0-9]+" && ELAP=$(flat_json "$ROOT/out.json" | grep -o "elapsedMs=[0-9]*" | cut -d= -f2); [ "${ELAP:-99999}" -lt 10000 ] || { note "  T0 ELAPSED-FAIL"; FAILS=$((FAILS+1)); }
assert_root_clean "$ROOT"; rm -rf "$ROOT"; trap - EXIT

# T-T0b ready protocolVersion mismatch (sent v2 got v1)
expect_case T0b-ready-v1 ready-v1 3 "verdict=preflight-failed failedStage=ready-mismatch failedCode=version-mismatch"

start_case "T1-legacy-v1-client"; trap 'case_cleanup' EXIT
FIXTURE_PORT=0 node "$FIXTURE" idle > "$ROOT/port.txt" 2>&1 & FPID=$!
for _ in $(seq 1 60); do [ -s "$ROOT/port.txt" ] && break; sleep 0.1; done
PORT=$(sed 's/FIXTURE_PORT=//' "$ROOT/port.txt" | head -1)
( cd "$ROOT" && env PREFLIGHT_ENDPOINT="ws://127.0.0.1:$PORT/apphost" timeout 20 node "$LEGACY" ) > "$ROOT/legacy.json" 2>&1
LC=$?
kill "$FPID" 2>/dev/null; wait "$FPID" 2>/dev/null; FPID=
LJ=$(head -1 "$ROOT/legacy.json")
WM=$(echo "$LJ" | grep -o '"waitMs":[0-9]*' | grep -o '[0-9]*' | head -1)
note "  T1: exit=$LC legacy=$LJ"
if [ "$LC" = 0 ] && echo "$LJ" | grep -q '"legacyStage":"protocol-fatal"' && [ -n "$WM" ] && [ "$WM" -lt 10000 ]; then
  note "  T1 assert: exit=0 + protocol-fatal + waitMs=$WM ok (parent shell)"
else
  note "  T1 assert FAIL: exit=$LC legacyStage/waitMs not satisfied (${WM:-absent})"; FAILS=$((FAILS+1))
fi
assert_root_clean "$ROOT"; rm -rf "$ROOT"; trap - EXIT

expect_case T2-idle              idle              0 "verdict=idle loaded=2 active=0 unknown=0"
expect_case T3-active-second     active            2 "verdict=not-idle loaded=2 active=1 unknown=0"
expect_case T4-unknown-second    unknown-status    2 "verdict=not-idle loaded=2 active=0 unknown=1"
expect_case T5-missing-second    missing-status    2 "verdict=not-idle loaded=2 active=0 unknown=1"
expect_case T6-malformed-list    malformed-list    2 "verdict=not-idle loaded=null reason=malformed-loaded-list"
expect_case T7-rpc-error         rpc-error         3 "verdict=preflight-failed failedStage=rpc:thread/loaded/list failedCode=rpc-error"
expect_case T8-send-ack-fail     send-ack-fail     3 "verdict=preflight-failed failedStage=initialize failedCode=ack-failed"
expect_case T9a-foreign-lease    foreign-lease     3 "verdict=preflight-failed failedStage=envelope-mismatch failedCode=foreign-lease"
expect_case T9b-foreign-gen      foreign-generation 3 "verdict=preflight-failed failedStage=envelope-mismatch failedCode=foreign-generation"
expect_case T9c-missing-lease    missing-lease     3 "verdict=preflight-failed failedStage=envelope-mismatch failedCode=missing-lease"
expect_case T9d-foreign-host     foreign-host      3 "verdict=preflight-failed failedStage=envelope-mismatch failedCode=foreign-host"
expect_case T10-close-only       close-after-hello 3 "verdict=preflight-failed failedStage=connection-closed"
expect_case T11-fatal-always     fatal-always      3 "verdict=preflight-failed failedCode=APP_HOST_PROTOCOL_MISMATCH"

note "### summary FAILS=$FAILS"
if [ "$FAILS" = 0 ]; then note "ALL-PASS"; else note "SUITE-FAILED"; exit 1; fi
