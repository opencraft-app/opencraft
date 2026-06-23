ELECTRON_APP_DIR := apps/vela-desktop-electron
ELECTRON_BUILDER := npx --yes electron-builder
VELAD_LISTEN_ADDR ?= 127.0.0.1:3857

.PHONY: \
	install \
	server-build server-release server-run server-test server-clean \
	desktop-dev desktop-dev-web desktop-build desktop-pack desktop-dist desktop-clean \
	stack-dev

install:
	npm install
	cargo fetch

server-build:
	cargo build -p velad

server-release:
	cargo build --release -p velad

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

desktop-build: server-build
	npm --prefix $(ELECTRON_APP_DIR) run build

desktop-pack: server-release desktop-build
	cd $(ELECTRON_APP_DIR) && $(ELECTRON_BUILDER) --dir --mac --arm64 --config electron-builder.yml

desktop-dist: server-release desktop-build
	cd $(ELECTRON_APP_DIR) && $(ELECTRON_BUILDER) --mac --arm64 --config electron-builder.yml

desktop-clean:
	rm -rf $(ELECTRON_APP_DIR)/dist $(ELECTRON_APP_DIR)/dist-electron $(ELECTRON_APP_DIR)/release

stack-dev:
	@echo "Starting velad on $(VELAD_LISTEN_ADDR) and Electron desktop dev host"
	@trap 'kill 0' INT TERM EXIT; \
	VELAD_LISTEN_ADDR=$(VELAD_LISTEN_ADDR) cargo run -p velad & \
	VELA_DESKTOP_VELAD_LISTEN_ADDR=$(VELAD_LISTEN_ADDR) npm --prefix $(ELECTRON_APP_DIR) run dev
