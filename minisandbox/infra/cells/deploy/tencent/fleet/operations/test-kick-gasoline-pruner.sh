#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
temporary=$(mktemp -d "${TMPDIR:-/data/tmp}/gasoline-pruner-kick-test.XXXXXX")
trap 'rm -rf -- "$temporary"' EXIT INT TERM
mock=$temporary/kubectl
state=$temporary/state
calls=$temporary/calls

cat >"$mock" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" >>"$MOCK_CALLS"
args=" $* "
if [[ $args == *" get configmap actor-bj-q01-runtime-config -o json "* ]]; then
  printf '%s\n' '{"data":{"config.jsonc":"{\"runtime\":{\"gasoline_cell_namespace\":\"actor-bj-q01\",\"gasoline_prune_interval_duration\":60}}"}}'
elif [[ $args == *" get pods -l fleet.actor.dev/cell-name=actor-bj-q01,fleet.actor.dev/component=engine -o json "* ]]; then
  printf '%s\n' '{"items":[{"metadata":{"name":"engine-b"},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}},{"metadata":{"name":"engine-a"},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}'
elif [[ $args == *" udb -q "* ]]; then
  printf '%s\n' '  /1s9eetm2z0brja1ylx1agu9s5bcl00 = []'
elif [[ $args == *" wf wake 1s9eetm2z0brja1ylx1agu9s5bcl00 "* ]]; then
  touch "$MOCK_STATE"
elif [[ $args == *" wf get 1s9eetm2z0brja1ylx1agu9s5bcl00 "* ]]; then
  deadline=9999999999999
  [[ ! -e $MOCK_STATE ]] || deadline=$(($(date +%s) * 1000 + 60000))
  printf 'gasoline_pruner\n  id 1s9eetm2z0brja1ylx1agu9s5bcl00\n  state sleeping\n  error sleeping until %s\n' "$deadline"
else
  echo "unexpected kubectl invocation: $*" >&2
  exit 2
fi
MOCK
chmod +x "$mock"
: >"$temporary/q01.kubeconfig"
: >"$calls"
export KUBECTL=$mock MOCK_STATE=$state MOCK_CALLS=$calls

output=$("$script_dir/kick-gasoline-pruner.sh" actor-bj-q01 actor-fdb-cell-system "$temporary/q01.kubeconfig")
grep -Fq 'gasoline_pruner_kick=passed' <<<"$output"
grep -Fq -- '-n actor-fdb-cell-system exec engine-a -c engine' "$calls"
grep -Fq -- '--limit 2 --style list' "$calls"

# A duplicate indexed owner must fail closed before any wake.
sed -i '/printf.*1s9eetm2z0brja1ylx1agu9s5bcl00 = \[\]/a\  printf '\''%s\\n'\'' '\''  /2s9eetm2z0brja1ylx1agu9s5bcl00 = []'\''' "$mock"
if "$script_dir/kick-gasoline-pruner.sh" actor-bj-q01 actor-fdb-cell-system "$temporary/q01.kubeconfig" \
	>"$temporary/duplicate.out" 2>&1; then
	echo "duplicate pruner owner was accepted" >&2
	exit 1
fi
grep -Fq 'expected exactly one indexed gasoline_pruner; found 2' "$temporary/duplicate.out"
