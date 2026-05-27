.PHONY: build test tidy clean buildloop smoke-checkpoint bench-checkpoint

BIN_DIR ?= ./dist
GO ?= go
GOFLAGS ?=
GOENV = GOWORK=off GOTOOLCHAIN=local

build:
	mkdir -p $(BIN_DIR)
	$(GOENV) $(GO) build $(GOFLAGS) -o $(BIN_DIR)/wisp ./cmd/wisp
	$(GOENV) $(GO) build $(GOFLAGS) -o $(BIN_DIR)/wispclient ./cmd/wispclient
	$(GOENV) $(GO) build $(GOFLAGS) -o $(BIN_DIR)/wispenv ./cmd/wispenv
	$(GOENV) $(GO) build $(GOFLAGS) -o $(BIN_DIR)/wispcloud ./cmd/wispcloud
	$(GOENV) $(GO) build $(GOFLAGS) -o $(BIN_DIR)/wisp-fs-agent ./cmd/wisp-fs-agent

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
