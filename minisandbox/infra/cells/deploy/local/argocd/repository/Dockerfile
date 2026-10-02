FROM alpine/git:2.49.1 AS prepare
COPY repo.git /srv/repo.git

FROM alpine:3.22.1
RUN apk add --no-cache git-daemon
COPY --from=prepare --chown=65534:65534 /srv/repo.git /srv/repo.git
USER 65534:65534
EXPOSE 9418
ENTRYPOINT ["git", "daemon", "--reuseaddr", "--base-path=/srv", "--export-all", "--verbose"]
