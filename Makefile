ELECTRON_APP_DIR := apps/vela-desktop-electron
ELECTRON_BUILDER := npm exec -- electron-builder
VELAD_LISTEN_ADDR ?= 127.0.0.1:3857
VELAD_LINUX_AMD64_IMAGE ?= rust:1-bookworm
VELAD_LINUX_AMD64_OUT := dist/velad/linux-amd64/velad

.PHONY: \
	install \
	server-build server-build-desktop server-release server-release-desktop server-release-linux-amd64 server-run server-test server-clean \
	desktop-dev desktop-dev-web desktop-build \
	desktop-preview desktop-preview-fast desktop-open-installed desktop-pids \
	desktop-pack desktop-pack-dev desktop-install desktop-install-dev desktop-dist desktop-clean \
	stack-dev

install:
	npm install
	cargo fetch

server-build:
	cargo build -p velad

server-build-desktop:
	cargo build -p velad --features embedded-vela-engine

server-release:
	cargo build --release -p velad

server-release-desktop:
	cargo build --release -p velad --features embedded-vela-engine

server-release-linux-amd64:
	mkdir -p $(dir $(VELAD_LINUX_AMD64_OUT))
	docker run --rm --platform linux/amd64 \
		-v "$(CURDIR)":/workspace \
		-w /workspace \
		$(VELAD_LINUX_AMD64_IMAGE) \
		bash -lc 'cargo build --release -p velad && cp target/release/velad $(VELAD_LINUX_AMD64_OUT)'

server-run:
	VELAD_LISTEN_ADDR=$(VELAD_LISTEN_ADDR) cargo run -p velad

server-test:
	cargo test -p velad

server-clean:
	cargo clean -p velad

desktop-dev:
	npm --prefix $(ELECTRON_APP_DIR) run dev

desktop-dev-web:
	npm --prefix $(ELECTRON_APP_DIR) run dev:web

desktop-preview: desktop-dev

desktop-preview-fast: desktop-preview

desktop-open-installed:
	open /Applications/Vela.app

desktop-pids:
	@pgrep -fl '/Applications/Vela.app|Vela.app|Contents/Resources/bin/velad' || true

desktop-build: server-build-desktop
	npm --prefix $(ELECTRON_APP_DIR) run build

desktop-pack: server-release-desktop desktop-build
	cd $(ELECTRON_APP_DIR) && $(ELECTRON_BUILDER) --dir --mac --arm64 --config electron-builder.yml

desktop-pack-dev: server-release-desktop desktop-build
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

desktop-dist: server-release-desktop desktop-build
	cd $(ELECTRON_APP_DIR) && $(ELECTRON_BUILDER) --mac --arm64 --config electron-builder.yml

desktop-clean:
	rm -rf $(ELECTRON_APP_DIR)/dist $(ELECTRON_APP_DIR)/dist-electron $(ELECTRON_APP_DIR)/release

stack-dev: desktop-preview
