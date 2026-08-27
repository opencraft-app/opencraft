module localstack-envd

go 1.26.0

require (
	connectrpc.com/connect v1.19.1
	ctl v0.0.0
	github.com/go-sql-driver/mysql v1.9.3
)

require (
	filippo.io/edwards25519 v1.1.0 // indirect
	google.golang.org/protobuf v1.36.11 // indirect
)

replace ctl => ../../../../ctl
