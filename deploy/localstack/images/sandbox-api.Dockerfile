# syntax=docker/dockerfile:1.7
FROM golang:1.22-bullseye AS builder
ARG TARGETARCH
WORKDIR /app
ENV GOTOOLCHAIN=go1.24.0
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux GOARCH="${TARGETARCH}" go build -o /out/api-gin ./api-gin

FROM alpine:3.19
RUN adduser -D -u 10001 app
WORKDIR /home/app
COPY --from=builder /out/api-gin /usr/local/bin/api-gin
USER app
ENV API_ADDR=:8080
EXPOSE 8080
CMD ["api-gin"]
