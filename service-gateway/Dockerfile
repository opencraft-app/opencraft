# syntax=docker/dockerfile:1.7

FROM golang:1.26-bookworm AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/service-gateway ./cmd/service-gateway

FROM --platform=linux/amd64 alpine:3.20
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=builder /out/service-gateway /usr/local/bin/service-gateway
ENV SERVICE_GATEWAY_ADDR=:8085
ENV SERVICE_GATEWAY_CONFIG_FILE=/etc/service-gateway/config.yaml
EXPOSE 8085
ENTRYPOINT ["/usr/local/bin/service-gateway"]
