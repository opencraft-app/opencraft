.PHONY: build dist-linux-single-tar.gz dist-linux-tar.gz linux-single-tar.gz linux-tar.gz test tidy clean buildloop smoke-checkpoint bench-checkpoint

BIN_DIR ?= ./dist
GO ?= go
GOFLAGS ?=
GOENV = GOWORK=off GOTOOLCHAIN=local
LINUX_GOARCH ?= amd64
WISP_LINUX_PACKAGE_WITH_DOCKER ?= 1
WISP_LINUX_BUILD_WITH_DOCKER ?= $(WISP_LINUX_PACKAGE_WITH_DOCKER)
WISP_LINUX_PACKAGE_FLATTEN_ROOTFS ?= 1

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
