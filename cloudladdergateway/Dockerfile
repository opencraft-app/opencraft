# syntax=docker/dockerfile:1.7

FROM golang:1.26-bookworm AS builder
WORKDIR /src/cloudladdergateway

COPY cloudladdergateway/go.mod cloudladdergateway/go.sum ./
RUN go mod download

COPY cloudladdergateway/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/cloudladdergateway ./cmd/cloudladdergateway

FROM --platform=linux/amd64 alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app

COPY --from=builder /out/cloudladdergateway /usr/local/bin/cloudladdergateway
COPY cloudladdergateway/config.example.yaml /etc/cloudladdergateway/config.yaml

ENV CLOUDLADDERGATEWAY_CONFIG=/etc/cloudladdergateway/config.yaml
EXPOSE 8095

ENTRYPOINT ["/usr/local/bin/cloudladdergateway"]
