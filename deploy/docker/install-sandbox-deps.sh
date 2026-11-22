#!/bin/sh
# Image-build step shared by Docker Hands and E2B fromImage. Do not run on hosts.
set -eu
packages='systemd systemd-sysv openssh-server sudo chrony socat curl ca-certificates fuse3 iptables git nfs-common less nftables iputils-ping jq iproute2'
missing=''
for package in $packages; do
    if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
        missing="$missing $package"
    fi
done
if [ -z "$missing" ]; then
    # Even an already prepared base must not retain a shared SSH identity.
    rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub
    exit 0
fi

# Package configuration must not start daemons in the image builder. Preserve
# the base image's policy when it already supplies one.
created_policy=false
if [ ! -e /usr/sbin/policy-rc.d ]; then
    printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
    chmod 755 /usr/sbin/policy-rc.d
    created_policy=true
fi
cleanup() {
    if [ "$created_policy" = true ]; then rm -f /usr/sbin/policy-rc.d; fi
}
trap cleanup EXIT
apt-get update
# Word splitting here expands the package list, never shell commands.
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $missing
rm -rf /var/lib/apt/lists/*
# SSH identity belongs to each VM, never to a common image.
rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub
