# syntax=docker/dockerfile:1.7
FROM golang:1.24-bullseye AS builder
WORKDIR /src
ENV GOTOOLCHAIN=auto

COPY shared/cloudladdertransport/go.mod shared/cloudladdertransport/go.mod
COPY user/auth/go.mod user/auth/go.sum user/auth/

WORKDIR /src/user/auth
RUN go mod download

WORKDIR /src
COPY shared/cloudladdertransport shared/cloudladdertransport
COPY user/auth user/auth

WORKDIR /src/user/auth
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/lightclaw-auth ./cmd/lightclaw-auth
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/lightclaw-auth-content-audit-worker ./cmd/lightclaw-auth-content-audit-worker
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/lightclaw-auth-migrate ./cmd/lightclaw-auth-migrate
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/lightclaw-auth-seed ./cmd/lightclaw-auth-seed

FROM alpine:3.20
RUN adduser -D -u 10001 app
WORKDIR /home/app
COPY --from=builder /out/lightclaw-auth /usr/local/bin/lightclaw-auth
COPY --from=builder /out/lightclaw-auth-content-audit-worker /usr/local/bin/lightclaw-auth-content-audit-worker
COPY --from=builder /out/lightclaw-auth-migrate /usr/local/bin/lightclaw-auth-migrate
COPY --from=builder /out/lightclaw-auth-seed /usr/local/bin/lightclaw-auth-seed
USER app
ENV LIGHTCLAW_AUTH_ADDR=:8081
EXPOSE 8081
CMD ["lightclaw-auth"]
