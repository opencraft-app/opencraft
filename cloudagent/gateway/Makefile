SHELL := /bin/sh

GO ?= go
GOWORK ?= off
DOCKER ?= docker
UPX ?= upx
STRIP ?= strip

DIST_DIR ?= dist
DOCKER_PLATFORM ?= linux/amd64
GOFLAGS ?= -trimpath
LDFLAGS ?= -s -w -buildid=
UPX_FLAGS ?= --best --lzma
CN_MIRRORS ?= 1

SERVER_PKG := ./cmd/server
HERMES_SIDECAR_SOURCES := $(shell find ../research/hermes-rs \( -path '../research/hermes-rs/target' -o -path '../research/hermes-rs/.git' \) -prune -o -type f -print)

HERMES_SIDECAR_RUST_BASE_IMAGE ?= rust:1.86-bookworm
HERMES_SIDECAR_CARGO_NET_RETRY ?= 10
HERMES_SIDECAR_CARGO_HTTP_TIMEOUT ?= 120
HERMES_SIDECAR_CARGO_HTTP_MULTIPLEXING ?= false
HERMES_SIDECAR_CARGO_INCREMENTAL ?= 1
HERMES_SIDECAR_CARGO_PROFILE_RELEASE_LTO ?= false
HERMES_SIDECAR_CARGO_PROFILE_RELEASE_CODEGEN_UNITS ?= 16
HERMES_SIDECAR_CARGO_PROFILE_RELEASE_STRIP ?= true

ifeq ($(CN_MIRRORS),1)
HERMES_SIDECAR_DEBIAN_MIRROR ?= mirrors.tuna.tsinghua.edu.cn
HERMES_SIDECAR_CARGO_USE_MIRROR ?= 1
HERMES_SIDECAR_CARGO_REGISTRY_MIRROR ?= https://rsproxy.cn
else
HERMES_SIDECAR_DEBIAN_MIRROR ?=
HERMES_SIDECAR_CARGO_USE_MIRROR ?= 0
HERMES_SIDECAR_CARGO_REGISTRY_MIRROR ?=
endif

HERMES_SIDECAR_IMAGE ?= gateway-hermes-sidecar-builder:local
HERMES_SIDECAR_LINUX := $(DIST_DIR)/hermes-sidecar-linux-amd64
HERMES_SIDECAR_LINUX_PACKED := $(DIST_DIR)/hermes-sidecar-linux-amd64.upx
SERVER := $(DIST_DIR)/gateway-server

.PHONY: help
help:
	@printf '%s\n' \
		'Targets:' \
		'  hermes-sidecar-linux         build Hermes Rust Linux sidecar' \
		'  hermes-sidecar-linux-upx     build and UPX-pack Hermes Rust sidecar' \
		'  publish-hermes-sidecar       upload Hermes sidecar to COS as public-read and print URL' \
		'  publish-sandbox-host         build and upload sandbox-host to COS as public-read' \
		'  start-agent-sidecar-server   publish sidecar if needed, then start local wrapper server' \
		'  deploy-eksci-inplace         update Beijing EKS CI in-place without changing EIP' \
		'  e2e-agent-sidecar           run live Beijing AGS + COS + TokenHub e2e checks' \
		'  server                       build local wrapper server' \
		'  test                         run Go tests' \
		'  clean                        remove dist/'

$(DIST_DIR):
	mkdir -p $(DIST_DIR)

.PHONY: hermes-sidecar-linux
hermes-sidecar-linux: $(HERMES_SIDECAR_LINUX)

$(HERMES_SIDECAR_LINUX): $(DIST_DIR) build/hermes-sidecar/Dockerfile $(HERMES_SIDECAR_SOURCES)
	$(DOCKER) build --platform $(DOCKER_PLATFORM) \
		--build-arg RUST_BASE_IMAGE=$(HERMES_SIDECAR_RUST_BASE_IMAGE) \
		--build-arg DEBIAN_MIRROR=$(HERMES_SIDECAR_DEBIAN_MIRROR) \
		--build-arg CARGO_USE_MIRROR=$(HERMES_SIDECAR_CARGO_USE_MIRROR) \
		--build-arg CARGO_REGISTRY_MIRROR=$(HERMES_SIDECAR_CARGO_REGISTRY_MIRROR) \
		--build-arg CARGO_NET_RETRY=$(HERMES_SIDECAR_CARGO_NET_RETRY) \
		--build-arg CARGO_HTTP_TIMEOUT=$(HERMES_SIDECAR_CARGO_HTTP_TIMEOUT) \
		--build-arg CARGO_HTTP_MULTIPLEXING=$(HERMES_SIDECAR_CARGO_HTTP_MULTIPLEXING) \
		--build-arg CARGO_INCREMENTAL=$(HERMES_SIDECAR_CARGO_INCREMENTAL) \
		--build-arg CARGO_PROFILE_RELEASE_LTO=$(HERMES_SIDECAR_CARGO_PROFILE_RELEASE_LTO) \
		--build-arg CARGO_PROFILE_RELEASE_CODEGEN_UNITS=$(HERMES_SIDECAR_CARGO_PROFILE_RELEASE_CODEGEN_UNITS) \
		--build-arg CARGO_PROFILE_RELEASE_STRIP=$(HERMES_SIDECAR_CARGO_PROFILE_RELEASE_STRIP) \
		-f build/hermes-sidecar/Dockerfile --target artifact -t $(HERMES_SIDECAR_IMAGE) ..
	container_id="$$( $(DOCKER) create $(HERMES_SIDECAR_IMAGE) /hermes-sidecar-linux-amd64 )"; \
	trap '$(DOCKER) rm -f "$$container_id" >/dev/null 2>&1 || true' EXIT; \
	$(DOCKER) cp "$$container_id:/hermes-sidecar-linux-amd64" $@
	@chmod +x $@

.PHONY: hermes-sidecar-linux-upx
hermes-sidecar-linux-upx: $(HERMES_SIDECAR_LINUX_PACKED)

$(HERMES_SIDECAR_LINUX_PACKED): $(HERMES_SIDECAR_LINUX)
	cp $(HERMES_SIDECAR_LINUX) $@
	$(UPX) $(UPX_FLAGS) $@
	@chmod +x $@

.PHONY: server
server: $(SERVER)

$(SERVER): $(DIST_DIR) $(shell find cmd internal -name '*.go')
	GOWORK=$(GOWORK) $(GO) build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o $@ $(SERVER_PKG)

.PHONY: test
test:
	GOWORK=$(GOWORK) $(GO) test ./...

.PHONY: publish-hermes-sidecar
publish-hermes-sidecar: $(HERMES_SIDECAR_LINUX)
	./scripts/publish_hermes_sidecar.sh

.PHONY: publish-sandbox-host
publish-sandbox-host:
	../sandbox-host/scripts/publish_sandbox_host.sh

.PHONY: start-agent-sidecar-server
start-agent-sidecar-server: $(SERVER) $(HERMES_SIDECAR_LINUX)
	@if [ -z "$$GATEWAY_AGENT_SIDECAR_URL" ] && [ ! -f "$${GATEWAY_AGENT_SIDECAR_URL_FILE:-/tmp/agent-sidecar-url.clean}" ]; then \
		$(MAKE) publish-hermes-sidecar; \
	fi
	./scripts/start_agent_sidecar_server.sh

.PHONY: deploy-eksci-inplace
deploy-eksci-inplace:
	./scripts/deploy_eksci_inplace.sh

.PHONY: e2e-agent-sidecar
e2e-agent-sidecar:
	./scripts/e2e_agent_sidecar.sh

.PHONY: clean
clean:
	rm -rf $(DIST_DIR)
