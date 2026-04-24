FROM golang:1.24 AS builder

WORKDIR /app
ENV GOTOOLCHAIN=auto

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/payment ./cmd/payment
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/payment-migrate ./cmd/payment-migrate

FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata

COPY --from=builder /out/payment /usr/local/bin/payment
COPY --from=builder /out/payment-migrate /usr/local/bin/payment-migrate

ENTRYPOINT ["/usr/local/bin/payment"]
