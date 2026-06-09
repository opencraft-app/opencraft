.PHONY: build dist-linux-single-tar.gz dist-linux-tar.gz linux-single-tar.gz linux-tar.gz test tidy clean buildloop smoke-checkpoint bench-checkpoint test-checkpoint-runtime test-checkpoint-runtime-local test-checkpoint-runtime-orbstack test-checkpoint-runtime-docker test-checkpoint-runtime-compile-linux

BIN_DIR ?= ./dist
GO ?= go
GOFLAGS ?=
GOENV = GOWORK=off GOTOOLCHAIN=local
LINUX_GOARCH ?= amd64
WISP_LINUX_PACKAGE_WITH_DOCKER ?= 1
WISP_LINUX_BUILD_WITH_DOCKER ?= $(WISP_LINUX_PACKAGE_WITH_DOCKER)
WISP_LINUX_PACKAGE_FLATTEN_ROOTFS ?= 1
WISP_CHECKPOINT_RUNTIME_TESTS ?= TestEnsureJuiceFSCloneSupportedIncludesMountDiagnostics|TestCreateCheckpointUnsupportedCloneRemovesCandidate|TestCreateCheckpointPublishesCloneWithMetaBarrier
WISP_TEST_DOCKER_IMAGE ?= golang:1.24-bookworm
WISP_TEST_DOCKER_PLATFORM ?=
WISP_TEST_DOCKER_PLATFORM_FLAG = $(if $(WISP_TEST_DOCKER_PLATFORM),--platform $(WISP_TEST_DOCKER_PLATFORM),)

build:
	mkdir -p $(BIN_DIR)
	$(GOENV) $(GO) build $(GOFLAGS) -o $(BIN_DIR)/wisp ./cmd/wisp
	$(GOENV) $(GO) build $(GOFLAGS) -o $(BIN_DIR)/wispclient ./cmd/wispclient
	$(GOENV) $(GO) build $(GOFLAGS) -o $(BIN_DIR)/wispenv ./cmd/wispenv
	$(GOENV) $(GO) build $(GOFLAGS) -o $(BIN_DIR)/wispcloud ./cmd/wispcloud
	$(GOENV) $(GO) build $(GOFLAGS) -o $(BIN_DIR)/wisp-fs-agent ./cmd/wisp-fs-agent

dist-linux-single-tar.gz:
	GOOS=linux \
	GOARCH=$(LINUX_GOARCH) \
	WISP_PACKAGE_TAR_GZ=1 \
	WISP_PACKAGE_EROFS=0 \
	WISP_PACKAGE_FLATTEN_ROOTFS=$(WISP_LINUX_PACKAGE_FLATTEN_ROOTFS) \
	WISP_BUILD_WITH_DOCKER=$(WISP_LINUX_BUILD_WITH_DOCKER) \
	WISP_PACKAGE_WITH_DOCKER=$(WISP_LINUX_PACKAGE_WITH_DOCKER) \
	./hack/release/package-tarball.sh

dist-linux-tar.gz: dist-linux-single-tar.gz

linux-single-tar.gz: dist-linux-single-tar.gz

linux-tar.gz: dist-linux-single-tar.gz

test:
	$(GOENV) $(GO) test ./...

test-checkpoint-runtime:
	@if [ "$$(uname -s)" = "Linux" ]; then \
		$(MAKE) test-checkpoint-runtime-local; \
	elif command -v ssh >/dev/null 2>&1 && ssh -o BatchMode=yes -o ConnectTimeout=3 orb 'test -d "$(CURDIR)" && sudo -n true' >/dev/null 2>&1; then \
		$(MAKE) test-checkpoint-runtime-orbstack; \
	elif command -v docker >/dev/null 2>&1; then \
		$(MAKE) test-checkpoint-runtime-docker; \
	else \
		echo "No Linux checkpoint runtime runner found. Install OrbStack with ssh orb, run on Linux, or install Docker."; \
		exit 1; \
	fi

test-checkpoint-runtime-local:
	sudo -n env $(GOENV) $(GO) test ./internal/runtime -run '$(WISP_CHECKPOINT_RUNTIME_TESTS)' -count=1 -v

test-checkpoint-runtime-orbstack:
	ssh orb "cd $(CURDIR) && sudo -n env $(GOENV) $(GO) test ./internal/runtime -run '$(WISP_CHECKPOINT_RUNTIME_TESTS)' -count=1 -v"

test-checkpoint-runtime-docker:
	docker pull $(WISP_TEST_DOCKER_IMAGE)
	docker run --rm $(WISP_TEST_DOCKER_PLATFORM_FLAG) \
		-v "$(CURDIR)":/repo \
		-w /repo \
		-e GOWORK=off \
		-e GOTOOLCHAIN=local \
		-e GOCACHE=/tmp/go-cache \
		-e GOMODCACHE=/tmp/go-mod-cache \
		$(WISP_TEST_DOCKER_IMAGE) \
		sh -lc "go test ./internal/runtime -run '$(WISP_CHECKPOINT_RUNTIME_TESTS)' -count=1 -v"

test-checkpoint-runtime-compile-linux:
	$(GOENV) GOOS=linux GOARCH=$(LINUX_GOARCH) $(GO) test -c ./internal/runtime -o /tmp/wisp-runtime-$(LINUX_GOARCH).test

tidy:
	$(GOENV) $(GO) mod tidy

clean:
	rm -rf $(BIN_DIR) .tmp

buildloop:
	./hack/buildloop.sh

smoke-checkpoint:
	./hack/smoke/checkpoint.sh

bench-checkpoint:
	./hack/bench/checkpoint.sh
