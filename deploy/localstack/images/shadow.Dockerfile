FROM golang:1.25 AS builder

WORKDIR /src
ENV GOTOOLCHAIN=auto \
    GOPRIVATE=git.woa.com \
    GONOPROXY=git.woa.com \
    GONOSUMDB=git.woa.com

COPY shared/cloudladdertransport/go.mod shared/cloudladdertransport/go.mod
COPY shadow/go.mod shadow/go.sum shadow/
COPY shadow/tencentcloud-sdk-go shadow/tencentcloud-sdk-go
COPY shadow/third_party/polaris-go-v2 shadow/third_party/polaris-go-v2

WORKDIR /src/shadow
RUN go mod download

WORKDIR /src
COPY shared/cloudladdertransport shared/cloudladdertransport
COPY shadow shadow

WORKDIR /src/shadow
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=linux GOARCH="${TARGETARCH}" go build -o /out/shadowd ./cmd/shadowd

FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata

COPY --from=builder /out/shadowd /usr/local/bin/shadowd

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/shadowd"]
