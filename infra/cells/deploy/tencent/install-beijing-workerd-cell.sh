#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) -ne 0 ]]; then
	echo "install-beijing-workerd-cell.sh must run as root" >&2
	exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
workerd_artifact=${WORKERD_ARTIFACT:?WORKERD_ARTIFACT must point to the verified workerd binary}
host_artifact=${HOST_ARTIFACT:?HOST_ARTIFACT must point to the verified rivet-workerd-host binary}
engine_artifact=${ENGINE_ARTIFACT:?ENGINE_ARTIFACT must point to the verified rivet-engine binary}
host_source=${HOST_SOURCE:?HOST_SOURCE must point to the verified Rivet host source overlay}
fdb_cluster=${FDB_CLUSTER_FILE:-/var/lib/actor-soak/config/fdb.cluster}
blob_credentials=${BLOB_CREDENTIALS_FILE:-/etc/actor/backup-fence/blob-credentials.json}
cell_id=${CELL_ID:-actor-bj-a01}
cold_bucket=${COLD_BUCKET:-actor-depot-cold-prod-bj-a01-nv1-1388575217}
runtime_role=${RUNTIME_ROLE:-engine-and-workerd}
engine_endpoint=${ENGINE_ENDPOINT:-http://127.0.0.1:6420}
engine_health_url=${ENGINE_HEALTH_URL:-http://127.0.0.1:6421/health}
runner_pool_name=${RUNNER_POOL_NAME:-workerd}
engine_auth_token=${ENGINE_AUTH_TOKEN:-dev}

[[ $cell_id =~ ^actor-bj-[a-z][0-9]{2}$ ]] || {
	echo "invalid CELL_ID: $cell_id" >&2
	exit 1
}
[[ $cold_bucket =~ ^actor-depot-cold-prod-bj-[a-z][0-9]{2}-nv[0-9]+-[0-9]+$ ]] || {
	echo "invalid COLD_BUCKET: $cold_bucket" >&2
	exit 1
}

case "$runtime_role" in
engine-and-workerd | workerd-only) ;;
*)
	echo "RUNTIME_ROLE must be engine-and-workerd or workerd-only" >&2
	exit 1
	;;
esac
[[ $engine_endpoint =~ ^https?://[A-Za-z0-9._-]+:[0-9]+$ ]] || {
	echo "invalid ENGINE_ENDPOINT" >&2
	exit 1
}
[[ $engine_health_url =~ ^https?://[A-Za-z0-9._-]+:[0-9]+/[A-Za-z0-9_./-]+$ ]] || {
	echo "invalid ENGINE_HEALTH_URL" >&2
	exit 1
}
[[ $runner_pool_name =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || {
	echo "invalid RUNNER_POOL_NAME" >&2
	exit 1
}
[[ $engine_auth_token =~ ^[A-Za-z0-9._~-]{3,256}$ ]] || {
	echo "invalid ENGINE_AUTH_TOKEN" >&2
	exit 1
}
if [[ $runtime_role == workerd-only && $engine_endpoint == http://127.0.0.1:6420 ]]; then
	echo "workerd-only requires a non-loopback ENGINE_ENDPOINT" >&2
	exit 1
fi

for path in "$workerd_artifact" "$host_artifact" "$engine_artifact"; do
	test -f "$path"
done
if [[ $runtime_role == engine-and-workerd ]]; then
	test -f "$fdb_cluster"
	test -f "$blob_credentials"
fi
test -x "$workerd_artifact"
test -x "$host_artifact"
test -x "$engine_artifact"

# Production workerd and its Rivet host are native, statically-linked musl
# executables. Refuse dynamic artifacts here so a release can never
# accidentally depend on a container image (or on the host's glibc version)
# for compatibility.
command -v readelf >/dev/null
for artifact in "$workerd_artifact" "$host_artifact"; do
	if readelf -l "$artifact" | grep -q 'INTERP'; then
		echo "refusing dynamically-linked artifact: PT_INTERP is present: $artifact" >&2
		exit 1
	fi
	if readelf --version-info "$artifact" 2>/dev/null | grep -q 'GLIBC_'; then
		echo "refusing glibc-linked artifact: GLIBC version dependency is present: $artifact" >&2
		exit 1
	fi
	if readelf -d "$artifact" 2>/dev/null | grep -q '(NEEDED)'; then
		echo "refusing dynamically-linked artifact: shared-library dependency is present: $artifact" >&2
		exit 1
	fi
done
"$workerd_artifact" --version >/dev/null
"$host_artifact" --help >/dev/null

workerd_sha=$(sha256sum "$workerd_artifact" | awk '{print $1}')
host_sha=$(sha256sum "$host_artifact" | awk '{print $1}')
engine_sha=$(sha256sum "$engine_artifact" | awk '{print $1}')
release_id=${workerd_sha:0:16}-${host_sha:0:16}-${engine_sha:0:16}
release_root=/opt/actor/rivet-workerd/releases/$release_id
config_root=/etc/actor/rivet-workerd

getent group actor-stack >/dev/null || groupadd --system actor-stack
for user in actor-engine actor-workerd; do
	getent group "$user" >/dev/null || groupadd --system "$user"
	if ! id "$user" >/dev/null 2>&1; then
		useradd --system --no-create-home --home-dir /nonexistent \
			--shell /sbin/nologin --gid "$user" "$user"
	else
		usermod --gid "$user" "$user"
	fi
	usermod --append --groups actor-stack "$user"
done

install -d -m 0755 /opt/actor/rivet-workerd/releases
install -d -m 0755 "$release_root/bin" "$release_root/workerd"
install -m 0755 "$workerd_artifact" "$release_root/bin/workerd"
install -m 0755 "$host_artifact" "$release_root/bin/rivet-workerd-host"
install -m 0755 "$engine_artifact" "$release_root/bin/rivet-engine"
install -m 0755 "$script_dir/init-workerd-pool.sh" "$release_root/bin/init-workerd-pool"
install -m 0644 "$host_source/runtimes/workerd/host/workerd/worker.js" \
	"$release_root/workerd/worker.js"
install -m 0644 "$host_source/runtimes/workerd/host/workerd/config-depot.capnp" \
	"$release_root/workerd/config-depot.capnp"

install -d -m 0750 -o root -g actor-stack "$config_root"
CELL_ID=$cell_id python3 - <<'PY'
import os
from pathlib import Path

target = Path("/etc/actor/cell-id")
if target.exists() and target.read_text().strip() != os.environ["CELL_ID"]:
    raise SystemExit("refusing to overwrite a different installed Cell identity")
temporary = target.with_suffix(".tmp")
temporary.write_text(os.environ["CELL_ID"] + "\n")
os.chmod(temporary, 0o644)
os.replace(temporary, target)
PY
CELL_ID=$cell_id RELEASE_ID=$release_id RUNTIME_ROLE=$runtime_role \
	RUNNER_POOL_NAME=$runner_pool_name WORKERD_SHA256=$workerd_sha \
	HOST_SHA256=$host_sha ENGINE_SHA256=$engine_sha python3 - <<'PY'
import json
import os
from pathlib import Path

document = {
    "schema_version": 1,
    "cell_id": os.environ["CELL_ID"],
    "release_id": os.environ["RELEASE_ID"],
    "runtime_role": os.environ["RUNTIME_ROLE"],
    "runner_pool_name": os.environ["RUNNER_POOL_NAME"],
    "artifacts": {
        "workerd_sha256": os.environ["WORKERD_SHA256"],
        "workerd_host_sha256": os.environ["HOST_SHA256"],
        "engine_sha256": os.environ["ENGINE_SHA256"],
    },
}
target = Path("/etc/actor/rivet-workerd/release.json")
temporary = target.with_suffix(".tmp")
temporary.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
os.chmod(temporary, 0o644)
os.replace(temporary, target)
PY
CELL_ID=$cell_id COLD_BUCKET=$cold_bucket \
	CONFIG_SOURCE="$script_dir/config.beijing-production.jsonc" \
	CONFIG_TARGET="$config_root/config.jsonc" \
	python3 - <<'PY'
import os
from pathlib import Path

source = Path(os.environ["CONFIG_SOURCE"]).read_text()
expected_bucket = "actor-depot-cold-prod-bj-a01-nv1-1388575217"
if source.count(expected_bucket) != 1:
    raise SystemExit("production template must contain exactly one Cell A cold bucket")
rendered = source.replace(expected_bucket, os.environ["COLD_BUCKET"])
if rendered.count("actor-bj-a01") != 1:
    raise SystemExit("production template must contain exactly one Cell identity")
rendered = rendered.replace("actor-bj-a01", os.environ["CELL_ID"])
target = Path(os.environ["CONFIG_TARGET"])
temporary = target.with_suffix(".tmp")
temporary.write_text(rendered)
os.chmod(temporary, 0o640)
os.replace(temporary, target)
PY
chown root:actor-engine "$config_root/config.jsonc"
install -m 0640 -o root -g actor-workerd "$release_root/workerd/worker.js" \
	"$config_root/worker.js"

workerd_env=$config_root/workerd.env
if [[ ! -f "$workerd_env" ]]; then
	token=$(openssl rand -hex 32)
	(umask 0027; printf 'RIVET_WORKERD_TOKEN=%s\n' "$token" >"$workerd_env")
	chown root:actor-workerd "$workerd_env"
else
	token=$(sed -n 's/^RIVET_WORKERD_TOKEN=//p' "$workerd_env")
fi
if [[ ! "$token" =~ ^[0-9a-f]{64}$ ]]; then
	echo "refusing invalid workerd token file" >&2
	exit 1
fi

TOKEN=$token \
SOURCE_CONFIG=$release_root/workerd/config-depot.capnp \
TARGET_CONFIG=$config_root/config-depot.capnp \
python3 - <<'PY'
import os
from pathlib import Path

source = Path(os.environ["SOURCE_CONFIG"]).read_text()
if source.count('text = "dev-only-change-me"') != 1:
    raise SystemExit("expected exactly one development token binding")
rendered = source.replace(
    'text = "dev-only-change-me"',
    f'text = "{os.environ["TOKEN"]}"',
)
target = Path(os.environ["TARGET_CONFIG"])
temporary = target.with_suffix(".tmp")
temporary.write_text(rendered)
os.chmod(temporary, 0o640)
os.replace(temporary, target)
PY
chown root:actor-workerd "$config_root/config-depot.capnp"

envoy_env=$config_root/envoy.env
(umask 0027; {
	printf 'RIVET_ENDPOINT=%s\n' "$engine_endpoint"
	printf 'RIVET_API_URL=%s\n' "$engine_endpoint"
	printf 'RIVET_HEALTH_URL=%s\n' "$engine_health_url"
	printf 'RIVET_POOL_NAME=%s\n' "$runner_pool_name"
	printf 'RIVET_RUNNER_NAME=%s\n' "$runner_pool_name"
	printf 'RIVET_NAMESPACE=default\n'
	printf 'RIVET_TOKEN=%s\n' "$engine_auth_token"
	printf 'RIVET_AUTH_TOKEN=%s\n' "$engine_auth_token"
} >"$envoy_env")
chown root:actor-stack "$envoy_env"

if [[ $runtime_role == engine-and-workerd ]]; then
	BLOB_CREDENTIALS_FILE=$blob_credentials \
	ENGINE_ENV=$config_root/engine.env \
	python3 - <<'PY'
import json
import os
import re
from pathlib import Path

document = json.loads(Path(os.environ["BLOB_CREDENTIALS_FILE"]).read_text())
accounts = document.get("accounts")
if not isinstance(accounts, dict) or len(accounts) != 1:
    raise SystemExit("expected one COS blob credential account")
credential = next(iter(accounts.values()))
access_key = credential.get("api_key")
secret_key = credential.get("secret")
safe = re.compile(r"^[A-Za-z0-9+/=_-]+$")
if not isinstance(access_key, str) or not safe.fullmatch(access_key):
    raise SystemExit("invalid COS access key")
if not isinstance(secret_key, str) or not safe.fullmatch(secret_key):
    raise SystemExit("invalid COS secret key")
target = Path(os.environ["ENGINE_ENV"])
temporary = target.with_suffix(".tmp")
temporary.write_text(
    f"AWS_ACCESS_KEY_ID={access_key}\n"
    f"AWS_SECRET_ACCESS_KEY={secret_key}\n"
    "AWS_EC2_METADATA_DISABLED=true\n"
)
os.chmod(temporary, 0o640)
os.replace(temporary, target)
PY
	chown root:actor-engine "$config_root/engine.env"
	install -m 0640 -o root -g actor-engine "$fdb_cluster" "$config_root/fdb.cluster"

	# Parse and validate the exact installed production config with the production
	# engine before changing the release symlink or restarting any service.
	set -a
	# shellcheck disable=SC1090
	. "$config_root/engine.env"
	set +a
	runuser -u actor-engine -- env \
		AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
		AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
		AWS_EC2_METADATA_DISABLED=true \
		"$release_root/bin/rivet-engine" \
		--config "$config_root/config.jsonc" config show >/dev/null
fi

next_link=/opt/actor/rivet-workerd/.current.$$
ln -s "$release_root" "$next_link"
mv -Tf "$next_link" /opt/actor/rivet-workerd/current

for unit in \
	actor-rivet-engine.service \
	actor-workerd.service \
	actor-rivet-workerd-pool-init.service \
	actor-rivet-workerd-host.service
do
	install -m 0644 "$script_dir/systemd/$unit" "/etc/systemd/system/$unit"
done

systemctl daemon-reload
systemctl enable actor-workerd.service actor-rivet-workerd-pool-init.service \
	actor-rivet-workerd-host.service >/dev/null
if [[ $runtime_role == engine-and-workerd ]]; then
	systemctl enable actor-rivet-engine.service >/dev/null
	systemctl restart actor-rivet-engine.service
else
	systemctl disable --now actor-rivet-engine.service >/dev/null 2>&1 || true
fi
systemctl restart actor-workerd.service
systemctl restart actor-rivet-workerd-pool-init.service
systemctl restart actor-rivet-workerd-host.service

if [[ $runtime_role == engine-and-workerd ]]; then
	systemctl is-active --quiet actor-rivet-engine.service
fi
systemctl is-active --quiet actor-workerd.service
systemctl is-active --quiet actor-rivet-workerd-host.service
curl --fail --silent "$engine_health_url" >/dev/null

printf 'release=%s\n' "$release_id"
printf 'workerd_sha256=%s\n' "$workerd_sha"
printf 'host_sha256=%s\n' "$host_sha"
printf 'engine_sha256=%s\n' "$engine_sha"
printf 'runtime_role=%s engine_endpoint=%s runner_pool=%s\n' \
	"$runtime_role" "$engine_endpoint" "$runner_pool_name"
printf 'workerd=active host=active pool=initialized\n'
