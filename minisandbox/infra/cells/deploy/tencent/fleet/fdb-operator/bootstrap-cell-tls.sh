#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
: "${ACTOR_CELL_KUBECONFIG:?ACTOR_CELL_KUBECONFIG must name the new Cell kubeconfig}"
: "${ACTOR_CELL_ID:?ACTOR_CELL_ID must name the exact Cell}"
: "${ACTOR_FDB_TLS_DIRECTORY:?ACTOR_FDB_TLS_DIRECTORY must name protected private storage}"
: "${ACTOR_FDB_TLS_RECEIPT:?ACTOR_FDB_TLS_RECEIPT must name the immutable non-secret receipt}"
namespace=${ACTOR_FDB_NAMESPACE:-actor-fdb-cell-system}
[[ $ACTOR_CELL_ID =~ ^actor-[a-z]{2}-[a-z][0-9]{2}$ ]] || { echo "invalid ACTOR_CELL_ID" >&2; exit 2; }
for path in "$ACTOR_CELL_KUBECONFIG" "$ACTOR_FDB_TLS_DIRECTORY" "$ACTOR_FDB_TLS_RECEIPT"; do
	[[ $path == /* && $path != / ]] || { echo "TLS bootstrap paths must be absolute and non-root" >&2; exit 2; }
done
[[ -f $ACTOR_CELL_KUBECONFIG && ! -L $ACTOR_CELL_KUBECONFIG ]] || {
	echo "Cell kubeconfig must be a regular non-symlink file" >&2
	exit 2
}
[[ -d $(dirname -- "$ACTOR_FDB_TLS_DIRECTORY") && -d $(dirname -- "$ACTOR_FDB_TLS_RECEIPT") ]] || {
	echo "TLS and receipt parents must already exist" >&2
	exit 2
}
[[ ! -L $ACTOR_FDB_TLS_DIRECTORY ]] || { echo "TLS directory may not be a symlink" >&2; exit 2; }
for command in kubectl jq openssl sha256sum python3; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 2; }
done

if [[ ! -d $ACTOR_FDB_TLS_DIRECTORY ]] || ! find "$ACTOR_FDB_TLS_DIRECTORY" -mindepth 1 -print -quit 2>/dev/null | grep -q .; then
	FDB_TLS_OUTPUT_DIR=$ACTOR_FDB_TLS_DIRECTORY \
	FDB_TLS_CELL_NAME=$ACTOR_CELL_ID \
	FDB_TLS_BLOBSTORE_CA_FILE=${ACTOR_FDB_BLOBSTORE_CA_FILE:-} \
		"$script_dir/generate-self-signed-tls.sh" >/dev/null
fi
[[ -d $ACTOR_FDB_TLS_DIRECTORY && ! -L $ACTOR_FDB_TLS_DIRECTORY ]] || {
	echo "TLS directory must be a real directory" >&2
	exit 1
}

expected_files=$(printf '%s\n' \
	backup/ca.pem backup/cert.pem backup/key.pem \
	ca/cert.pem ca/key.pem \
	cell/ca.pem cell/cert.pem cell/key.pem \
	operator/ca.pem operator/cert.pem operator/key.pem | LC_ALL=C sort)
actual_files=$(find "$ACTOR_FDB_TLS_DIRECTORY" -type f -printf '%P\n' | LC_ALL=C sort)
[[ $actual_files == "$expected_files" ]] || { echo "TLS directory has a missing or unexpected file" >&2; exit 1; }
for private_key in ca/key.pem operator/key.pem cell/key.pem backup/key.pem; do
	[[ $(stat -c '%a' "$ACTOR_FDB_TLS_DIRECTORY/$private_key") == 400 ]] || {
		echo "private key is not mode 0400: $private_key" >&2
		exit 1
	}
	done
for identity in ca operator cell backup; do
	cmp -s \
		<(openssl pkey -in "$ACTOR_FDB_TLS_DIRECTORY/$identity/key.pem" -pubout -outform DER 2>/dev/null) \
		<(openssl x509 -in "$ACTOR_FDB_TLS_DIRECTORY/$identity/cert.pem" -pubkey -noout 2>/dev/null | openssl pkey -pubin -outform DER 2>/dev/null) || {
		echo "certificate/private-key mismatch: $identity" >&2
		exit 1
	}
done
openssl verify -CAfile "$ACTOR_FDB_TLS_DIRECTORY/cell/ca.pem" \
	<(openssl x509 -in "$ACTOR_FDB_TLS_DIRECTORY/cell/cert.pem") >/dev/null
openssl x509 -in "$ACTOR_FDB_TLS_DIRECTORY/ca/cert.pem" -checkend 3153600000 -noout
openssl x509 -in "$ACTOR_FDB_TLS_DIRECTORY/cell/cert.pem" -checkend 1576800000 -noout
openssl x509 -in "$ACTOR_FDB_TLS_DIRECTORY/cell/cert.pem" -noout -ext subjectAltName | \
	grep -Fq "DNS:$ACTOR_CELL_ID.actor-fdb-cell-system.svc" || {
	echo "Cell certificate is not bound to ACTOR_CELL_ID" >&2
	exit 1
}

kube=(kubectl --kubeconfig "$ACTOR_CELL_KUBECONFIG")
namespace_json=$("${kube[@]}" get namespace "$namespace" -o json)
namespace_uid=$(jq -er '.metadata.uid | select(type == "string" and length > 0)' <<<"$namespace_json")
temporary=$(mktemp -d "$(dirname -- "$ACTOR_FDB_TLS_RECEIPT")/.actor-fdb-tls.XXXXXX")
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM
chmod 0700 "$temporary"

declare -a secret_records=()
ensure_secret() {
	local purpose=$1 name=$2 source_dir=$3
	local desired=$temporary/$name.desired.json live=$temporary/$name.live.json
	"${kube[@]}" -n "$namespace" create secret generic "$name" \
		--from-file=ca.pem="$source_dir/ca.pem" \
		--from-file=cert.pem="$source_dir/cert.pem" \
		--from-file=key.pem="$source_dir/key.pem" \
		--dry-run=client -o json | jq \
			--arg cell "$ACTOR_CELL_ID" --arg purpose "$purpose" --arg namespace "$namespace" \
			'.immutable=true | .metadata.namespace=$namespace | .metadata.labels={"fleet.actor.dev/cell":$cell,"fleet.actor.dev/purpose":$purpose}' \
			>"$desired"
	chmod 0600 "$desired"
	if "${kube[@]}" -n "$namespace" get secret "$name" -o json >"$live" 2>/dev/null; then
		:
	else
		"${kube[@]}" create -f "$desired" >/dev/null
		"${kube[@]}" -n "$namespace" get secret "$name" -o json >"$live"
	fi
	chmod 0600 "$live"
	jq -S '{immutable,metadata:{name:.metadata.name,namespace:.metadata.namespace,labels:.metadata.labels},data}' \
		"$desired" >"$temporary/desired-projection"
	jq -S '{immutable,metadata:{name:.metadata.name,namespace:.metadata.namespace,labels:.metadata.labels},data}' \
		"$live" >"$temporary/live-projection"
	cmp -s "$temporary/desired-projection" "$temporary/live-projection" || {
		echo "live immutable TLS Secret differs: $namespace/$name" >&2
		exit 1
	}
	local uid cert_sha ca_sha
	uid=$(jq -er '.metadata.uid | select(type == "string" and length > 0)' "$live")
	cert_sha=$(sha256sum "$source_dir/cert.pem" | cut -d' ' -f1)
	ca_sha=$(sha256sum "$source_dir/ca.pem" | cut -d' ' -f1)
	secret_records+=("$(jq -cn --arg purpose "$purpose" --arg name "$name" --arg uid "$uid" \
		--arg cert_sha "$cert_sha" --arg ca_sha "$ca_sha" \
		'{purpose:$purpose,name:$name,uid:$uid,certificateSha256:$cert_sha,caBundleSha256:$ca_sha}')")
}

ensure_secret operator fdb-operator-tls "$ACTOR_FDB_TLS_DIRECTORY/operator"
ensure_secret cell "$ACTOR_CELL_ID-fdb-tls" "$ACTOR_FDB_TLS_DIRECTORY/cell"
ensure_secret backup "$ACTOR_CELL_ID-backup-tls" "$ACTOR_FDB_TLS_DIRECTORY/backup"

secrets_json=$(printf '%s\n' "${secret_records[@]}" | jq -sc '.')
receipt_temporary=$temporary/receipt.json
jq -cn --arg cell "$ACTOR_CELL_ID" --arg namespace "$namespace" --arg namespace_uid "$namespace_uid" \
	--argjson secrets "$secrets_json" \
	'{schema:"actor-fdb-tls-bootstrap/v1",verdict:"passed",cellId:$cell,namespace:{name:$namespace,uid:$namespace_uid},secrets:$secrets}' \
	>"$receipt_temporary"
chmod 0600 "$receipt_temporary"
if [[ -e $ACTOR_FDB_TLS_RECEIPT ]]; then
	[[ -f $ACTOR_FDB_TLS_RECEIPT && ! -L $ACTOR_FDB_TLS_RECEIPT ]] && \
		cmp -s "$receipt_temporary" "$ACTOR_FDB_TLS_RECEIPT" || {
		echo "TLS receipt already exists with different content" >&2
		exit 1
	}
elif ! ln "$receipt_temporary" "$ACTOR_FDB_TLS_RECEIPT" 2>/dev/null; then
	[[ -f $ACTOR_FDB_TLS_RECEIPT && ! -L $ACTOR_FDB_TLS_RECEIPT ]] && \
		cmp -s "$receipt_temporary" "$ACTOR_FDB_TLS_RECEIPT" || {
		echo "unable to publish immutable TLS receipt" >&2
		exit 1
	}
fi
chmod 0644 "$ACTOR_FDB_TLS_RECEIPT"
printf 'fdb_tls_bootstrap=passed cell=%s receipt=%s sha256=%s\n' \
	"$ACTOR_CELL_ID" "$ACTOR_FDB_TLS_RECEIPT" \
	"$(sha256sum "$ACTOR_FDB_TLS_RECEIPT" | cut -d' ' -f1)"
