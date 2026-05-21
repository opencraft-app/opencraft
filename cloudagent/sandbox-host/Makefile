.PHONY: build linux-amd64 test publish clean

DOCKER ?= docker
DOCKER_PLATFORM ?= linux/amd64
SANDBOX_HOST_IMAGE ?= cloudagent-sandbox-host-builder:local

build:
	cargo build --release

linux-amd64:
	$(DOCKER) build --platform $(DOCKER_PLATFORM) -f build/Dockerfile --target artifact -t $(SANDBOX_HOST_IMAGE) .
	mkdir -p dist
	container_id="$$( $(DOCKER) create $(SANDBOX_HOST_IMAGE) /sandbox-host-linux-amd64 )"; \
	trap '$(DOCKER) rm -f "$$container_id" >/dev/null 2>&1 || true' EXIT; \
	$(DOCKER) cp "$$container_id:/sandbox-host-linux-amd64" dist/sandbox-host-linux-amd64
	chmod +x dist/sandbox-host-linux-amd64

test:
	cargo test

publish:
	./scripts/publish_sandbox_host.sh

clean:
	rm -rf target target-linux dist
