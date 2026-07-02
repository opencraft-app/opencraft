FROM golang:1.25-bookworm AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/ticket ./cmd/ticket
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/ticket-migrate ./cmd/ticket-migrate

FROM gcr.io/distroless/base-debian12:nonroot
COPY --from=builder /out/ticket /usr/local/bin/ticket
COPY --from=builder /out/ticket-migrate /usr/local/bin/ticket-migrate
USER nonroot:nonroot
EXPOSE 8090
ENTRYPOINT ["/usr/local/bin/ticket"]
