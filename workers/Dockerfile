# syntax=docker/dockerfile:1.7

FROM golang:1.26-bookworm AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/rescue-exporter ./cmd/rescue-exporter
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/rescue-uploader ./cmd/rescue-uploader

FROM --platform=linux/amd64 alpine:3.20

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app
COPY --from=builder /out/rescue-exporter /usr/local/bin/rescue-exporter
COPY --from=builder /out/rescue-uploader /usr/local/bin/rescue-uploader

ENV TZ=Asia/Shanghai
ENV TEMPORAL_TLS=true
ENV TEMPORAL_NAMESPACE=default
ENV TEMPORAL_TASK_QUEUE=tencent-cvm-rescue-export
ENV WORKERS_HEALTH_ADDR=:9090
ENV RESCUE_UPLOADER_PATH=/usr/local/bin/rescue-uploader

EXPOSE 9090

ENTRYPOINT ["/usr/local/bin/rescue-exporter"]
CMD ["worker"]
