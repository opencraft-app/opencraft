#!/usr/bin/env bash
set -euo pipefail

version=v3.17.3
archive="helm-${version}-linux-amd64.tar.gz"
expected_sha=ee88b3c851ae6466a3de507f7be73fe94d54cbf2987cbaa3d1a3832ea331f2cd
destination=${HELM_INSTALL_PATH:-/usr/local/bin/helm}
local_archive=${ACTOR_HELM_ARCHIVE:-}

for command in install sha256sum tar cp; do
	command -v "$command" >/dev/null || {
		echo "required command is missing: $command" >&2
		exit 2
	}
done
if [[ -n $local_archive ]]; then
	[[ $local_archive == /* && -f $local_archive && ! -L $local_archive ]] || {
		echo "ACTOR_HELM_ARCHIVE must be an absolute regular, non-symlink file" >&2
		exit 2
	}
else
	command -v curl >/dev/null || { echo "required command is missing: curl" >&2; exit 2; }
fi

temporary=$(mktemp -d)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT
if [[ -n $local_archive ]]; then
	cp -- "$local_archive" "$temporary/$archive"
else
	curl --fail --silent --show-error --location --proto '=https' \
		--proto-redir '=https' --connect-timeout 10 --max-time 120 \
		"https://get.helm.sh/$archive" --output "$temporary/$archive"
fi
actual_sha=$(sha256sum "$temporary/$archive" | cut -d' ' -f1)
[[ $actual_sha == "$expected_sha" ]] || {
	echo "Helm archive SHA-256 mismatch" >&2
	exit 1
}
tar -xzf "$temporary/$archive" -C "$temporary"
install -o root -g root -m 0755 "$temporary/linux-amd64/helm" "$destination"
"$destination" version --short
