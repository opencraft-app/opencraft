FROM golang:1.25 AS builder

WORKDIR /app
ENV GOTOOLCHAIN=auto

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/trade ./cmd/trade
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/trade-migrate ./cmd/trade-migrate

FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata

COPY --from=builder /out/trade /usr/local/bin/trade
COPY --from=builder /out/trade-migrate /usr/local/bin/trade-migrate

ENTRYPOINT ["/usr/local/bin/trade"]
