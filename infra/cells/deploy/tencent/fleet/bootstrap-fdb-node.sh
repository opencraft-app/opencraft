#!/usr/bin/env bash
set -euo pipefail

# Bootstrap one native FoundationDB process. The caller must stage the exact
# 7.3.79 artifacts and a cell-local cluster file before invoking this script.
# This script intentionally refuses ambiguous or previously-used data disks.

if [[ ${BASH_SOURCE[0]} == "$0" && $(id -u) -ne 0 ]]; then
	echo "bootstrap-fdb-node.sh must run as root" >&2
	exit 1
fi

select_data_device_from_inventory() {
	local inventory=$1
	local expected_bytes=${2:-214748364800}
	local tolerance_bytes=$((1024 * 1024 * 1024))
	local candidates=()
	local name type size mountpoint

	while IFS='|' read -r name type size mountpoint; do
		[[ $type == disk ]] || continue
		[[ $size =~ ^[0-9]+$ ]] || continue
		(( size >= expected_bytes - tolerance_bytes )) || continue
		(( size <= expected_bytes + tolerance_bytes )) || continue
		[[ -z $mountpoint ]] || continue
		candidates+=("/dev/$name")
	done <<<"$inventory"

	if (( ${#candidates[@]} != 1 )); then
		echo "expected exactly one unmounted 200 GiB data disk; found ${#candidates[@]}" >&2
		return 1
	fi
	printf '%s\n' "${candidates[0]}"
}

install_fdb_node() {
	: "${NODE_IP:?NODE_IP is required}"
	: "${DATA_HALL:?DATA_HALL is required}"
	: "${FDB_ARTIFACT_DIR:?FDB_ARTIFACT_DIR is required}"
	: "${FDB_CLUSTER_FILE:?FDB_CLUSTER_FILE is required}"

	[[ $NODE_IP =~ ^10\.128\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || {
		echo "NODE_IP must be an Actor VPC address" >&2
		return 1
	}
	[[ $DATA_HALL =~ ^ap-beijing-(6|7|8)$ ]] || {
		echo "unexpected DATA_HALL: $DATA_HALL" >&2
		return 1
	}
	grep -Eq '^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+@([^,]+:4500,){4}[^,]+:4500$' "$FDB_CLUSTER_FILE" || {
		echo "invalid five-coordinator FDB cluster file" >&2
		return 1
	}

	(cd "$FDB_ARTIFACT_DIR" && sha256sum --check SHA256SUMS)

	local inventory data_device filesystem_label data_uuid
	# TencentOS 3 ships a util-linux release without --output-separator. Convert
	# its stable column output explicitly; an unmounted device has only 3 fields.
	inventory=$(lsblk -dnbo NAME,TYPE,SIZE,MOUNTPOINT | awk '
		{
			mountpoint = (NF >= 4 ? $4 : "")
			print $1 "|" $2 "|" $3 "|" mountpoint
		}')
	data_device=$(select_data_device_from_inventory "$inventory")
	filesystem_label=$(blkid -s LABEL -o value "$data_device" 2>/dev/null || true)

	if [[ -z $filesystem_label ]]; then
		if blkid "$data_device" >/dev/null 2>&1; then
			echo "refusing an existing unlabeled filesystem on $data_device" >&2
			return 1
		fi
		command -v mkfs.xfs >/dev/null
		# XFS labels are limited to 12 characters.
		mkfs.xfs -f -L ACTORFDBB01 "$data_device" >/dev/null
	elif [[ $filesystem_label != ACTORFDBB01 ]]; then
		echo "refusing unexpected filesystem label on $data_device: $filesystem_label" >&2
		return 1
	fi

	data_uuid=$(blkid -s UUID -o value "$data_device")
	[[ $data_uuid =~ ^[A-Fa-f0-9-]+$ ]]
	install -d -m 0755 /var/lib/actor-fdb
	if ! grep -q "^UUID=$data_uuid " /etc/fstab; then
		printf 'UUID=%s /var/lib/actor-fdb xfs defaults,noatime,nofail 0 2\n' "$data_uuid" >>/etc/fstab
	fi
	mountpoint -q /var/lib/actor-fdb || mount /var/lib/actor-fdb
	[[ $(findmnt -n -o UUID /var/lib/actor-fdb) == "$data_uuid" ]]

	getent group foundationdb >/dev/null || groupadd --system foundationdb
	if ! id foundationdb >/dev/null 2>&1; then
		useradd --system --no-create-home --home-dir /var/lib/foundationdb \
			--shell /sbin/nologin --gid foundationdb foundationdb
	fi
	install -d -m 0750 -o foundationdb -g foundationdb \
		/var/lib/actor-fdb/data /var/lib/actor-fdb/logs
	install -d -m 0750 -o root -g foundationdb /etc/foundationdb
	install -m 0755 "$FDB_ARTIFACT_DIR/fdbserver" /usr/sbin/fdbserver
	install -m 0755 "$FDB_ARTIFACT_DIR/fdbmonitor" /usr/sbin/fdbmonitor
	install -m 0755 "$FDB_ARTIFACT_DIR/fdbcli" /usr/bin/fdbcli
	install -m 0755 "$FDB_ARTIFACT_DIR/libfdb_c.so" /usr/lib64/libfdb_c.so
	install -m 0640 -o root -g foundationdb "$FDB_CLUSTER_FILE" /etc/foundationdb/fdb.cluster

	cat >/etc/foundationdb/foundationdb.conf <<EOF
[fdbmonitor]
user = foundationdb
group = foundationdb

[general]
restart-delay = 60
cluster-file = /etc/foundationdb/fdb.cluster

[fdbserver]
command = /usr/sbin/fdbserver
public-address = ${NODE_IP}:\$ID
listen-address = public
datadir = /var/lib/actor-fdb/data/\$ID
logdir = /var/lib/actor-fdb/logs
memory = 6GiB
locality-machineid = ${NODE_IP}
locality-zoneid = ${NODE_IP}
locality-data-hall = ${DATA_HALL}

[fdbserver.4500]
EOF
	chmod 0640 /etc/foundationdb/foundationdb.conf
	chown root:foundationdb /etc/foundationdb/foundationdb.conf

	cat >/etc/systemd/system/foundationdb.service <<'EOF'
[Unit]
Description=FoundationDB native process monitor
After=network-online.target var-lib-actor\x2dfdb.mount
Wants=network-online.target
RequiresMountsFor=/var/lib/actor-fdb

[Service]
Type=simple
ExecStart=/usr/sbin/fdbmonitor --conffile /etc/foundationdb/foundationdb.conf --lockfile /run/foundationdb/fdbmonitor.pid
RuntimeDirectory=foundationdb
RuntimeDirectoryMode=0755
Restart=always
RestartSec=5
KillMode=control-group
TimeoutStopSec=120
LimitNOFILE=1000000
OOMScoreAdjust=-500

[Install]
WantedBy=multi-user.target
EOF

	systemctl daemon-reload
	systemctl enable --now foundationdb.service >/dev/null
	systemctl is-active --quiet foundationdb.service
	for _ in $(seq 1 30); do
		ss -lnt | grep -q "${NODE_IP}:4500" && break
		sleep 1
	done
	ss -lnt | grep -q "${NODE_IP}:4500"
	printf 'node=%s data_hall=%s device=%s uuid=%s fdbmonitor=active\n' \
		"$NODE_IP" "$DATA_HALL" "$data_device" "$data_uuid"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
	install_fdb_node
fi
