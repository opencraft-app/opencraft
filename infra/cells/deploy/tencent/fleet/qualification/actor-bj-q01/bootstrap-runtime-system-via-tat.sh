#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
state_dir=${QUALIFICATION_STATE_DIR:-/data/agents/cloud/tencent-beijing-qualification/state}
state=$state_dir/bootstrap-node.json
[[ -s $state ]] || { echo "q01 bootstrap-node state is missing" >&2; exit 2; }
instance=$(jq -er '.InstanceIdSet | select(length == 1) | .[0] | select(test("^ins-[a-z0-9]+$"))' "$state")
[[ ${TAT_INSTANCE_ID:-} == "$instance" ]] || {
	echo "TAT_INSTANCE_ID is not the exact converged q01 operator instance" >&2
	exit 2
}

# System packages and the pinned Rust toolchain have separate provenance.
# This command never installs a floating distribution Rust compiler.
"$fleet_dir/tat/tat-run.sh" --name q01-bootstrap-runtime-system --timeout 1800 <<'REMOTE'
set -euo pipefail
source /etc/os-release
[[ $ID == tencentos && $VERSION_ID == 3.1 ]] || {
  echo "runtime system bootstrap requires TencentOS 3.1" >&2
  exit 2
}
dnf install -y buildah gcc gcc-c++ clang clang-devel lld make pkgconf-pkg-config \
  protobuf-compiler protobuf-devel cmake openssl-devel perl xz git python3.11 python3.11-pyyaml
for tool in buildah gcc g++ clang ld.lld make pkg-config protoc cmake; do
  command -v "$tool" >/dev/null
done
python3.11 -c 'import sys, yaml; assert sys.version_info[:2] == (3, 11); assert yaml.__version__'
install -d -m 0755 /data/tmp /data/build-cache
probe=$(mktemp /data/tmp/q01-lld-probe.XXXXXX)
trap 'rm -f -- "$probe"' EXIT
printf 'int main(void) { return 0; }\n' | clang --ld-path=/usr/bin/ld.lld -x c - -o "$probe"
"$probe"
rm -f -- "$probe"
trap - EXIT
rpm -q buildah gcc gcc-c++ clang clang-devel lld protobuf-compiler protobuf-devel cmake openssl-devel python3.11 python3.11-pyyaml
buildah --version
protoc --version
cmake --version
ld.lld --version
echo runtime_system_bootstrap=passed
REMOTE
