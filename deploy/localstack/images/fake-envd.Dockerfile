FROM golang:1.26-bookworm AS builder

WORKDIR /src
COPY ctl /src/ctl
COPY deploy/local/mockservers/envd /src/deploy/local/mockservers/envd

WORKDIR /src/deploy/local/mockservers/envd
ENV GOWORK=off
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o /out/fake-envd .

FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata
COPY --from=builder /out/fake-envd /usr/local/bin/fake-envd

EXPOSE 19050
ENTRYPOINT ["/usr/local/bin/fake-envd"]
