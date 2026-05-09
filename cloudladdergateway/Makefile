IMAGE ?= cloudladdergateway
TAG ?= dev
CSIGHUB_PUBLIC_REGISTRY ?= csighub.tencentyun.com/skipzhang
CSIGHUB_PUSH_REGISTRY ?= 21.41.42.116:80/skipzhang
CRANE ?= crane
IMAGE_TARBALL ?= $(TMPDIR)$(IMAGE)-$(TAG).tar
REGISTRY ?= $(CSIGHUB_PUBLIC_REGISTRY)

.PHONY: generate test image login-csighub csighub csighub-internal csighub-public run-image

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

image:
	docker build --platform linux/amd64 \
		-f Dockerfile \
		-t "$(REGISTRY)/$(IMAGE):$(TAG)" \
		..

login-csighub:
	REGISTRY_HOST="$$(printf '%s' "$(REGISTRY)" | cut -d/ -f1)" \
		./scripts/csighub_login.sh

csighub: image
	docker save "$(REGISTRY)/$(IMAGE):$(TAG)" -o "$(IMAGE_TARBALL)"
	$(MAKE) csighub-internal IMAGE_TARBALL="$(IMAGE_TARBALL)" IMAGE="$(IMAGE)" TAG="$(TAG)" CSIGHUB_PUSH_REGISTRY="$(CSIGHUB_PUSH_REGISTRY)" CRANE="$(CRANE)"
	$(MAKE) csighub-public IMAGE_TARBALL="$(IMAGE_TARBALL)" IMAGE="$(IMAGE)" TAG="$(TAG)" CSIGHUB_PUBLIC_REGISTRY="$(CSIGHUB_PUBLIC_REGISTRY)" CRANE="$(CRANE)"

csighub-internal:
	$(CRANE) push --insecure "$(IMAGE_TARBALL)" "$(CSIGHUB_PUSH_REGISTRY)/$(IMAGE):$(TAG)"
	@echo "pushed $(CSIGHUB_PUSH_REGISTRY)/$(IMAGE):$(TAG)"

csighub-public:
	$(CRANE) push "$(IMAGE_TARBALL)" "$(CSIGHUB_PUBLIC_REGISTRY)/$(IMAGE):$(TAG)"
	@echo "pushed $(CSIGHUB_PUBLIC_REGISTRY)/$(IMAGE):$(TAG)"

run-image:
	@test -n "$$CLOUDLADDER_PAYMENT_HMAC_SECRET" || (echo "CLOUDLADDER_PAYMENT_HMAC_SECRET is required at runtime"; exit 1)
	@printf 'CLOUDLADDER_PAYMENT_HMAC_SECRET set=true length=%s fingerprint=%s\n' \
		"$${#CLOUDLADDER_PAYMENT_HMAC_SECRET}" \
		"$$(printf '%s' "$$CLOUDLADDER_PAYMENT_HMAC_SECRET" | shasum -a 256 | awk '{print substr($$1,1,12)}')"
	docker run --rm -p 8095:8095 \
		-e CLOUDLADDER_PAYMENT_HMAC_SECRET \
		"$(REGISTRY)/$(IMAGE):$(TAG)"
