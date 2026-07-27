# syntax=docker/dockerfile:1.7
FROM golang:1.22-bullseye AS builder
ARG TARGETARCH
WORKDIR /app
ENV GOTOOLCHAIN=go1.24.0
RUN GOBIN=/out CGO_ENABLED=0 GOOS=linux GOARCH="${TARGETARCH}" \
  go install -tags 'mysql' github.com/golang-migrate/migrate/v4/cmd/migrate@v4.19.0

FROM alpine:3.19
RUN adduser -D -u 10003 app
WORKDIR /home/app
COPY --from=builder /out/migrate /usr/local/bin/migrate
COPY migrations /migrations
USER app
ENTRYPOINT ["migrate"]
