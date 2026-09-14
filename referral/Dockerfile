FROM golang:1.25 AS builder

WORKDIR /app
ENV GOTOOLCHAIN=auto

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/referral ./cmd/referral
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/referral-worker ./cmd/referral-worker
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/referral-migrate ./cmd/referral-migrate
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/referral-campaign ./cmd/referral-campaign

FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata

COPY --from=builder /out/referral /usr/local/bin/referral
COPY --from=builder /out/referral-worker /usr/local/bin/referral-worker
COPY --from=builder /out/referral-migrate /usr/local/bin/referral-migrate
COPY --from=builder /out/referral-campaign /usr/local/bin/referral-campaign

ENTRYPOINT ["/usr/local/bin/referral"]
