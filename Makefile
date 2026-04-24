.PHONY: dev stop backend dashboard install setup precommit-check test-regression test-ctl-regression test-ctl-integration test-ai-gateway-regression help

ROOT_DIR := $(shell pwd)
PID_DIR  := $(ROOT_DIR)/.pids
LOG_DIR  := $(ROOT_DIR)/logs

# 一键启动所有服务（路由网关 + AI Gateway 后端 + Dashboard 前端）
dev: install
	@echo "🚀 启动所有服务..."
	@mkdir -p $(PID_DIR) $(LOG_DIR)
	@# 清理可能占用端口的残留进程
	@for port in 8787 18080 13000; do \
		pids=$$(lsof -ti:$$port 2>/dev/null); \
		if [ -n "$$pids" ]; then \
			echo "  ⚠  端口 $$port 被以下进程占用，正在终止：$$pids"; \
			echo "$$pids" | xargs kill 2>/dev/null || true; \
			sleep 1; \
		fi; \
	done
	@# 启动路由网关（后台）
	@cd $(ROOT_DIR)/ai-gateway && $(MAKE) -s portkey-ensure
	@nohup /bin/zsh -lc 'cd "$(ROOT_DIR)/gateway-dashboard" && exec node node_modules/@portkey-ai/gateway/build/start-server.js --headless' \
		> $(LOG_DIR)/portkey.log 2>&1 < /dev/null & echo $$! > $(PID_DIR)/portkey.pid
	@echo "  ✓ 路由网关"
	@# 启动 AI Gateway 后端（后台）
	@nohup /bin/zsh -lc 'cd "$(ROOT_DIR)/ai-gateway" && \
		if [ -f .env ]; then \
			set -a; \
			. ./.env; \
			set +a; \
		fi && \
		exec go run ./cmd/server' \
		>> $(LOG_DIR)/backend.log 2>&1 < /dev/null & echo $$! > $(PID_DIR)/backend.pid
	@echo "  ✓ AI Gateway 后端 (http://localhost:18080)"
	@echo "  → 等待后端就绪（最多 10s）..."
	@for i in 1 2 3 4 5; do \
		sleep 2; \
		curl -sf http://localhost:18080/health > /dev/null 2>&1 && break; \
		if [ $$i -eq 5 ]; then \
			echo "  ❌ 后端启动失败，请检查日志：$(LOG_DIR)/backend.log"; \
			tail -20 $(LOG_DIR)/backend.log; \
			exit 1; \
		fi; \
		echo "  → 等待后端启动 ($$i/5)..."; \
	done
	@echo "  → 后端就绪"
	@# 启动 Dashboard 前端（后台）
	@nohup /bin/zsh -lc 'cd "$(ROOT_DIR)/gateway-dashboard" && exec npm run dev' \
		> $(LOG_DIR)/dashboard.log 2>&1 < /dev/null & echo $$! > $(PID_DIR)/dashboard.pid
	@echo "  ✓ Dashboard 前端 (http://localhost:13000/admin/gateway/login)"
	@echo ""
	@echo "✅ 所有服务已启动！"
	@echo "   路由网关"
	@echo "   AI Gateway API:  http://localhost:18080"
	@echo "   Dashboard:       http://localhost:13000/admin/gateway/login"
	@echo ""
	@echo "📋 日志文件: $(LOG_DIR)/"
	@echo "🛑 停止服务: make stop"

# 一键停止所有服务
stop:
	@echo "🛑 停止所有服务..."
	@if [ -f $(PID_DIR)/portkey.pid ]; then kill $$(cat $(PID_DIR)/portkey.pid) 2>/dev/null || true; rm -f $(PID_DIR)/portkey.pid; echo "  ✓ 路由网关已停止"; fi
	@if [ -f $(PID_DIR)/backend.pid ]; then kill $$(cat $(PID_DIR)/backend.pid) 2>/dev/null || true; rm -f $(PID_DIR)/backend.pid; echo "  ✓ AI Gateway 后端已停止"; fi
	@if [ -f $(PID_DIR)/dashboard.pid ]; then kill $$(cat $(PID_DIR)/dashboard.pid) 2>/dev/null || true; rm -f $(PID_DIR)/dashboard.pid; echo "  ✓ Dashboard 前端已停止"; fi
	@# 强制清理残留端口占用
	@for port in 8787 18080 13000; do \
		pids=$$(lsof -ti:$$port 2>/dev/null); \
		if [ -n "$$pids" ]; then \
			echo "  ⚠  清理端口 $$port 残留进程：$$pids"; \
			echo "$$pids" | xargs kill -9 2>/dev/null || true; \
		fi; \
	done
	@echo "✅ 所有服务已停止"

# 只启动后端（含 Portkey）
backend:
	@cd ai-gateway && $(MAKE) dev

# 只启动前端
dashboard:
	@cd gateway-dashboard && npm run dev

# 安装依赖
install:
	@echo "📦 检查依赖..."
	@mkdir -p $(LOG_DIR)
	@cd ai-gateway && $(MAKE) -s portkey-ensure
	@if [ ! -d gateway-dashboard/node_modules ]; then \
		echo "  → 安装 gateway-dashboard 依赖..."; \
		cd gateway-dashboard && npm install; \
	fi
	@echo "✅ 依赖就绪"

# 前台交互式运行（可看到实时日志，Ctrl+C 停止全部）
dev-fg: install
	@echo "🚀 前台启动所有服务（Ctrl+C 停止全部）..."
	@echo "  → 路由网关"
	@echo "  → AI Gateway 后端 (http://localhost:18080)"
	@echo "  → Dashboard 前端 (http://localhost:13000/admin/gateway/login)"
	@echo ""
	@(trap 'kill 0' EXIT; \
		(node gateway-dashboard/node_modules/@portkey-ai/gateway/build/start-server.js --headless) & \
		(cd ai-gateway && \
			if [ -f .env ]; then set -a; . ./.env; set +a; fi && \
			go run ./cmd/server) & \
		(cd gateway-dashboard && npm run dev) & \
		wait)

# 项目初始化（clone 后执行一次，配置 pre-commit hook）
setup:
	@command -v pre-commit >/dev/null 2>&1 || { echo "❌ 请先安装 pre-commit：pip install pre-commit"; exit 1; }
	@pre-commit install
	@echo "✅ pre-commit 已配置，后续每次 git commit 会自动检查编译"

# 手动运行预提交检查
precommit-check:
	@pre-commit run --all-files

# 仓库内可跑的关键回归入口
test-ctl-regression:
	@cd ctl && $(MAKE) test-regression

test-ctl-integration:
	@cd ctl && $(MAKE) test-integration

test-ai-gateway-regression:
	@cd ai-gateway && $(MAKE) test-regression

test-regression: test-ai-gateway-regression test-ctl-regression
	@echo "✅ 核心回归已通过"

# 帮助信息
help:
	@echo "📖 Mono 项目 - Makefile 命令列表"
	@echo ""
	@echo "初始化:"
	@echo "  make setup            - 项目初始化（clone 后执行一次）"
	@echo ""
	@echo "开发命令:"
	@echo "  make dev              - 启动所有服务（后台）"
	@echo "  make dev-fg           - 启动所有服务（前台，可看日志）"
	@echo "  make stop             - 停止所有服务"
	@echo "  make backend          - 只启动 AI Gateway 后端"
	@echo "  make dashboard        - 只启动 Dashboard 前端"
	@echo "  make install          - 安装依赖"
	@echo ""
	@echo "检查:"
	@echo "  make precommit-check  - 手动运行编译检查"
	@echo "  make test-regression  - 运行 ai-gateway + ctl 核心回归"
	@echo "  make test-ai-gateway-regression - 运行 ai-gateway 数据面回归"
	@echo "  make test-ctl-regression - 运行 ctl OpenClaw/频道回归"
	@echo "  make test-ctl-integration - 运行 ctl integration suites"
