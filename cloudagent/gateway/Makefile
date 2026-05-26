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
CLOUDAGENT_SIDECAR_SOURCES := $(shell find ../research/hermes-rs \( -path '../research/hermes-rs/target' -o -path '../research/hermes-rs/.git' \) -prune -o -type f -print)

CLOUDAGENT_SIDECAR_RUST_BASE_IMAGE ?= rust:1.86-bookworm
CLOUDAGENT_SIDECAR_CARGO_NET_RETRY ?= 10
CLOUDAGENT_SIDECAR_CARGO_HTTP_TIMEOUT ?= 120
CLOUDAGENT_SIDECAR_CARGO_HTTP_MULTIPLEXING ?= false
CLOUDAGENT_SIDECAR_CARGO_INCREMENTAL ?= 1
CLOUDAGENT_SIDECAR_CARGO_PROFILE_RELEASE_LTO ?= false
CLOUDAGENT_SIDECAR_CARGO_PROFILE_RELEASE_CODEGEN_UNITS ?= 16
CLOUDAGENT_SIDECAR_CARGO_PROFILE_RELEASE_STRIP ?= true

ifeq ($(CN_MIRRORS),1)
CLOUDAGENT_SIDECAR_DEBIAN_MIRROR ?= mirrors.tuna.tsinghua.edu.cn
CLOUDAGENT_SIDECAR_CARGO_USE_MIRROR ?= 1
# Use rsproxy's sparse registry root so Cargo also gets rsproxy's crate
# download endpoint from config.json. Some index mirrors still point dl at
# static.crates.io, which does not fix slow .crate tarball downloads.
CLOUDAGENT_SIDECAR_CARGO_REGISTRY_MIRROR ?= sparse+https://rsproxy.cn/index/
else
CLOUDAGENT_SIDECAR_DEBIAN_MIRROR ?=
CLOUDAGENT_SIDECAR_CARGO_USE_MIRROR ?= 0
CLOUDAGENT_SIDECAR_CARGO_REGISTRY_MIRROR ?=
endif

CLOUDAGENT_SIDECAR_IMAGE ?= gateway-cloudagent-sidecar-builder:local
CLOUDAGENT_SIDECAR_LINUX := $(DIST_DIR)/cloudagent-sidecar-linux-amd64
CLOUDAGENT_SIDECAR_LINUX_PACKED := $(DIST_DIR)/cloudagent-sidecar-linux-amd64.upx
CLOUDAGENT_AGENT_LOADER_LINUX := $(DIST_DIR)/cloudagent-agent-loader-linux-amd64
CLOUDAGENT_AGENT_SIGN_LINUX := $(DIST_DIR)/cloudagent-agent-sign-linux-amd64
SERVER := $(DIST_DIR)/gateway-server

.PHONY: help
help:
	@printf '%s\n' \
		'Targets:' \
		'  cloudagent-sidecar-linux         build CloudAgent Rust Linux sidecar' \
		'  cloudagent-agent-loader-linux build CloudAgent trusted agent loader' \
		'  cloudagent-agent-sign-linux   build CloudAgent release signing helper' \
		'  cloudagent-sidecar-linux-upx     build and UPX-pack CloudAgent Rust sidecar' \
		'  publish-cloudagent-sidecar       upload CloudAgent sidecar to COS as public-read and print URL' \
		'  init-cloudagent-signing-key      create local Ed25519 release key in ignored .env and print trusted keys JSON' \
		'  signupload-cloudagent-sidecar    build, sign, upload sidecar and print registry JSON' \
		'  ci-signupload-cloudagent-sidecar-shanghai build, sign, upload sidecar to Shanghai COS for CI' \
		'  publish-sandbox-host         build and upload sandbox-host to COS as public-read' \
		'  start-agent-sidecar-server   publish sidecar if needed, then start local wrapper server' \
		'  deploy-eksci-inplace         update Beijing EKS CI in-place without changing EIP' \
		'  e2e-agent-sidecar           run live Beijing AGS + COS + TokenHub e2e checks' \
		'  server                       build local wrapper server' \
		'  test                         run Go tests' \
		'  clean                        remove dist/'

$(DIST_DIR):
	mkdir -p $(DIST_DIR)

.PHONY: cloudagent-sidecar-linux
cloudagent-sidecar-linux: $(CLOUDAGENT_SIDECAR_LINUX)

$(CLOUDAGENT_SIDECAR_LINUX): $(DIST_DIR) build/cloudagent-sidecar/Dockerfile $(CLOUDAGENT_SIDECAR_SOURCES)
	$(DOCKER) build --platform $(DOCKER_PLATFORM) \
		--build-arg RUST_BASE_IMAGE=$(CLOUDAGENT_SIDECAR_RUST_BASE_IMAGE) \
		--build-arg DEBIAN_MIRROR=$(CLOUDAGENT_SIDECAR_DEBIAN_MIRROR) \
		--build-arg CARGO_USE_MIRROR=$(CLOUDAGENT_SIDECAR_CARGO_USE_MIRROR) \
		--build-arg CARGO_REGISTRY_MIRROR=$(CLOUDAGENT_SIDECAR_CARGO_REGISTRY_MIRROR) \
		--build-arg CARGO_NET_RETRY=$(CLOUDAGENT_SIDECAR_CARGO_NET_RETRY) \
		--build-arg CARGO_HTTP_TIMEOUT=$(CLOUDAGENT_SIDECAR_CARGO_HTTP_TIMEOUT) \
		--build-arg CARGO_HTTP_MULTIPLEXING=$(CLOUDAGENT_SIDECAR_CARGO_HTTP_MULTIPLEXING) \
		--build-arg CARGO_INCREMENTAL=$(CLOUDAGENT_SIDECAR_CARGO_INCREMENTAL) \
		--build-arg CARGO_PROFILE_RELEASE_LTO=$(CLOUDAGENT_SIDECAR_CARGO_PROFILE_RELEASE_LTO) \
		--build-arg CARGO_PROFILE_RELEASE_CODEGEN_UNITS=$(CLOUDAGENT_SIDECAR_CARGO_PROFILE_RELEASE_CODEGEN_UNITS) \
		--build-arg CARGO_PROFILE_RELEASE_STRIP=$(CLOUDAGENT_SIDECAR_CARGO_PROFILE_RELEASE_STRIP) \
		-f build/cloudagent-sidecar/Dockerfile --target artifact -t $(CLOUDAGENT_SIDECAR_IMAGE) ..
	container_id="$$( $(DOCKER) create $(CLOUDAGENT_SIDECAR_IMAGE) /cloudagent-sidecar-linux-amd64 )"; \
	trap '$(DOCKER) rm -f "$$container_id" >/dev/null 2>&1 || true' EXIT; \
	$(DOCKER) cp "$$container_id:/cloudagent-sidecar-linux-amd64" $@
	@chmod +x $@

.PHONY: cloudagent-agent-loader-linux
cloudagent-agent-loader-linux: $(CLOUDAGENT_AGENT_LOADER_LINUX)

$(CLOUDAGENT_AGENT_LOADER_LINUX): $(DIST_DIR) build/cloudagent-sidecar/Dockerfile $(CLOUDAGENT_SIDECAR_SOURCES) $(shell find ../agent-loader -type f -print)
	$(DOCKER) build --platform $(DOCKER_PLATFORM) \
		--build-arg RUST_BASE_IMAGE=$(CLOUDAGENT_SIDECAR_RUST_BASE_IMAGE) \
		--build-arg DEBIAN_MIRROR=$(CLOUDAGENT_SIDECAR_DEBIAN_MIRROR) \
		--build-arg CARGO_USE_MIRROR=$(CLOUDAGENT_SIDECAR_CARGO_USE_MIRROR) \
		--build-arg CARGO_REGISTRY_MIRROR=$(CLOUDAGENT_SIDECAR_CARGO_REGISTRY_MIRROR) \
		--build-arg CARGO_NET_RETRY=$(CLOUDAGENT_SIDECAR_CARGO_NET_RETRY) \
		--build-arg CARGO_HTTP_TIMEOUT=$(CLOUDAGENT_SIDECAR_CARGO_HTTP_TIMEOUT) \
		--build-arg CARGO_HTTP_MULTIPLEXING=$(CLOUDAGENT_SIDECAR_CARGO_HTTP_MULTIPLEXING) \
		--build-arg CARGO_INCREMENTAL=$(CLOUDAGENT_SIDECAR_CARGO_INCREMENTAL) \
		--build-arg CARGO_PROFILE_RELEASE_LTO=$(CLOUDAGENT_SIDECAR_CARGO_PROFILE_RELEASE_LTO) \
		--build-arg CARGO_PROFILE_RELEASE_CODEGEN_UNITS=$(CLOUDAGENT_SIDECAR_CARGO_PROFILE_RELEASE_CODEGEN_UNITS) \
		--build-arg CARGO_PROFILE_RELEASE_STRIP=$(CLOUDAGENT_SIDECAR_CARGO_PROFILE_RELEASE_STRIP) \
		-f build/cloudagent-sidecar/Dockerfile --target artifact -t $(CLOUDAGENT_SIDECAR_IMAGE) ..
	container_id="$$( $(DOCKER) create $(CLOUDAGENT_SIDECAR_IMAGE) /cloudagent-agent-loader-linux-amd64 )"; \
	trap '$(DOCKER) rm -f "$$container_id" >/dev/null 2>&1 || true' EXIT; \
	$(DOCKER) cp "$$container_id:/cloudagent-agent-loader-linux-amd64" $@
	@chmod +x $@

.PHONY: cloudagent-agent-sign-linux
cloudagent-agent-sign-linux: $(CLOUDAGENT_AGENT_SIGN_LINUX)

$(CLOUDAGENT_AGENT_SIGN_LINUX): $(DIST_DIR) build/cloudagent-sidecar/Dockerfile $(CLOUDAGENT_SIDECAR_SOURCES) $(shell find ../agent-loader -type f -print)
	$(DOCKER) build --platform $(DOCKER_PLATFORM) \
		--build-arg RUST_BASE_IMAGE=$(CLOUDAGENT_SIDECAR_RUST_BASE_IMAGE) \
		--build-arg DEBIAN_MIRROR=$(CLOUDAGENT_SIDECAR_DEBIAN_MIRROR) \
		--build-arg CARGO_USE_MIRROR=$(CLOUDAGENT_SIDECAR_CARGO_USE_MIRROR) \
		--build-arg CARGO_REGISTRY_MIRROR=$(CLOUDAGENT_SIDECAR_CARGO_REGISTRY_MIRROR) \
		--build-arg CARGO_NET_RETRY=$(CLOUDAGENT_SIDECAR_CARGO_NET_RETRY) \
		--build-arg CARGO_HTTP_TIMEOUT=$(CLOUDAGENT_SIDECAR_CARGO_HTTP_TIMEOUT) \
		--build-arg CARGO_HTTP_MULTIPLEXING=$(CLOUDAGENT_SIDECAR_CARGO_HTTP_MULTIPLEXING) \
		--build-arg CARGO_INCREMENTAL=$(CLOUDAGENT_SIDECAR_CARGO_INCREMENTAL) \
		--build-arg CARGO_PROFILE_RELEASE_LTO=$(CLOUDAGENT_SIDECAR_CARGO_PROFILE_RELEASE_LTO) \
		--build-arg CARGO_PROFILE_RELEASE_CODEGEN_UNITS=$(CLOUDAGENT_SIDECAR_CARGO_PROFILE_RELEASE_CODEGEN_UNITS) \
		--build-arg CARGO_PROFILE_RELEASE_STRIP=$(CLOUDAGENT_SIDECAR_CARGO_PROFILE_RELEASE_STRIP) \
		-f build/cloudagent-sidecar/Dockerfile --target artifact -t $(CLOUDAGENT_SIDECAR_IMAGE) ..
	container_id="$$( $(DOCKER) create $(CLOUDAGENT_SIDECAR_IMAGE) /cloudagent-agent-sign-linux-amd64 )"; \
	trap '$(DOCKER) rm -f "$$container_id" >/dev/null 2>&1 || true' EXIT; \
	$(DOCKER) cp "$$container_id:/cloudagent-agent-sign-linux-amd64" $@
	@chmod +x $@

.PHONY: cloudagent-sidecar-linux-upx
cloudagent-sidecar-linux-upx: $(CLOUDAGENT_SIDECAR_LINUX_PACKED)

$(CLOUDAGENT_SIDECAR_LINUX_PACKED): $(CLOUDAGENT_SIDECAR_LINUX)
	cp $(CLOUDAGENT_SIDECAR_LINUX) $@
	$(UPX) $(UPX_FLAGS) $@
	@chmod +x $@

.PHONY: server
server: $(SERVER)

$(SERVER): $(DIST_DIR) $(shell find cmd internal -name '*.go')
	GOWORK=$(GOWORK) $(GO) build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o $@ $(SERVER_PKG)

.PHONY: test
test:
	GOWORK=$(GOWORK) $(GO) test ./...

.PHONY: publish-cloudagent-sidecar
publish-cloudagent-sidecar: $(CLOUDAGENT_SIDECAR_LINUX)
	./scripts/publish_cloudagent_sidecar.sh

.PHONY: init-cloudagent-signing-key
init-cloudagent-signing-key:
	./scripts/init_cloudagent_signing_key.sh

.PHONY: signupload-cloudagent-sidecar
signupload-cloudagent-sidecar: $(CLOUDAGENT_SIDECAR_LINUX)
	./scripts/signupload_cloudagent_sidecar.sh

.PHONY: ci-signupload-cloudagent-sidecar-shanghai
ci-signupload-cloudagent-sidecar-shanghai:
	./scripts/ci_signupload_cloudagent_sidecar_shanghai.sh

.PHONY: publish-sandbox-host
publish-sandbox-host:
	../sandbox-host/scripts/publish_sandbox_host.sh

.PHONY: start-agent-sidecar-server
start-agent-sidecar-server: $(SERVER) $(CLOUDAGENT_SIDECAR_LINUX)
	@if [ -z "$$GATEWAY_AGENT_SIDECAR_URL" ] && [ ! -f "$${GATEWAY_AGENT_SIDECAR_URL_FILE:-/tmp/agent-sidecar-url.clean}" ]; then \
		$(MAKE) publish-cloudagent-sidecar; \
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
