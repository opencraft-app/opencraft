FROM golang:1.26-bookworm AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/api ./main/api
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/service ./main/service
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/bypass ./main/bypass

FROM alpine:3.20

ARG PROJECT_HOME=/usr/local/lightglobal
WORKDIR $PROJECT_HOME

RUN apk add --no-cache tzdata curl

ENV TZ=Asia/Shanghai
ENV LC_ALL=en_US.utf8

RUN mkdir -p $PROJECT_HOME/bin $PROJECT_HOME/conf/common
COPY --from=builder /out/api $PROJECT_HOME/bin/api
COPY --from=builder /out/service $PROJECT_HOME/bin/service
COPY --from=builder /out/bypass $PROJECT_HOME/bin/bypass
COPY i18n $PROJECT_HOME/i18n
COPY conf/server/common $PROJECT_HOME/conf/common
