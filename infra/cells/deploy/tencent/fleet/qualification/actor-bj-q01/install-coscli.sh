#!/usr/bin/env bash
set -euo pipefail

version=v1.0.9
sha256=a07de5ba2800147a700ed29036b0c76a4229088cee68e1682d0eae19b638a915
url=https://cosbrowser.cloud.tencent.com/software/coscli/coscli-linux-amd64
install_root=${COSCLI_INSTALL_ROOT:-/data/build-cache/coscli}
install_dir=$install_root/$version
target=$install_dir/coscli
source_binary=${COSCLI_SOURCE:-}

install -d -m 0755 "$install_dir"
if [[ ! -f $target ]] || ! printf '%s  %s\n' "$sha256" "$target" | sha256sum -c - >/dev/null 2>&1; then
	partial=$target.download
	if [[ -n $source_binary ]]; then
		source_binary=$(readlink -e "$source_binary")
		[[ -f $source_binary && ! -L $source_binary ]] || {
			echo "COSCLI_SOURCE must resolve to a regular relay artifact" >&2
			exit 2
		}
		printf '%s  %s\n' "$sha256" "$source_binary" | sha256sum -c -
		install -m 0755 "$source_binary" "$partial"
	else
		curl --fail --location --proto '=https' --connect-timeout 10 --max-time 300 \
			--output "$partial" "$url"
	fi
	printf '%s  %s\n' "$sha256" "$partial" | sha256sum -c -
	chmod 0755 "$partial"
	mv "$partial" "$target"
fi
printf '%s  %s\n' "$sha256" "$target" | sha256sum -c -
[[ $($target --version) == "coscli version $version" ]]
printf 'coscli installed: version=%s path=%s sha256=%s\n' "$version" "$target" "$sha256"
