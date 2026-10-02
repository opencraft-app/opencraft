# Ordinary builds are network-independent: Python and OS dependencies were
# installed once in the reviewed private build base.
ARG ACTOR_LOADGEN_BASE_IMAGE
FROM ${ACTOR_LOADGEN_BASE_IMAGE}
ARG ACTOR_LOADGEN_BASE_IMAGE

ARG SOURCE_REVISION
ARG SOURCE_MANIFEST_SHA256
COPY --chmod=0555 deploy/tencent/qualify_dormant_actors.py /usr/local/bin/qualify-dormant-actors

USER 65532:65532
WORKDIR /state
ENTRYPOINT ["python3", "/usr/local/bin/qualify-dormant-actors"]

LABEL org.opencontainers.image.title="Actor FDB autoscaling load generator" \
      fleet.actor.dev/source-revision="${SOURCE_REVISION}" \
      fleet.actor.dev/source-manifest-sha256="${SOURCE_MANIFEST_SHA256}" \
      fleet.actor.dev/base-image="${ACTOR_LOADGEN_BASE_IMAGE}"
