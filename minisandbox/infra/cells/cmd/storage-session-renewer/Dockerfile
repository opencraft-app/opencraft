# Supply a reviewed digest-pinned nonroot Linux base containing public CA roots.
ARG RUNTIME_BASE
FROM ${RUNTIME_BASE}
COPY --chmod=0555 storage-session-renewer /storage-session-renewer
USER 65532:65532
ENTRYPOINT ["/storage-session-renewer"]
