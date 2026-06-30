ELECTRON_APP_DIR := apps/vela-desktop-electron
ELECTRON_BUILDER := npm exec -- electron-builder
VELAD_LISTEN_ADDR ?= 127.0.0.1:3857
VELAD_LINUX_AMD64_IMAGE ?= rust:1-bookworm
VELAD_LINUX_AMD64_OUT := dist/velad/linux-amd64/velad
MACOS_SPEECH_DIR := $(ELECTRON_APP_DIR)/native/macos-speech
MACOS_SPEECH_HELPER := $(MACOS_SPEECH_DIR)/build/vela-speech-macos

.PHONY: \
	install \
	server-build server-build-desktop server-release server-release-desktop server-release-linux-amd64 server-run server-test server-clean \
	desktop-dev desktop-dev-web desktop-build desktop-build-macos-speech \
	desktop-preview desktop-preview-fast desktop-preview-stop desktop-open-installed desktop-pids \
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

desktop-preview: desktop-preview-stop desktop-dev

desktop-preview-fast: desktop-preview

desktop-preview-stop:
	@for pattern in \
		'[s]cripts/dev.mjs' \
		'$(CURDIR)/node_modules/.*[v]ite build --watch --config vite.electron.config.ts' \
		'[e]sbuild electron/preload.ts .*--watch=forever' \
		'$(CURDIR)/node_modules/[e]lectron/cli.js .' \
		'$(CURDIR)/target/debug/[v]elad --listen 127.0.0.1:0'; do \
		pids=$$(pgrep -f "$$pattern" || true); \
		if [ -n "$$pids" ]; then kill -TERM $$pids 2>/dev/null || true; fi; \
	done
	@sleep 1
	@for pattern in \
		'[s]cripts/dev.mjs' \
		'$(CURDIR)/node_modules/.*[v]ite build --watch --config vite.electron.config.ts' \
		'[e]sbuild electron/preload.ts .*--watch=forever' \
		'$(CURDIR)/node_modules/[e]lectron/cli.js .' \
		'$(CURDIR)/target/debug/[v]elad --listen 127.0.0.1:0'; do \
		pids=$$(pgrep -f "$$pattern" || true); \
		if [ -n "$$pids" ]; then kill -KILL $$pids 2>/dev/null || true; fi; \
	done

desktop-open-installed:
	open /Applications/Vela.app

desktop-pids:
	@pgrep -fl '/Applications/Vela.app|Vela.app|Contents/Resources/bin/velad|[v]ela-speech-macos|[s]cripts/dev.mjs|$(CURDIR)/node_modules/.*[v]ite build --watch --config vite.electron.config.ts|[e]sbuild electron/preload.ts .*--watch=forever|$(CURDIR)/node_modules/[e]lectron/cli.js .|$(CURDIR)/target/debug/[v]elad --listen 127.0.0.1:0' || true

desktop-build-macos-speech:
	@if [ "$$(uname -s)" = "Darwin" ]; then \
		mkdir -p "$(MACOS_SPEECH_DIR)/build"; \
		swiftc -O \
			-framework Speech \
			-framework AVFoundation \
			-Xlinker -sectcreate \
			-Xlinker __TEXT \
			-Xlinker __info_plist \
			-Xlinker "$(MACOS_SPEECH_DIR)/Info.plist" \
			"$(MACOS_SPEECH_DIR)/VelaSpeechHelper.swift" \
			-o "$(MACOS_SPEECH_HELPER)"; \
	else \
		echo "Skipping macOS Speech helper build on non-Darwin host"; \
	fi

desktop-build: server-build-desktop
	npm --prefix $(ELECTRON_APP_DIR) run build

desktop-pack: server-release-desktop desktop-build-macos-speech desktop-build
	cd $(ELECTRON_APP_DIR) && $(ELECTRON_BUILDER) --dir --mac --arm64 --config electron-builder.yml

desktop-pack-dev: server-release-desktop desktop-build-macos-speech desktop-build
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

desktop-dist: server-release-desktop desktop-build-macos-speech desktop-build
	cd $(ELECTRON_APP_DIR) && $(ELECTRON_BUILDER) --mac --arm64 --config electron-builder.yml

desktop-clean:
	rm -rf $(ELECTRON_APP_DIR)/dist $(ELECTRON_APP_DIR)/dist-electron $(ELECTRON_APP_DIR)/release $(MACOS_SPEECH_DIR)/build

stack-dev: desktop-preview
