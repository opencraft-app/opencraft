#!/bin/bash
set -euo pipefail

public_ip=$(hostname -i | awk '{print $1}')
mkdir -p /var/fdb/data /var/fdb/logs
printf '%s\n' "$FDB_CLUSTER_FILE_CONTENTS" >/var/fdb/fdb.cluster

exec fdbserver \
	--listen-address "0.0.0.0:${FDB_PORT:-4500}" \
	--public-address "$public_ip:${FDB_PORT:-4500}" \
	--datadir /var/fdb/data \
	--logdir /var/fdb/logs \
	--locality-zoneid="$(hostname)" \
	--locality-machineid="$(hostname)" \
	--class "${FDB_PROCESS_CLASS:-storage}" \
	--knob_min_available_space=16777216 \
	--knob_min_available_space_ratio=0.01
