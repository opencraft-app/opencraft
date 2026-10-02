#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
lock=${ACTOR_TERRAFORM_LOCK:-$script_dir/terraform.lock.json}
install_root=${ACTOR_TOOL_ROOT:-/data/actor-tools}
archive_override=${ACTOR_TERRAFORM_ARCHIVE:-}

for command in jq sha256sum python3; do
	command -v "$command" >/dev/null || {
		echo "Terraform bootstrap requires tool: $command" >&2
		exit 2
	}
done
[[ -f $lock && ! -L $lock ]] || {
	echo "Terraform lock is unavailable: $lock" >&2
	exit 2
}

schema=$(jq -er '.schema' "$lock")
version=$(jq -er '.version' "$lock")
platform=$(jq -er '.platform' "$lock")
url=$(jq -er '.archive.url' "$lock")
archive_sha=$(jq -er '.archive.sha256' "$lock")
binary_sha=$(jq -er '.binary.sha256' "$lock")
[[ $schema == actor-bootstrap-tool/v1 && $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && \
	$platform == linux_amd64 && $url == https://releases.hashicorp.com/terraform/* && \
	$archive_sha =~ ^[0-9a-f]{64}$ && $binary_sha =~ ^[0-9a-f]{64}$ ]] || {
	echo "Terraform lock is invalid" >&2
	exit 2
}

target_dir=$install_root/terraform/$version/$platform
target=$target_dir/terraform
if [[ -x $target ]] && printf '%s  %s\n' "$binary_sha" "$target" | sha256sum -c - >/dev/null 2>&1; then
	printf '%s\n' "$target"
	exit 0
fi

parent=$(dirname -- "$target_dir")
mkdir -p "$parent"
temporary=$(mktemp -d "$parent/.terraform-install.XXXXXX")
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM

archive=$temporary/terraform.zip
if [[ -n $archive_override ]]; then
	[[ $archive_override == /* && -f $archive_override && ! -L $archive_override ]] || {
		echo "ACTOR_TERRAFORM_ARCHIVE must name an absolute regular non-symlink file" >&2
		exit 2
	}
	cp -- "$archive_override" "$archive"
else
	command -v curl >/dev/null || {
		echo "curl is required when ACTOR_TERRAFORM_ARCHIVE is not supplied" >&2
		exit 2
	}
	curl --fail --location --proto '=https' --tlsv1.2 --output "$archive" "$url"
fi
printf '%s  %s\n' "$archive_sha" "$archive" | sha256sum -c - >/dev/null

python3 - "$archive" "$temporary/unpacked" <<'PY'
import pathlib
import stat
import sys
import zipfile

archive = pathlib.Path(sys.argv[1])
output = pathlib.Path(sys.argv[2])
with zipfile.ZipFile(archive) as source:
    names = source.namelist()
    if sorted(names) not in (["terraform"], ["LICENSE.txt", "terraform"]):
        raise SystemExit(f"unexpected Terraform archive members: {names!r}")
    info = source.getinfo("terraform")
    if info.is_dir() or pathlib.PurePosixPath(info.filename).is_absolute():
        raise SystemExit("unsafe Terraform archive member")
    output.mkdir(mode=0o755)
    with source.open(info) as reader, (output / "terraform").open("xb") as writer:
        while chunk := reader.read(1024 * 1024):
            writer.write(chunk)
    (output / "terraform").chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR |
                                   stat.S_IRGRP | stat.S_IXGRP |
                                   stat.S_IROTH | stat.S_IXOTH)
PY

candidate=$temporary/unpacked/terraform
printf '%s  %s\n' "$binary_sha" "$candidate" | sha256sum -c - >/dev/null
reported=$($candidate version -json | jq -er '.terraform_version')
[[ $reported == "$version" ]] || {
	echo "Terraform binary reports version $reported, expected $version" >&2
	exit 1
}

# A rename within one filesystem publishes the verified directory atomically.
if ! mv -T "$temporary/unpacked" "$target_dir" 2>/dev/null; then
	[[ -x $target ]] && printf '%s  %s\n' "$binary_sha" "$target" | sha256sum -c - >/dev/null
fi
printf '%s\n' "$target"
