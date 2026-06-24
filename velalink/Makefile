ELECTRON_APP_DIR := apps/vela-desktop-electron
ELECTRON_BUILDER := npm exec -- electron-builder
VELAD_LISTEN_ADDR ?= 127.0.0.1:3857
VELAD_DOCKER_PLATFORM ?= linux/amd64
VELAD_DOCKER_IMAGE ?= rust:1-bookworm
VELAD_LINUX_AMD64_DIR ?= target-linux-amd64
VELAD_LINUX_AMD64_BIN ?= $(VELAD_LINUX_AMD64_DIR)/velad-linux-amd64
VELAD_CARGO_BUILD_FLAGS ?=
VELAD_RELEASE_URL_FILE ?= $(VELAD_LINUX_AMD64_DIR)/velad-linux-amd64.url
VELAD_RELEASE_SHA_FILE ?= $(VELAD_LINUX_AMD64_DIR)/velad-linux-amd64.sha256
MONO_API_BASE_URL ?= https://lightclaw.tech

.PHONY: \
	install \
	server-build server-release server-release-linux-amd64 server-upload-cos \
	server-vm-install-command server-vm-install-debug-exec \
	server-run server-test server-clean \
	desktop-dev desktop-dev-web desktop-build \
	desktop-preview \
	desktop-pack desktop-pack-dev desktop-install desktop-install-dev desktop-dist desktop-clean \
	stack-dev

install:
	npm install
	cargo fetch

server-build:
	cargo build -p velad

server-release:
	cargo build --release -p velad

server-release-linux-amd64:
	@mkdir -p .build-cache/cargo-registry .build-cache/cargo-git $(VELAD_LINUX_AMD64_DIR)
	docker run --rm --platform $(VELAD_DOCKER_PLATFORM) \
		-e PATH=/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
		-e CARGO_HOME=/cargo \
		-e CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse \
		-e CARGO_HTTP_MULTIPLEXING=false \
		-e CARGO_HTTP_TIMEOUT=600 \
		-e CARGO_NET_RETRY=5 \
		-v "$$(pwd)":/work \
		-v "$$(pwd)/.build-cache/cargo-registry":/cargo/registry \
		-v "$$(pwd)/.build-cache/cargo-git":/cargo/git \
		-w /work \
		$(VELAD_DOCKER_IMAGE) \
		bash -c 'set -euo pipefail; rustc --version; cargo build $(VELAD_CARGO_BUILD_FLAGS) --release -p velad; cp target/release/velad "$(VELAD_LINUX_AMD64_BIN)"'
	@file "$(VELAD_LINUX_AMD64_BIN)"

server-upload-cos: server-release-linux-amd64
	@VELAD_LOCAL_PATH="$(VELAD_LINUX_AMD64_BIN)" \
	VELAD_URL_FILE="$(VELAD_RELEASE_URL_FILE)" \
	VELAD_SHA_FILE="$(VELAD_RELEASE_SHA_FILE)" \
	./scripts/publish_velad_linux_amd64.sh

server-vm-install-command:
	@VELAD_URL_FILE="$(VELAD_RELEASE_URL_FILE)" \
	VELAD_SHA_FILE="$(VELAD_RELEASE_SHA_FILE)" \
	./scripts/velad_vm_install_command.sh

server-vm-install-debug-exec:
	@test -n "$$MONO_BOT_ID" || { echo "missing MONO_BOT_ID" >&2; exit 2; }
	@test -n "$$MONO_AUTH_TOKEN" || { echo "missing MONO_AUTH_TOKEN" >&2; exit 2; }
	@command -v curl >/dev/null 2>&1 || { echo "missing curl" >&2; exit 2; }
	@command -v python3 >/dev/null 2>&1 || { echo "missing python3" >&2; exit 2; }
	@command="$$(VELAD_URL_FILE="$(VELAD_RELEASE_URL_FILE)" VELAD_SHA_FILE="$(VELAD_RELEASE_SHA_FILE)" ./scripts/velad_vm_install_command.sh)"; \
	payload="$$(COMMAND="$$command" python3 -c 'import json, os; print(json.dumps({"command": os.environ["COMMAND"], "run_as_user": "agentuser"}))')"; \
	curl -fsS -X POST "$(MONO_API_BASE_URL)/v1/instances/$${MONO_BOT_ID}/debug/exec" \
		-H "Authorization: Bearer $${MONO_AUTH_TOKEN}" \
		-H "Content-Type: application/json" \
		--data "$$payload"

server-run:
	VELAD_LISTEN_ADDR=$(VELAD_LISTEN_ADDR) cargo run -p velad

server-test:
	cargo test -p velad

server-clean:
	cargo clean -p velad

desktop-dev:
	VELA_DESKTOP_VELAD_LISTEN_ADDR=$(VELAD_LISTEN_ADDR) npm --prefix $(ELECTRON_APP_DIR) run dev

desktop-dev-web:
	npm --prefix $(ELECTRON_APP_DIR) run dev:web

desktop-preview: stack-dev

desktop-build: server-build
	npm --prefix $(ELECTRON_APP_DIR) run build

desktop-pack: server-release desktop-build
	cd $(ELECTRON_APP_DIR) && $(ELECTRON_BUILDER) --dir --mac --arm64 --config electron-builder.yml

desktop-pack-dev: server-release desktop-build
	cd $(ELECTRON_APP_DIR) && CSC_IDENTITY_AUTO_DISCOVERY=false $(ELECTRON_BUILDER) --dir --mac --arm64 --config electron-builder.yml

desktop-install: desktop-pack
	osascript -e 'tell application "Vela" to quit' >/dev/null 2>&1 || true
	sleep 1
	rm -rf /Applications/Vela.app
	cp -R $(ELECTRON_APP_DIR)/release/mac-arm64/Vela.app /Applications/Vela.app
	touch /Applications/Vela.app
	open -a /Applications/Vela.app

desktop-install-dev: desktop-pack-dev
	osascript -e 'tell application "Vela" to quit' >/dev/null 2>&1 || true
	sleep 1
	rm -rf /Applications/Vela.app
	cp -R $(ELECTRON_APP_DIR)/release/mac-arm64/Vela.app /Applications/Vela.app
	touch /Applications/Vela.app
	open -a /Applications/Vela.app

desktop-dist: server-release desktop-build
	cd $(ELECTRON_APP_DIR) && $(ELECTRON_BUILDER) --mac --arm64 --config electron-builder.yml

desktop-clean:
	rm -rf $(ELECTRON_APP_DIR)/dist $(ELECTRON_APP_DIR)/dist-electron $(ELECTRON_APP_DIR)/release

stack-dev:
	@echo "Starting velad on $(VELAD_LISTEN_ADDR) and Electron desktop dev host"
	@bash -lc 'set -e; \
	VELAD_LISTEN_ADDR=$(VELAD_LISTEN_ADDR) cargo run -p velad & \
	velad_pid=$$!; \
	VELA_DESKTOP_VELAD_LISTEN_ADDR=$(VELAD_LISTEN_ADDR) npm --prefix $(ELECTRON_APP_DIR) run dev & \
	electron_pid=$$!; \
	trap '"'"'kill $$velad_pid $$electron_pid 2>/dev/null || true'"'"' INT TERM EXIT; \
	status=0; \
	while kill -0 $$velad_pid 2>/dev/null && kill -0 $$electron_pid 2>/dev/null; do sleep 0.5; done; \
	wait $$velad_pid 2>/dev/null || status=$$?; \
	wait $$electron_pid 2>/dev/null || status=$$?; \
	kill $$velad_pid $$electron_pid 2>/dev/null || true; \
	exit $$status'
