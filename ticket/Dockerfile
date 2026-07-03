FROM golang:1.25-bookworm AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
# 只复制构建所需的源码目录，避免把 README / docs / api 等无关文件打进构建上下文
COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY migrations/ ./migrations/
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/ticket ./cmd/ticket
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/ticket-migrate ./cmd/ticket-migrate

FROM gcr.io/distroless/base-debian12:nonroot
COPY --from=builder /out/ticket /usr/local/bin/ticket
COPY --from=builder /out/ticket-migrate /usr/local/bin/ticket-migrate
USER nonroot:nonroot
EXPOSE 8090
ENTRYPOINT ["/usr/local/bin/ticket"]
