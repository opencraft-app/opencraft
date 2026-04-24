.PHONY: build test run dev dev-only stop docker-up docker-down migrate-up migrate-down swagger portkey portkey-ensure dashboard-ensure

DASHBOARD_DIR := ../gateway-dashboard
PORTKEY_DIR := .

build:
	go build -o bin/ai-gateway ./cmd/server

test:
	go test ./... -v -count=1

run:
	go run ./cmd/server

docker-up:
	docker compose -f deploy/docker-compose.yml up -d

docker-down:
	docker compose -f deploy/docker-compose.yml down

migrate-up:
	migrate -path migrations -database "$(DATABASE_URL)" up

migrate-down:
	migrate -path migrations -database "$(DATABASE_URL)" down

swagger:
	swag init -g cmd/server/main.go -o docs

# ─── 路由网关管理 ───────────────────────────────────────
# 使用 ai-gateway/node_modules 中的 patched 版本（npm install 时自动打 patch）

PORTKEY_GATEWAY := $(PORTKEY_DIR)/node_modules/@portkey-ai/gateway/build/start-server.js

portkey-ensure:
	@if [ ! -f $(PORTKEY_GATEWAY) ]; then \
		echo "📦 安装 ai-gateway Portkey 依赖（含 streaming fix patch）..."; \
		cd $(PORTKEY_DIR) && npm install; \
	else \
		echo "✅ @portkey-ai/gateway (patched) 已就绪"; \
	fi

dashboard-ensure:
	@if [ ! -d $(DASHBOARD_DIR)/node_modules ]; then \
		echo "📦 安装 gateway-dashboard 依赖..."; \
		cd $(DASHBOARD_DIR) && npm install; \
	else \
		echo "✅ gateway-dashboard 依赖已就绪"; \
	fi

# 只启动路由网关（前台）
portkey: portkey-ensure
	@echo "🚀 启动路由网关 (http://localhost:8787) ..."
	@node $(PORTKEY_GATEWAY) --headless

# ─── 开发启动命令 ────────────────────────────────────────────────

# 只启动 Go 后端（不含路由网关）
dev-only:
	@if [ -f .env ]; then set -a && . ./.env && set +a; fi && go run ./cmd/server

# 启动路由网关 + Go 后端 + Dashboard（推荐本地开发用）
dev: portkey-ensure dashboard-ensure
	@mkdir -p logs .pids
	@# 清理残留端口占用
	@for port in 8787 18080 13000; do \
		pids=$$(lsof -ti:$$port 2>/dev/null); \
		if [ -n "$$pids" ]; then \
			echo "  ⚠  清理端口 $$port 残留进程：$$pids"; \
			echo "$$pids" | xargs kill -9 2>/dev/null || true; \
			sleep 1; \
		fi; \
	done
	@echo "🚀 启动路由网关 + AI Gateway 后端 ..."
	@# 启动路由网关后台运行
	@node $(PORTKEY_GATEWAY) --headless > logs/portkey.log 2>&1 & echo $$! > .pids/portkey.pid
	@echo "  ✓ 路由网关 (http://localhost:8787) [PID: $$(cat .pids/portkey.pid)]"
	@# 启动 Dashboard 前端后台运行
	@/bin/zsh -lc ' \
		cd "$(DASHBOARD_DIR)" && \
		if [ -f .env ]; then set -a && . ./.env && set +a; \
		elif [ -f ../ai-gateway/.env ]; then set -a && . ../ai-gateway/.env && set +a; fi && \
		export GATEWAY_API_URL="$${GATEWAY_API_URL:-http://localhost:18080}" && \
		exec npm run dev \
	' > logs/dashboard.log 2>&1 & echo $$! > .pids/dashboard.pid
	@echo "  ✓ Dashboard 前端 (http://localhost:13000/admin/gateway/login) [PID: $$(cat .pids/dashboard.pid)]"
	@# 前台启动 Go 后端（Ctrl+C 可中断）
	@echo "  → AI Gateway 后端 (http://localhost:18080)"
	@if [ -f .env ]; then set -a && . ./.env && set +a; fi && go run ./cmd/server; \
		EXIT_CODE=$$?; \
		if [ -f .pids/portkey.pid ]; then kill $$(cat .pids/portkey.pid) 2>/dev/null || true; rm -f .pids/portkey.pid; echo ""; echo "🛑 路由网关已停止"; fi; \
		if [ -f .pids/dashboard.pid ]; then kill $$(cat .pids/dashboard.pid) 2>/dev/null || true; rm -f .pids/dashboard.pid; echo "🛑 Dashboard 前端已停止"; fi; \
		exit $$EXIT_CODE

# 停止后台路由网关
stop:
	@if [ -f .pids/portkey.pid ]; then \
		kill $$(cat .pids/portkey.pid) 2>/dev/null || true; \
		rm -f .pids/portkey.pid; \
		echo "✓ 路由网关已停止"; \
	else \
		echo "ℹ️  没有正在运行的路由网关"; \
	fi
	@if [ -f .pids/dashboard.pid ]; then \
		kill $$(cat .pids/dashboard.pid) 2>/dev/null || true; \
		rm -f .pids/dashboard.pid; \
		echo "✓ Dashboard 前端已停止"; \
	else \
		echo "ℹ️  没有正在运行的 Dashboard 前端"; \
	fi
