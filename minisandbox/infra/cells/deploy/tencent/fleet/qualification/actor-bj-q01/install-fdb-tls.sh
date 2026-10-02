#!/usr/bin/env bash
set -euo pipefail

tls_dir=${FDB_TLS_INPUT_DIR:-/var/lib/actor-build/credentials/actor-bj-q01-fdb-tls-cls-ike1rebd}
kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")
[[ $tls_dir == /* && $tls_dir != / ]]

install_secret() {
	namespace=$1
	name=$2
	source_dir=$3
	for file in ca.pem cert.pem key.pem; do
		[[ -s $source_dir/$file ]] || {
			echo "missing TLS input: $source_dir/$file" >&2
			exit 1
		}
	done
	temporary=$(mktemp)
	trap 'rm -f -- "$temporary"' RETURN
	kubectl "${kubeconfig_args[@]}" -n "$namespace" create secret generic "$name" \
		--from-file=ca.pem="$source_dir/ca.pem" \
		--from-file=cert.pem="$source_dir/cert.pem" \
		--from-file=key.pem="$source_dir/key.pem" \
		--dry-run=client -o json >"$temporary"
	if kubectl "${kubeconfig_args[@]}" -n "$namespace" get secret "$name" >/dev/null 2>&1; then
		kubectl "${kubeconfig_args[@]}" -n "$namespace" replace -f "$temporary" >/dev/null
	else
		kubectl "${kubeconfig_args[@]}" -n "$namespace" create -f "$temporary" >/dev/null
	fi
	rm -f -- "$temporary"
	trap - RETURN
	annotation_bytes=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get secret "$name" \
		-o go-template='{{with .metadata.annotations}}{{index . "kubectl.kubernetes.io/last-applied-configuration"}}{{end}}' | wc -c)
	((annotation_bytes == 0)) || {
		echo "$namespace/$name unexpectedly contains a last-applied payload" >&2
		exit 1
	}
}

kubectl "${kubeconfig_args[@]}" get namespace actor-fdb-cell-system >/dev/null
install_secret actor-fdb-cell-system fdb-operator-tls "$tls_dir/operator"
install_secret actor-fdb-cell-system actor-bj-q01-fdb-tls "$tls_dir/cell"
install_secret actor-fdb-cell-system actor-bj-q01-backup-tls "$tls_dir/backup"

openssl verify -CAfile "$tls_dir/cell/ca.pem" "$tls_dir/cell/cert.pem" >/dev/null
openssl x509 -in "$tls_dir/ca/cert.pem" -checkend 3153600000 -noout >/dev/null
openssl x509 -in "$tls_dir/cell/cert.pem" -checkend 1576800000 -noout >/dev/null
printf 'installed long-lived q01 FDB TLS secrets without last-applied payloads\n'
