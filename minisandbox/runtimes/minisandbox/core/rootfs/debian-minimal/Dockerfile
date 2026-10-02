# linux/amd64 manifest from the Debian 13.6 (2026-07-13) official slim image.
# Updating this digest is an explicit rootfs source change.
FROM docker.io/library/debian@sha256:9bb8a3626890e084ab54e888fdd7c4b6d2f119071cd4c5dc5fecb4d73062aa5f

ENV LANG=C.UTF-8

COPY debian.sources /etc/apt/sources.list.d/debian.sources
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        bash \
        bind9-dnsutils \
        ca-certificates \
        curl \
        gcc \
        git \
        libc6-dev \
        nodejs \
        procps \
        python3 \
        screen \
        strace \
        tmux \
        vim \
        wget; \
    mkdir -p /usr/share/minisandbox /opt/minisandbox; \
    dpkg-query -W -f='${binary:Package}\t${Version}\n' \
        | LC_ALL=C sort > /usr/share/minisandbox/packages.tsv; \
    rm -rf \
        /var/lib/apt/lists/* \
        /var/cache/apt/archives/*.deb \
        /var/log/apt/* \
        /var/log/dpkg.log

COPY minisandbox-init /sbin/minisandbox-init
COPY minisandbox-warm /opt/minisandbox/minisandbox-warm
COPY python-warm.py /opt/minisandbox/python-warm.py
COPY block_stress.py /opt/minisandbox/block_stress.py
RUN chmod 0755 /sbin/minisandbox-init; \
    chmod 0755 /opt/minisandbox/minisandbox-warm; \
    sha256sum /sbin/minisandbox-init > /usr/share/minisandbox/init.sha256; \
    chmod 0644 /opt/minisandbox/python-warm.py /opt/minisandbox/block_stress.py

LABEL io.minisandbox.rootfs.profile="debian-minimal-v6"
ENTRYPOINT ["/sbin/minisandbox-init"]
