# syntax=docker/dockerfile:1.7
FROM golang:1.26-bookworm AS builder
WORKDIR /src
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/site-runtime ./cmd/site-runtime

FROM --platform=linux/amd64 alpine:3.20
RUN apk add --no-cache ca-certificates \
    && addgroup -g 65532 -S website-runtime \
    && adduser -u 65532 -S -G website-runtime website-runtime \
    && mkdir -p /var/lib/website-runtime \
    && chown 65532:65532 /var/lib/website-runtime
COPY --from=builder /out/site-runtime /usr/local/bin/site-runtime
USER 65532:65532
ENV WEBSITE_RUNTIME_ADDR=:8090 \
    WEBSITE_RUNTIME_DATA_DIR=/var/lib/website-runtime
EXPOSE 8090
ENTRYPOINT ["/usr/local/bin/site-runtime"]
