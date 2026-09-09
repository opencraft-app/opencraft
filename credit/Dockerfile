FROM golang:1.25 AS builder

WORKDIR /app
ENV GOTOOLCHAIN=auto

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/credit ./cmd/credit
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/credit-migrate ./cmd/credit-migrate
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/credit-usage-worker ./cmd/credit-usage-worker
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/credit-lifecycle-worker ./cmd/credit-lifecycle-worker

FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata

COPY --from=builder /out/credit /usr/local/bin/credit
COPY --from=builder /out/credit-migrate /usr/local/bin/credit-migrate
COPY --from=builder /out/credit-usage-worker /usr/local/bin/credit-usage-worker
COPY --from=builder /out/credit-lifecycle-worker /usr/local/bin/credit-lifecycle-worker

ENTRYPOINT ["/usr/local/bin/credit"]
