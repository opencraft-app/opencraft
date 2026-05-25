# syntax=docker/dockerfile:1.7
ARG RUST_BASE_IMAGE=rust:1.86-bookworm
FROM ${RUST_BASE_IMAGE} AS build

ARG DEBIAN_MIRROR=
ARG CARGO_USE_MIRROR=0
ARG CARGO_REGISTRY_MIRROR=
ARG CARGO_NET_RETRY=10
ARG CARGO_HTTP_TIMEOUT=120
ARG CARGO_HTTP_MULTIPLEXING=false
ARG CARGO_INCREMENTAL=1
ARG CARGO_PROFILE_RELEASE_LTO=false
ARG CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
ARG CARGO_PROFILE_RELEASE_STRIP=true
ARG CLOUDAGENT_SIDECAR_RUST_TARGET=x86_64-unknown-linux-musl

ENV CARGO_NET_GIT_FETCH_WITH_CLI=true \
    CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse \
    CARGO_NET_RETRY=${CARGO_NET_RETRY} \
    CARGO_HTTP_TIMEOUT=${CARGO_HTTP_TIMEOUT} \
    CARGO_HTTP_MULTIPLEXING=${CARGO_HTTP_MULTIPLEXING} \
    CARGO_INCREMENTAL=${CARGO_INCREMENTAL} \
    CARGO_PROFILE_RELEASE_LTO=${CARGO_PROFILE_RELEASE_LTO} \
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS=${CARGO_PROFILE_RELEASE_CODEGEN_UNITS} \
    CARGO_PROFILE_RELEASE_STRIP=${CARGO_PROFILE_RELEASE_STRIP}

RUN if [ -n "$DEBIAN_MIRROR" ]; then \
        sed -i "s|http://deb.debian.org/debian|https://${DEBIAN_MIRROR}/debian|g; s|http://deb.debian.org/debian-security|https://${DEBIAN_MIRROR}/debian-security|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates musl-tools pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN rustup target add ${CLOUDAGENT_SIDECAR_RUST_TARGET}

RUN mkdir -p "${CARGO_HOME:-/usr/local/cargo}" \
    && if [ "$CARGO_USE_MIRROR" = "1" ] && [ -n "$CARGO_REGISTRY_MIRROR" ]; then \
        mirror="$CARGO_REGISTRY_MIRROR"; \
        printf '[source.crates-io]\nreplace-with = "mirror"\n\n[source.mirror]\nregistry = "%s"\n' "$mirror" > "${CARGO_HOME:-/usr/local/cargo}/config.toml"; \
    fi

RUN --mount=type=bind,source=.,target=/build-context,ro \
    if [ -f /build-context/cargo-vendor/config.toml ] && [ -d /build-context/cargo-vendor/vendor ]; then \
        rm -rf /cargo-vendor \
        && mkdir -p /cargo-vendor "${CARGO_HOME:-/usr/local/cargo}" \
        && cp -a /build-context/cargo-vendor/vendor /cargo-vendor/vendor \
        && cp /build-context/cargo-vendor/config.toml "${CARGO_HOME:-/usr/local/cargo}/config.toml"; \
    fi

WORKDIR /src

WORKDIR /src/agent-loader
COPY agent-loader/Cargo.toml agent-loader/Cargo.lock ./
RUN --mount=type=cache,id=cloudagent-agent-loader-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=cloudagent-agent-loader-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=cloudagent-agent-loader-cargo-target,target=/tmp/cargo-target-agent-loader \
    mkdir -p src/bin \
    && printf 'fn main() {}\n' > src/main.rs \
    && printf 'fn main() {}\n' > src/bin/cloudagent-agent-sign.rs \
    && cargo build --locked --release --target-dir /tmp/cargo-target-agent-loader

WORKDIR /src/research/hermes-rs

COPY research/hermes-rs/Cargo.toml research/hermes-rs/Cargo.lock ./
RUN mkdir -p crates/hermes-core crates/hermes-cli crates/hermes-sidecar
COPY research/hermes-rs/crates/hermes-core/Cargo.toml crates/hermes-core/Cargo.toml
COPY research/hermes-rs/crates/hermes-cli/Cargo.toml crates/hermes-cli/Cargo.toml
COPY research/hermes-rs/crates/hermes-sidecar/Cargo.toml crates/hermes-sidecar/Cargo.toml

RUN --mount=type=cache,id=hermes-sidecar-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=hermes-sidecar-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=hermes-sidecar-cargo-target,target=/tmp/cargo-target \
    mkdir -p crates/hermes-core/src crates/hermes-cli/src crates/hermes-sidecar/src \
    && printf 'pub fn dependency_cache_stub() {}\n' > crates/hermes-core/src/lib.rs \
    && printf 'fn main() {}\n' > crates/hermes-cli/src/main.rs \
    && printf 'fn main() {}\n' > crates/hermes-sidecar/src/main.rs \
    && cargo build --locked --release -p hermes-sidecar --target ${CLOUDAGENT_SIDECAR_RUST_TARGET} --target-dir /tmp/cargo-target

COPY research/hermes-rs /src/research/hermes-rs
COPY agent-loader /src/agent-loader

RUN --mount=type=cache,id=hermes-sidecar-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=hermes-sidecar-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=hermes-sidecar-cargo-target,target=/tmp/cargo-target \
    --mount=type=cache,id=cloudagent-agent-loader-cargo-target,target=/tmp/cargo-target-agent-loader \
    find crates/hermes-core/src crates/hermes-sidecar/src -type f -exec touch {} + \
    && cargo build --locked --release -p hermes-sidecar --target ${CLOUDAGENT_SIDECAR_RUST_TARGET} --target-dir /tmp/cargo-target \
    && cd /src/agent-loader \
    && find src -type f -exec touch {} + \
    && cargo build --locked --release --target-dir /tmp/cargo-target-agent-loader \
    && cd /src/research/hermes-rs \
    && install -D /tmp/cargo-target/${CLOUDAGENT_SIDECAR_RUST_TARGET}/release/hermes-sidecar /out/cloudagent-sidecar-linux-amd64 \
    && install -D /tmp/cargo-target-agent-loader/release/cloudagent-agent-loader /out/cloudagent-agent-loader-linux-amd64

FROM scratch AS artifact
COPY --from=build /out/cloudagent-sidecar-linux-amd64 /cloudagent-sidecar-linux-amd64
COPY --from=build /out/cloudagent-agent-loader-linux-amd64 /cloudagent-agent-loader-linux-amd64
