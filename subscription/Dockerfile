FROM golang:1.26 AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/subscription ./cmd/subscription
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/subscription-migrate ./cmd/subscription-migrate

FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata

COPY --from=builder /out/subscription /usr/local/bin/subscription
COPY --from=builder /out/subscription-migrate /usr/local/bin/subscription-migrate

ENTRYPOINT ["/usr/local/bin/subscription"]
