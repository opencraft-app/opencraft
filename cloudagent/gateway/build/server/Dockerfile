FROM golang:1.24-bookworm AS build

WORKDIR /src/gateway
COPY go.mod go.sum ./
COPY cmd ./cmd
COPY internal ./internal

RUN mkdir -p /out \
    && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags '-s -w -buildid=' -o /out ./cmd/server ./cmd/runtime-pool-worker

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --home-dir /home/app --uid 10001 app

COPY --from=build /out/server /usr/local/bin/gateway-server
COPY --from=build /out/runtime-pool-worker /usr/local/bin/runtime-pool-worker

USER app
WORKDIR /home/app
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/gateway-server"]
