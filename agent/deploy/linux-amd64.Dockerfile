# syntax=docker/dockerfile:1.7
ARG RUST_IMAGE=docker.io/library/rust@sha256:3914072ca0c3b8aad871db9169a651ccfce30cf58303e5d6f2db16d1d8a7e58f
ARG GO_IMAGE=docker.io/library/golang@sha256:c423747fbd96fd8f0b1102d947f51f9b266060217478e5f9bf86f145969562ee

FROM --platform=linux/amd64 ${RUST_IMAGE} AS tat
WORKDIR /src/native/tat-agent
COPY native/tat-agent/Cargo.toml native/tat-agent/Cargo.lock ./
COPY native/tat-agent/include ./include
COPY native/tat-agent/src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/native/tat-agent/target \
    cargo build --locked --release && \
    mkdir -p /out && cp target/release/libvela_tat.a /out/libvela_tat.a

FROM --platform=linux/amd64 ${GO_IMAGE} AS build
ARG VELA_VERSION
ARG VELA_UPDATE_CHANNEL_URL
ARG VELA_ALLOW_INSECURE_UPDATE_HTTP=0
ARG VELA_CHANNEL_KEY_ID
ARG VELA_CHANNEL_PUBLIC_KEY
ARG VELA_RELEASE_KEY_ID
ARG VELA_RELEASE_PUBLIC_KEY
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=tat /out/libvela_tat.a /src/native/tat-agent/target/release/libvela_tat.a
RUN test -n "$VELA_VERSION" && test -n "$VELA_UPDATE_CHANNEL_URL" && \
    { test "$VELA_ALLOW_INSECURE_UPDATE_HTTP" = 0 || test "$VELA_ALLOW_INSECURE_UPDATE_HTTP" = 1; } && \
    test -n "$VELA_CHANNEL_KEY_ID" && test -n "$VELA_CHANNEL_PUBLIC_KEY" && \
    test -n "$VELA_RELEASE_KEY_ID" && test -n "$VELA_RELEASE_PUBLIC_KEY" && \
    CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build \
      -trimpath -tags vela_tat_cgo \
      -ldflags "-X main.version=$VELA_VERSION -X main.updateChannelURL=$VELA_UPDATE_CHANNEL_URL -X main.updateChannel=stable -X main.updateChannelAllowInsecureHTTP=$VELA_ALLOW_INSECURE_UPDATE_HTTP -X main.updateChannelKeyID=$VELA_CHANNEL_KEY_ID -X main.updateChannelPublicKey=$VELA_CHANNEL_PUBLIC_KEY -X main.updateReleaseKeyID=$VELA_RELEASE_KEY_ID -X main.updateReleasePublicKey=$VELA_RELEASE_PUBLIC_KEY" \
      -o /out/vela-computer ./cmd/vela-computer

FROM scratch AS export
COPY --from=build /out/vela-computer /vela-computer
