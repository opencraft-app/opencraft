SHELL := /bin/bash

APP=api-gin
GO_FILES=$(shell find . -name '*.go' -not -path './vendor/*')

.PHONY: run test lint tidy generate

run:
	API_ADDR?=:8081
	MYSQL_DSN?=
	@echo "[run] addr=$${API_ADDR} dsn=$${MYSQL_DSN:-memory}"
	@API_ADDR=$${API_ADDR} MYSQL_DSN=$${MYSQL_DSN} go run ./...

test:
	go test ./...

lint:
	go vet ./...

tidy:
	go mod tidy

generate:
	go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.4.1 --generate gin,types --package api --include-tags sandboxes -o gen/api.gen.go ../openapi.yaml
