ARG RUNTIME_BASE_IMAGE
FROM ${RUNTIME_BASE_IMAGE}
USER 0:0

RUN install -d -m 0755 /opt/actor/bin /opt/actor/share /usr/local/lib /var/lib/actor-runtime

COPY --chmod=0755 rivet-engine rivet-workerd-host workerd init-workerd-pool /opt/actor/bin/
COPY --chmod=0644 worker.js stateless-worker.js config-depot.capnp config-stateless.capnp source-revision source-manifest-sha256 /opt/actor/share/
COPY --chmod=0755 libfdb_c.so /usr/local/lib/libfdb_c.so

ENV LD_LIBRARY_PATH=/usr/local/lib
RUN /opt/actor/bin/workerd --version >/dev/null && \
    /opt/actor/bin/rivet-workerd-host --help >/dev/null && \
    /opt/actor/bin/rivet-engine --help >/dev/null

USER 4059:4059
WORKDIR /var/lib/actor-runtime
STOPSIGNAL SIGTERM

LABEL org.opencontainers.image.title="Rivet FDB/COS runtime"
