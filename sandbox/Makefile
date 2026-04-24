SHELL := /bin/bash
PATH := $(PATH):$(shell go env GOPATH)/bin

GO ?= go
DB_DSN ?= ""

migrate-up:
	@echo "Running sandbox migrations (up)..."
	$(GO) run -tags 'mysql' github.com/golang-migrate/migrate/v4/cmd/migrate \
		-path ./migrations \
		-database "$(DB_DSN)" \
		up

migrate-down:
	@echo "Rolling back last sandbox migration..."
	$(GO) run -tags 'mysql' github.com/golang-migrate/migrate/v4/cmd/migrate \
		-path ./migrations \
		-database "$(DB_DSN)" \
		down 1

migrate-version:
	@echo "Current sandbox migration version:"
	$(GO) run -tags 'mysql' github.com/golang-migrate/migrate/v4/cmd/migrate \
		-path ./migrations \
		-database "$(DB_DSN)" \
		version
