#!/usr/bin/env bash
set -euo pipefail

credentials=${FDB_BLOB_CREDENTIALS_FILE:-/var/lib/actor-build/credentials/actor-bj-q01-blob-credentials.json}
kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")
[[ $credentials == /* && -s $credentials ]]
python3 - "$credentials" <<'PY'
import json, sys
document = json.load(open(sys.argv[1]))
expected = '@actor-fdb-backup-prod-bj-q01-nv1-1388575217.cos.ap-beijing.myqcloud.com'
accounts = document.get('accounts', {})
if list(accounts) != [expected]:
    raise SystemExit('backup credentials must contain exactly the q01 backup account')
for key in ('api_key', 'secret'):
    if not isinstance(accounts[expected].get(key), str) or not accounts[expected][key]:
        raise SystemExit('backup credentials are incomplete')
PY
temporary=$(mktemp)
cleanup(){ rm -f -- "$temporary"; }
trap cleanup EXIT
kubectl "${kubeconfig_args[@]}" -n actor-fdb-cell-system create secret generic \
	actor-bj-q01-backup-credentials --from-file=credentials="$credentials" \
	--dry-run=client -o json >"$temporary"
if kubectl "${kubeconfig_args[@]}" -n actor-fdb-cell-system get secret \
	actor-bj-q01-backup-credentials >/dev/null 2>&1; then
	kubectl "${kubeconfig_args[@]}" -n actor-fdb-cell-system replace -f "$temporary" >/dev/null
else
	kubectl "${kubeconfig_args[@]}" -n actor-fdb-cell-system create -f "$temporary" >/dev/null
fi
[[ $(kubectl "${kubeconfig_args[@]}" -n actor-fdb-cell-system get secret \
	actor-bj-q01-backup-credentials -o go-template='{{len (index .data "credentials")}}') -gt 0 ]]
echo "installed exact q01 backup credential document"
