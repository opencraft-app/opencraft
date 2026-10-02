# syntax=docker/dockerfile:1.7
FROM ubuntu:24.04@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        bash busybox-static ca-certificates curl e2fsprogs gzip libgcc-s1 && \
    rm -rf /var/lib/apt/lists/* && \
    install -d -o 4059 -g 4059 -m 0750 \
        /opt/minisandbox/bin /opt/minisandbox/artifacts /var/lib/minisandbox

RUN curl -Lf -o /usr/lib/libfdb_c.so \
        https://github.com/apple/foundationdb/releases/download/7.3.68/libfdb_c.x86_64.so && \
    echo '8c96a1f7ab561cd38e16e4c269c5e50ae0fd8063854e0d72c89339a7ac1b6873  /usr/lib/libfdb_c.so' | \
        sha256sum --check --strict

COPY --from=sbxlet --chmod=0755 sbxlet /opt/minisandbox/bin/sbxlet
COPY --from=pvm --chmod=0644 build/arch/x86/boot/bzImage /opt/minisandbox/artifacts/bzImage
COPY --from=pvm --chmod=0644 hermes-base-d66341ab2863-x86_64.erofs /opt/minisandbox/artifacts/hermes-base.erofs
COPY --from=pvm --chmod=0644 hermes-app-d66341ab2863-x86_64.erofs /opt/minisandbox/artifacts/hermes-app.erofs
COPY --from=pvm --chmod=0644 hermes-base-d66341ab2863-x86_64.erofs.metadata.json /opt/minisandbox/artifacts/hermes-base.erofs.metadata.json
COPY --from=pvm --chmod=0644 hermes-app-d66341ab2863-x86_64.erofs.metadata.json /opt/minisandbox/artifacts/hermes-app.erofs.metadata.json
COPY --from=pvm --chmod=0644 actor-volume-template-2g.ext4.gz /opt/minisandbox/artifacts/actor-volume-template.ext4.gz
COPY --from=pvm --chmod=0644 actor-volume-template-2g.ext4.metadata.json /opt/minisandbox/artifacts/actor-volume-template.ext4.metadata.json

ARG ACTOR_VOLUME_SHA256
COPY --chmod=0755 entrypoint.sh /opt/minisandbox/bin/entrypoint

ARG SOURCE_REVISION
ARG SBXLET_SHA256
ARG KERNEL_SHA256
ARG BASE_EROFS_SHA256
ARG APP_EROFS_SHA256
LABEL dev.rivet.minisandbox.actor-volume.sha256="${ACTOR_VOLUME_SHA256}"
LABEL org.opencontainers.image.source="https://github.com/rivet-dev/rivet" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      dev.rivet.minisandbox.sbxlet.sha256="${SBXLET_SHA256}" \
      dev.rivet.minisandbox.kernel.sha256="${KERNEL_SHA256}" \
      dev.rivet.minisandbox.base-erofs.sha256="${BASE_EROFS_SHA256}" \
      dev.rivet.minisandbox.app-erofs.sha256="${APP_EROFS_SHA256}"

ENV RIVET_MINISANDBOX_KERNEL=/opt/minisandbox/artifacts/bzImage \
    RIVET_MINISANDBOX_BASE_EROFS=/opt/minisandbox/artifacts/hermes-base.erofs \
    RIVET_MINISANDBOX_APP_EROFS=/opt/minisandbox/artifacts/hermes-app.erofs \
    RIVET_MINISANDBOX_ACTOR_VOLUME_TEMPLATE_GZIP=/opt/minisandbox/artifacts/actor-volume-template.ext4.gz \
    RIVET_MINISANDBOX_ACTOR_VOLUME_TEMPLATE_SHA256=${ACTOR_VOLUME_SHA256} \
    RIVET_MINISANDBOX_UPPER=/var/lib/minisandbox/hermes-upper.ext4 \
    RIVET_MINISANDBOX_BLOCK_POOL=/var/lib/minisandbox/block-pool \
    RIVET_READINESS_FILE=/var/lib/minisandbox/ready

RUN /opt/minisandbox/bin/sbxlet --version >/dev/null

USER 4059:4059
WORKDIR /var/lib/minisandbox
STOPSIGNAL SIGTERM
ENTRYPOINT ["/opt/minisandbox/bin/entrypoint"]
