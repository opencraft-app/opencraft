BINARY_NAME ?= shadowd
BIN_DIR ?= bin
CMD_PATH ?= ./cmd/shadowd

LOCAL_BIN := $(BIN_DIR)/$(BINARY_NAME)
LINUX_AMD64_BIN := $(BIN_DIR)/$(BINARY_NAME)-linux-amd64

.PHONY: build
build:
	@mkdir -p $(BIN_DIR)
	go build -o $(LOCAL_BIN) $(CMD_PATH)

.PHONY: build-linux-amd64
build-linux-amd64:
	@mkdir -p $(BIN_DIR)
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o $(LINUX_AMD64_BIN) $(CMD_PATH)

.PHONY: build-linux-amd6
build-linux-amd6: build-linux-amd64

.PHONY: run
run: build
	./$(LOCAL_BIN)

.PHONY: test
test:
	go test ./...
