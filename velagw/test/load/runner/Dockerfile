FROM golang:1.25-alpine AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY test/load/runner ./test/load/runner
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/llmgateway-load-runner ./test/load/runner

FROM alpine:3.20

COPY --from=builder /out/llmgateway-load-runner /usr/local/bin/llmgateway-load-runner

ENTRYPOINT ["/usr/local/bin/llmgateway-load-runner"]
