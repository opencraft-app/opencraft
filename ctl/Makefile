SHELL := /bin/bash
PATH := $(PATH):$(shell go env GOPATH)/bin

# Go command to use for build
GO ?= go
DOCKER ?= docker
GOOS=linux
GOARCH=amd64

# Image configuration
BASE_IMAGE_REPOSITORY ?= ccr.ccs.tencentyun.com/clawhub/ctl-base
BASE_IMAGE_TAG ?= latest
IMAGE_REPOSITORY ?= ccr.ccs.tencentyun.com/clawhub/ctl
IMAGE_TAG ?= $(shell \
	source "tools/version.sh"; \
	echo $${VERSION}; \
)

show-image-tag:
	echo ${IMAGE_TAG}

build: build-api build-service build-bypass

build-api:
	tools/build_src.sh api linux

build-service:
	tools/build_src.sh service linux

build-bypass:
	tools/build_src.sh bypass linux

# Base image targets
build-base-image:
	$(DOCKER) build -t ${BASE_IMAGE_REPOSITORY}:${BASE_IMAGE_TAG} -f Dockerfile.base ./

release-base-image: build-base-image
	$(DOCKER) push ${BASE_IMAGE_REPOSITORY}:${BASE_IMAGE_TAG}

# Application image targets
build-image:
	$(DOCKER) build \
		--build-arg BASE_IMAGE=${BASE_IMAGE_REPOSITORY}:${BASE_IMAGE_TAG} \
		-t ${IMAGE_REPOSITORY}:${IMAGE_TAG} \
		./
	$(DOCKER) tag ${IMAGE_REPOSITORY}:${IMAGE_TAG} ${IMAGE_REPOSITORY}:latest

release-image: build-image
	$(DOCKER) push ${IMAGE_REPOSITORY}:${IMAGE_TAG}
	$(DOCKER) push ${IMAGE_REPOSITORY}:latest

# Database migration targets
# Usage: make migrate-up DB_DSN="mysql://user:password@tcp(host:port)/database"
DB_DSN ?= ""
LOCAL_SECRET_ENV_FILE ?= $(abspath ../.secret/ctl/local.env)
LOCAL_MYSQL_ROOT_PASSWORD ?= $(shell if [ -f "$(LOCAL_SECRET_ENV_FILE)" ]; then set -a; . "$(LOCAL_SECRET_ENV_FILE)"; printf '%s' "$$CTL_LOCAL_MYSQL_ROOT_PASSWORD"; fi)
DB_DSN_LOCAL ?= mysql://root:$(LOCAL_MYSQL_ROOT_PASSWORD)@tcp(127.0.0.1:13306)/ctl?multiStatements=true
LOCAL_QUOTA_USER_ID ?= "10001"
LOCAL_QUOTA_TOTAL ?= "5"

migrate-up:
	@echo "Running database migrations (up)..."
	$(GO) run -tags 'mysql' github.com/golang-migrate/migrate/v4/cmd/migrate \
		-path ./migrations \
		-database "$(DB_DSN)" \
		up

migrate-down:
	@echo "Rolling back last migration..."
	$(GO) run -tags 'mysql' github.com/golang-migrate/migrate/v4/cmd/migrate \
		-path ./migrations \
		-database "$(DB_DSN)" \
		down 1

migrate-version:
	@echo "Current migration version:"
	$(GO) run -tags 'mysql' github.com/golang-migrate/migrate/v4/cmd/migrate \
		-path ./migrations \
		-database "$(DB_DSN)" \
		version

migrate-up-local:
	@test -n "$(LOCAL_MYSQL_ROOT_PASSWORD)" || (echo "ERROR: missing CTL_LOCAL_MYSQL_ROOT_PASSWORD in $(LOCAL_SECRET_ENV_FILE)"; exit 1)
	@$(MAKE) migrate-up DB_DSN='$(DB_DSN_LOCAL)'

migrate-down-local:
	@test -n "$(LOCAL_MYSQL_ROOT_PASSWORD)" || (echo "ERROR: missing CTL_LOCAL_MYSQL_ROOT_PASSWORD in $(LOCAL_SECRET_ENV_FILE)"; exit 1)
	@$(MAKE) migrate-down DB_DSN='$(DB_DSN_LOCAL)'

migrate-version-local:
	@test -n "$(LOCAL_MYSQL_ROOT_PASSWORD)" || (echo "ERROR: missing CTL_LOCAL_MYSQL_ROOT_PASSWORD in $(LOCAL_SECRET_ENV_FILE)"; exit 1)
	@$(MAKE) migrate-version DB_DSN='$(DB_DSN_LOCAL)'

seed-local-quota:
	@test -n "$(LOCAL_MYSQL_ROOT_PASSWORD)" || (echo "ERROR: missing CTL_LOCAL_MYSQL_ROOT_PASSWORD in $(LOCAL_SECRET_ENV_FILE)"; exit 1)
	@echo "Seeding local quota for user_id=$(LOCAL_QUOTA_USER_ID)..."
	$(DOCKER) exec ctl-dev-mysql mysql -uroot -p"$(LOCAL_MYSQL_ROOT_PASSWORD)" ctl -e "\
	INSERT INTO user_resource_quota (\
	  user_id,\
	  resource_name,\
	  resource_key,\
	  resource_quota_total,\
	  resource_quota_available,\
	  created_time,\
	  updated_time\
	) VALUES (\
	  '$(LOCAL_QUOTA_USER_ID)',\
	  'OPENCLAW_INSTANCE',\
	  '',\
	  $(LOCAL_QUOTA_TOTAL),\
	  $(LOCAL_QUOTA_TOTAL),\
	  NOW(),\
	  NOW()\
	)\
	ON DUPLICATE KEY UPDATE\
	  resource_quota_total = VALUES(resource_quota_total),\
	  resource_quota_available = VALUES(resource_quota_available),\
	  updated_time = NOW();"

clean:
	@rm -rf bin/

# ===== Test environment targets =====
TEST_IMAGE_TAG ?= test-$(shell date +%Y%m%d)-$(shell git rev-parse --short HEAD)
DB_DSN_TEST ?= ""

test-regression:
	$(GO) test ./pkg/instance/... ./main/api/... -count=1

test-integration-api:
	$(GO) test -tags=integration ./main/api/... -count=1

test-integration-model:
	$(GO) test -tags=integration \
		./pkg/model/channelloginsession \
		./test/model/instance \
		./test/model/operationhistory \
		./test/model/task \
		./test/model/userresourcequota \
		-count=1

test-integration-instance:
	$(GO) test -tags=integration ./pkg/instance/... ./test/logic/instance/... ./test/integration/... -count=1

test-integration: test-integration-api test-integration-model test-integration-instance
	@echo "CTL integration suites passed"

CTL_TEST_BASE_URL ?= http://127.0.0.1:19590
CTL_TEST_USER_ID ?=

testenv-smoke:
	@test -n "$(CTL_TEST_USER_ID)" || (echo "ERROR: CTL_TEST_USER_ID is required (must look like usr_*)"; exit 1)
	python3 ./scripts/tests/smoke-openclaw-testenv.py --base-url "$(CTL_TEST_BASE_URL)" --user-id "$(CTL_TEST_USER_ID)"

testenv-regression:
	@test -n "$(CTL_TEST_USER_ID)" || (echo "ERROR: CTL_TEST_USER_ID is required (must look like usr_*)"; exit 1)
	python3 ./scripts/tests/regression-openclaw-testenv.py --base-url "$(CTL_TEST_BASE_URL)" --user-id "$(CTL_TEST_USER_ID)"

testenv-abuse-cooldown:
	@test -n "$(CTL_TEST_USER_ID)" || (echo "ERROR: CTL_TEST_USER_ID is required (must look like usr_*)"; exit 1)
	python3 ./scripts/tests/smoke-abuse-cooldown-testenv.py --base-url "$(CTL_TEST_BASE_URL)" --user-id "$(CTL_TEST_USER_ID)"

build-test-image:
	$(DOCKER) build \
		--build-arg BASE_IMAGE=${BASE_IMAGE_REPOSITORY}:${BASE_IMAGE_TAG} \
		-t ${IMAGE_REPOSITORY}:${TEST_IMAGE_TAG} \
		./

push-test-image: build-test-image
	$(DOCKER) push ${IMAGE_REPOSITORY}:${TEST_IMAGE_TAG}
	@echo "Image: ${IMAGE_REPOSITORY}:${TEST_IMAGE_TAG}"

deploy-test: push-test-image
	@echo "Image pushed: ${IMAGE_REPOSITORY}:${TEST_IMAGE_TAG}"
	@echo "Next steps:"
	@echo "  1. ENV=<env> CTL_IMAGE_TAG=${TEST_IMAGE_TAG} bash ctl/scripts/deploy-k8s.sh"

migrate-up-test:
	@test -n "$(DB_DSN_TEST)" || (echo "ERROR: DB_DSN_TEST is required. Example: make migrate-up-test DB_DSN_TEST=\"mysql://root:pass@tcp(host:3306)/ctl?multiStatements=true\""; exit 1)
	@$(MAKE) migrate-up DB_DSN=$(DB_DSN_TEST)

migrate-version-test:
	@test -n "$(DB_DSN_TEST)" || (echo "ERROR: DB_DSN_TEST is required"; exit 1)
	@$(MAKE) migrate-version DB_DSN=$(DB_DSN_TEST)
