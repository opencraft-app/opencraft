#!/usr/bin/env bash
set -euo pipefail
umask 022

: "${ACTOR_ARGOCD_HA_SOURCE:?set ACTOR_ARGOCD_HA_SOURCE to an absolute cache path}"
ACTOR_ARGOCD_HA_SOURCE_URL=${ACTOR_ARGOCD_HA_SOURCE_URL:-https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.2/manifests/ha/install.yaml}
expected_sha256=2ce4de1f93549619a72fa7aee124d92fe73aa28ad062f1c614e15b5576ca0466

for command in curl sha256sum mktemp; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 2; }
done
[[ $ACTOR_ARGOCD_HA_SOURCE == /* && $ACTOR_ARGOCD_HA_SOURCE != / ]] || {
	echo "ACTOR_ARGOCD_HA_SOURCE must be an absolute non-root path" >&2
	exit 2
}
parent=$(dirname -- "$ACTOR_ARGOCD_HA_SOURCE")
[[ -d $parent ]] || { echo "Argo source parent must already exist" >&2; exit 2; }

if [[ -e $ACTOR_ARGOCD_HA_SOURCE ]]; then
	[[ -f $ACTOR_ARGOCD_HA_SOURCE && ! -L $ACTOR_ARGOCD_HA_SOURCE ]] || {
		echo "existing Argo source is not a regular non-symlink file" >&2
		exit 2
	}
	printf '%s  %s\n' "$expected_sha256" "$ACTOR_ARGOCD_HA_SOURCE" | sha256sum --check --status || {
		echo "existing Argo source differs from the reviewed digest" >&2
		exit 1
	}
	printf 'argocd_ha_source=present sha256=%s path=%s\n' "$expected_sha256" "$ACTOR_ARGOCD_HA_SOURCE"
	exit 0
fi

temporary=$(mktemp "$parent/.argocd-ha-source.XXXXXX")
cleanup() { rm -f -- "$temporary"; }
trap cleanup EXIT INT TERM
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
	--retry 5 --retry-all-errors --connect-timeout 15 --max-time 300 \
	"$ACTOR_ARGOCD_HA_SOURCE_URL" -o "$temporary"
printf '%s  %s\n' "$expected_sha256" "$temporary" | sha256sum --check --status || {
	echo "downloaded Argo HA source differs from the reviewed digest" >&2
	exit 1
}
chmod 0644 "$temporary"
ln "$temporary" "$ACTOR_ARGOCD_HA_SOURCE"
printf 'argocd_ha_source=acquired sha256=%s path=%s\n' "$expected_sha256" "$ACTOR_ARGOCD_HA_SOURCE"
