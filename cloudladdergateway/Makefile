.PHONY: generate test

generate:
	rm -rf gen cloudladdergateway
	protoc -I proto \
		--go_out=. --go_opt=paths=source_relative \
		--connect-go_out=. --connect-go_opt=paths=source_relative \
		proto/cloudladdergateway/v1/gateway.proto
	mkdir -p gen/cloudladdergateway/v1 gen/cloudladdergateway/v1/gatewayv1connect
	mv cloudladdergateway/v1/gateway.pb.go gen/cloudladdergateway/v1/gateway.pb.go
	mv cloudladdergateway/v1/gatewayv1connect/gateway.connect.go gen/cloudladdergateway/v1/gatewayv1connect/gateway.connect.go
	rm -rf cloudladdergateway

test:
	go test ./...
