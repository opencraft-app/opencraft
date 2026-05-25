# syntax=docker/dockerfile:1.7

FROM golang:1.26-bookworm AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/vibebase ./cmd/vibebase

FROM --platform=linux/amd64 alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=builder /out/vibebase /usr/local/bin/vibebase
ENV VIBEBASE_ADDR=:8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/vibebase"]
