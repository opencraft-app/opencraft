#!/usr/bin/env bash
set -euo pipefail

# TKE owns CVM user_data and may replace it while attaching the node. Keep
# Actor's operator workspace as a separate, restart-safe TAT phase.
[[ $EUID -eq 0 ]] || { echo "bootstrap host preparation requires root" >&2; exit 2; }

workspace=${ACTOR_BOOTSTRAP_WORKSPACE:-/data/actor-bootstrap}
[[ $workspace == /data/* && $workspace != /data ]] || {
	echo "ACTOR_BOOTSTRAP_WORKSPACE must be a child of /data" >&2
	exit 2
}
install -d -m 1777 /data/tmp
install -d -m 0700 "$workspace"

# Terraform deliberately creates a stock TencentOS worker.  Do not depend on
# tools left behind by an earlier qualification run: converge the small,
# declared host-side bootstrap set before checking the complete contract.
source /etc/os-release
[[ $ID == tencentos && $VERSION_ID == 3.1 ]] || {
	echo "bootstrap host requires TencentOS 3.1" >&2
	exit 1
}
packages=(buildah git jq nodejs skopeo python3.11 python3.11-pyyaml)
missing=false
for command in buildah git jq node skopeo python3.11; do
	command -v "$command" >/dev/null 2>&1 || missing=true
done
if command -v node >/dev/null 2>&1 && ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) === 20 ? 0 : 1)'; then
	missing=true
fi
if [[ $missing == true ]]; then
	command -v dnf >/dev/null || { echo "missing bootstrap package manager: dnf" >&2; exit 1; }
	# TencentOS defaults to its obsolete Node 10 module. The reviewed-source
	# static gate uses node:test, so choose the distro-supported Node 20 stream
	# explicitly instead of inheriting the image's changing module default.
	dnf -y module enable nodejs:20 >/dev/null
	dnf --setopt=install_weak_deps=False install -y "${packages[@]}" >/dev/null
fi

for command in bash base64 buildah curl getent git jq kubectl node openssl sha256sum skopeo stat tar; do
	command -v "$command" >/dev/null || { echo "missing bootstrap tool: $command" >&2; exit 1; }
done
node -e 'if (Number(process.versions.node.split(".")[0]) !== 20) process.exit(1)' || {
	echo "bootstrap Node.js 20 is unavailable" >&2
	exit 1
}
python=${ACTOR_BOOTSTRAP_PYTHON:-python3.11}
command -v "$python" >/dev/null || { echo "bootstrap Python 3.11 is unavailable" >&2; exit 1; }
"$python" - <<'PY'
import sys
import yaml
assert sys.version_info[:2] == (3, 11)
PY

available_kib=$(df -Pk "$workspace" | awk 'NR == 2 {print $4}')
[[ $available_kib =~ ^[0-9]+$ && $available_kib -ge 20971520 ]] || {
	echo "bootstrap workspace requires at least 20 GiB free" >&2
	exit 1
}
package_inventory=$(rpm -q --qf '%{NAME}-%{EPOCHNUM}:%{VERSION}-%{RELEASE}.%{ARCH}\n' "${packages[@]}" | LC_ALL=C sort | sha256sum | cut -d' ' -f1)
printf 'bootstrap_host=ready workspace=%s available_kib=%s package_inventory_sha256=%s\n' \
	"$workspace" "$available_kib" "$package_inventory"
