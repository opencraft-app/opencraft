# syntax=docker/dockerfile:1.7

FROM golang:1.26-bookworm AS builder
WORKDIR /src/third_party/staticpages

COPY third_party/staticpages/go.mod third_party/staticpages/go.sum ./
RUN GOWORK=off go mod download

COPY third_party/staticpages ./
RUN GOWORK=off CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/staticpages .

FROM --platform=linux/amd64 alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=builder /out/staticpages /usr/local/bin/staticpages

EXPOSE 8080 8081
ENTRYPOINT ["/usr/local/bin/staticpages"]
CMD ["serve", "--api", "--proxy", "--config", "/etc/staticpages/config.yaml"]
