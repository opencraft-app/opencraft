FROM golang:1.22-bookworm AS build

WORKDIR /src/cloudagent
COPY cloudagent/acp-client ./acp-client
COPY cloudagent/channelgateway ./channelgateway

WORKDIR /src/cloudagent/channelgateway
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags '-s -w -buildid=' -o /out/channelgateway ./cmd/channelgateway

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --home-dir /home/app --uid 10001 app

COPY --from=build /out/channelgateway /usr/local/bin/channelgateway

USER app
WORKDIR /home/app
EXPOSE 8094

ENTRYPOINT ["/usr/local/bin/channelgateway"]
