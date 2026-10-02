#!/bin/sh

set -eu

[ -c /dev/null ] || mount -t devtmpfs devtmpfs /dev
mount -t proc proc /proc
mount -t sysfs sysfs /sys

echo MSBENCH_DEBIAN_BOOT
echo "MSBENCH_ROOT=$(awk '$2 == "/" { print $1, $3, $4 }' /proc/mounts)"
exec /usr/bin/python3 /opt/msbench/driver.py
