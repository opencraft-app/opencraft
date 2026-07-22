FROM golang:1.25-alpine AS builder

WORKDIR /src
RUN apk add --no-cache bash curl git jq
COPY .gitignore ./.gitignore
COPY go.mod go.sum ./
RUN go mod download

COPY cmd ./cmd
COPY internal ./internal
COPY deploy ./deploy
COPY docs ./docs
COPY k8s ./k8s
COPY openspec ./openspec
COPY test ./test
RUN git init --quiet && go test ./...
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/llmgateway ./cmd/llmgateway \
    && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/llmgateway-control ./cmd/llmgateway-control \
    && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/llmgateway-traffic ./cmd/llmgateway-traffic \
    && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/llmgateway-worker ./cmd/llmgateway-worker \
	&& CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/llmgateway-set-manager ./cmd/llmgateway-set-manager \
	&& CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/velagwset-controller ./cmd/velagwset-controller \
	&& CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/velagwset-provisioner ./cmd/velagwset-provisioner \
	&& CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/llmgateway-runtime-cleaner ./cmd/llmgateway-runtime-cleaner \
	&& CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/llmgateway-db-bootstrap ./cmd/llmgateway-db-bootstrap \
	&& CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/llmgateway-db-create ./cmd/llmgateway-db-create \
	&& CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/llmgateway-set-upgrade-soak ./test/e2e/set-upgrade-soak \
	&& CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/llmgateway-regression-runner ./test/regression/cmd/runner \
	&& CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/llmgateway-regression-pacer ./test/regression/cmd/pacer

FROM node:22-alpine AS console-builder

WORKDIR /src/web
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY web ./
RUN pnpm test
RUN pnpm run build

FROM alpine:3.20

LABEL org.opencontainers.image.title="velagw" \
      org.opencontainers.image.description="LightVela LLM gateway control and traffic plane"

COPY --from=builder /out/llmgateway /usr/local/bin/llmgateway
COPY --from=builder /out/llmgateway-control /usr/local/bin/llmgateway-control
COPY --from=builder /out/llmgateway-traffic /usr/local/bin/llmgateway-traffic
COPY --from=builder /out/llmgateway-worker /usr/local/bin/llmgateway-worker
COPY --from=builder /out/llmgateway-set-manager /usr/local/bin/llmgateway-set-manager
COPY --from=builder /out/velagwset-controller /usr/local/bin/velagwset-controller
COPY --from=builder /out/velagwset-provisioner /usr/local/bin/velagwset-provisioner
COPY --from=builder /out/llmgateway-runtime-cleaner /usr/local/bin/llmgateway-runtime-cleaner
COPY --from=builder /out/llmgateway-db-bootstrap /usr/local/bin/llmgateway-db-bootstrap
COPY --from=builder /out/llmgateway-db-create /usr/local/bin/llmgateway-db-create
COPY --from=builder /out/llmgateway-set-upgrade-soak /usr/local/bin/llmgateway-set-upgrade-soak
COPY --from=builder /out/llmgateway-regression-runner /usr/local/bin/llmgateway-regression-runner
COPY --from=builder /out/llmgateway-regression-pacer /usr/local/bin/llmgateway-regression-pacer
COPY --from=console-builder /src/web/dist /opt/llmgateway/console

ENV LLMGATEWAY_CONSOLE_DIST=/opt/llmgateway/console

EXPOSE 18080
ENTRYPOINT ["llmgateway"]
