# syntax=docker/dockerfile:1.7

FROM golang:1.26-bookworm AS builder
WORKDIR /src/cloudladdergateway

COPY cloudladdergateway/go.mod cloudladdergateway/go.sum ./
COPY shared/cloudladdertransport/go.mod /src/shared/cloudladdertransport/go.mod
RUN go mod download

COPY shared/cloudladdertransport/ /src/shared/cloudladdertransport/
COPY cloudladdergateway/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/cloudladdergateway ./cmd/cloudladdergateway
# devtunnel：反向回调隧道服务端，打进同一镜像，由工作负载 command 覆盖成入口。
# 详见 internal/devtunnel 包注释与 argocd/services/.../devtunnel-testing.yaml。
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/devtunnel ./cmd/devtunnel

FROM --platform=linux/amd64 alpine:3.20
RUN apk add --no-cache \
    bash \
    bind-tools \
    busybox-extras \
    ca-certificates \
    curl \
    iproute2 \
    lsof \
    netcat-openbsd \
    procps \
    strace \
    tmux \
    tzdata \
    wget
WORKDIR /app

COPY --from=builder /out/cloudladdergateway /usr/local/bin/cloudladdergateway
COPY --from=builder /out/devtunnel /usr/local/bin/devtunnel
COPY cloudladdergateway/config.example.yaml /etc/cloudladdergateway/config.yaml

ENV CLOUDLADDERGATEWAY_CONFIG=/etc/cloudladdergateway/config.yaml
EXPOSE 8095

ENTRYPOINT ["/usr/local/bin/cloudladdergateway"]
