# syntax=docker/dockerfile:1.7

FROM golang:1.26-bookworm AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/site-gateway ./cmd/site-gateway

FROM --platform=linux/amd64 alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=builder /out/site-gateway /usr/local/bin/site-gateway
# 站点入口和健康检查分开监听：站点的路径空间完全属于用户，
# 把探针挂在同一个端口会占用用户可能用到的路径。
ENV SITE_GATEWAY_ADDR=:8080 \
    SITE_GATEWAY_ADMIN_ADDR=:8081
EXPOSE 8080 8081
ENTRYPOINT ["/usr/local/bin/site-gateway"]
