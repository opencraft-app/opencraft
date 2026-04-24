# syntax=docker/dockerfile:1.7

FROM golang:1.25-bookworm AS go-builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/admind ./cmd/admind
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/ops-runner ./cmd/ops-runner
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/lcctl ./cmd/lcctl

FROM --platform=linux/amd64 alpine:3.20
RUN apk add --no-cache \
    bash \
    ca-certificates \
    curl \
    wget \
    tmux \
    screen \
    vim \
    lsof \
    strace \
    mysql-client \
    redis

WORKDIR /app
COPY --from=go-builder /out/admind /usr/local/bin/admind
COPY --from=go-builder /out/ops-runner /usr/local/bin/ops-runner
COPY --from=go-builder /out/lcctl /usr/local/bin/lcctl
RUN ln -sf /usr/local/bin/lcctl /usr/local/bin/users \
  && ln -sf /usr/local/bin/lcctl /usr/local/bin/subscriptions \
  && ln -sf /usr/local/bin/lcctl /usr/local/bin/sandboxes

ENV NEXTGEN_DASHBOARD_ADDR=:8084
ENV NEXTGEN_RUNNER_ADDR=127.0.0.1:19091
ENV NEXTGEN_RUNNER_SHELL=/bin/bash

EXPOSE 8084
