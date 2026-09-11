package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/service"
	"cvm-mock-e2b/internal/store"
)

const internalModifyTestAPIKey = "test-sandbox-api-key"

func newInternalModifyTestRouter(h *handler) *gin.Engine {
	r := gin.New()
	internal := r.Group("/internal")
	internal.Use(internalAPIKeyAuth(internalModifyTestAPIKey))
	registerInternalModifyRoutes(internal, h)
	return r
}

// newModifyTestHandler 交付一台落在 2C4G/50G 源池的实例，并返回 4C8G/80G 目标池。
func newModifyTestHandler(t *testing.T) (*handler, string, core.Pool) {
	t.Helper()
	ctx := t.Context()
	svc := service.NewService(store.NewMemoryStore())

	newPool := func(name, instanceType string, disk int) core.Pool {
		pool, err := svc.CreatePool(ctx, name, "", "img-modify", 1, "vpc-test", "subnet-test", "ap-beijing-8", []string{"sg-test"})
		if err != nil {
			t.Fatalf("create pool %s: %v", name, err)
		}
		pool.InstanceType = instanceType
		pool.SystemDiskSize = disk
		pool.TemplateClassID = name
		pool.SKUID = "sku-" + name
		pool, err = svc.UpdatePool(ctx, pool)
		if err != nil {
			t.Fatalf("update pool %s: %v", name, err)
		}
		return pool
	}
	sourcePool := newPool("spec-2c4g50g", "SA9.MEDIUM4", 50)
	targetPool := newPool("spec-4c8g80g", "SA9.LARGE8", 80)

	if _, err := svc.RefillVerified(ctx, sourcePool.ID, 1, []string{"10.0.0.5"}, []string{"ins-modify-1"},
		func(context.Context, string) error { return nil }); err != nil {
		t.Fatalf("refill: %v", err)
	}
	inst, err := svc.Allocate(ctx, sourcePool.ID)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	if _, err := svc.CreateSandbox(ctx, core.Sandbox{
		ID:              "sb-modify-1",
		InstanceID:      inst.ID,
		PoolID:          sourcePool.ID,
		TemplateClassID: sourcePool.TemplateClassID,
	}); err != nil {
		t.Fatalf("create sandbox: %v", err)
	}
	return &handler{svc: svc}, "sb-modify-1", targetPool
}

func postModify(t *testing.T, router *gin.Engine, sandboxID, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/internal/sandboxes/"+sandboxID+"/modify", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", internalModifyTestAPIKey)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

func TestPostInternalModifyAcceptsAndIsIdempotent(t *testing.T) {
	gin.SetMode(gin.TestMode)
	h, sandboxID, targetPool := newModifyTestHandler(t)
	router := newInternalModifyTestRouter(h)
	body := fmt.Sprintf(`{"idempotency_key":"task-1","target_pool_id":%q}`, targetPool.ID)

	first := postModify(t, router, sandboxID, body)
	if first.Code != http.StatusAccepted {
		t.Fatalf("status = %d body=%s", first.Code, first.Body.String())
	}
	var accepted internalModifyOperationResponse
	if err := json.Unmarshal(first.Body.Bytes(), &accepted); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if accepted.OperationID == "" || accepted.Status != string(core.ModifyOperationStatusRunning) {
		t.Fatalf("unexpected accepted payload: %+v", accepted)
	}
	if accepted.TargetInstanceType != "SA9.LARGE8" || accepted.TargetSystemDiskSize != 80 {
		t.Fatalf("expected frozen 4C8G/80G target, got %s/%dG", accepted.TargetInstanceType, accepted.TargetSystemDiskSize)
	}

	second := postModify(t, router, sandboxID, body)
	if second.Code != http.StatusAccepted {
		t.Fatalf("retry status = %d body=%s", second.Code, second.Body.String())
	}
	var replayed internalModifyOperationResponse
	if err := json.Unmarshal(second.Body.Bytes(), &replayed); err != nil {
		t.Fatalf("decode retry response: %v", err)
	}
	if replayed.OperationID != accepted.OperationID {
		t.Fatalf("expected the retry to replay operation %s, got %s", accepted.OperationID, replayed.OperationID)
	}
}

func TestPostInternalModifyRejectsMissingFields(t *testing.T) {
	gin.SetMode(gin.TestMode)
	h, sandboxID, _ := newModifyTestHandler(t)
	router := newInternalModifyTestRouter(h)

	for name, body := range map[string]string{
		"no idempotency key": `{"target_pool_id":"pool-1"}`,
		"no target pool":     `{"idempotency_key":"task-1"}`,
		"not json":           `nope`,
	} {
		t.Run(name, func(t *testing.T) {
			rr := postModify(t, router, sandboxID, body)
			if rr.Code != http.StatusBadRequest {
				t.Fatalf("status = %d body=%s", rr.Code, rr.Body.String())
			}
		})
	}
}

func TestPostInternalModifyMapsDomainErrors(t *testing.T) {
	gin.SetMode(gin.TestMode)
	h, sandboxID, targetPool := newModifyTestHandler(t)
	router := newInternalModifyTestRouter(h)

	missing := postModify(t, router, "sb-does-not-exist",
		fmt.Sprintf(`{"idempotency_key":"task-1","target_pool_id":%q}`, targetPool.ID))
	if missing.Code != http.StatusNotFound {
		t.Fatalf("unknown sandbox status = %d body=%s", missing.Code, missing.Body.String())
	}

	// 目标池等于当前池：实例已经在目标规格上，调用方应据此收尾而不是重试。
	inst, err := h.svc.GetSandbox(t.Context(), sandboxID)
	if err != nil {
		t.Fatalf("get sandbox: %v", err)
	}
	noop := postModify(t, router, sandboxID,
		fmt.Sprintf(`{"idempotency_key":"task-noop","target_pool_id":%q}`, inst.PoolID))
	if noop.Code != http.StatusConflict {
		t.Fatalf("no-op target status = %d body=%s", noop.Code, noop.Body.String())
	}
	if code := modifyErrorCode(t, noop); code != "MODIFY_TARGET_ALREADY_APPLIED" {
		t.Fatalf("expected MODIFY_TARGET_ALREADY_APPLIED code, got %s body=%s", code, noop.Body.String())
	}

	// 降配则是配置错，必须拒绝到底。
	smaller, err := h.svc.CreatePool(t.Context(), "spec-1c2g20g", "", "img-modify", 0,
		"vpc-test", "subnet-test", "ap-beijing-8", []string{"sg-test"})
	if err != nil {
		t.Fatalf("create smaller pool: %v", err)
	}
	smaller.InstanceType = "SA9.SMALL2"
	smaller.SystemDiskSize = 20
	smaller.TemplateClassID = "spec-1c2g20g"
	smaller.SKUID = "sku-spec-1c2g20g"
	if smaller, err = h.svc.UpdatePool(t.Context(), smaller); err != nil {
		t.Fatalf("update smaller pool: %v", err)
	}
	downgrade := postModify(t, router, sandboxID,
		fmt.Sprintf(`{"idempotency_key":"task-downgrade","target_pool_id":%q}`, smaller.ID))
	if downgrade.Code != http.StatusUnprocessableEntity {
		t.Fatalf("downgrade status = %d body=%s", downgrade.Code, downgrade.Body.String())
	}
	if code := modifyErrorCode(t, downgrade); code != "MODIFY_TARGET_NOT_UPGRADE" {
		t.Fatalf("expected MODIFY_TARGET_NOT_UPGRADE code, got %s body=%s", code, downgrade.Body.String())
	}
}

func modifyErrorCode(t *testing.T, rr *httptest.ResponseRecorder) string {
	t.Helper()
	var payload struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return payload.Code
}

func TestGetInternalModifyOperation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	h, sandboxID, targetPool := newModifyTestHandler(t)
	router := newInternalModifyTestRouter(h)

	accepted := postModify(t, router, sandboxID,
		fmt.Sprintf(`{"idempotency_key":"task-1","target_pool_id":%q}`, targetPool.ID))
	var op internalModifyOperationResponse
	if err := json.Unmarshal(accepted.Body.Bytes(), &op); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	get := func(id string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/internal/sandbox-modify-operations/"+id, nil)
		req.Header.Set("X-API-Key", internalModifyTestAPIKey)
		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, req)
		return rr
	}

	found := get(op.OperationID)
	if found.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", found.Code, found.Body.String())
	}
	var fetched internalModifyOperationResponse
	if err := json.Unmarshal(found.Body.Bytes(), &fetched); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if fetched.OperationID != op.OperationID || fetched.TargetPoolID != targetPool.ID {
		t.Fatalf("unexpected operation payload: %+v", fetched)
	}

	if missing := get("mod-does-not-exist"); missing.Code != http.StatusNotFound {
		t.Fatalf("unknown operation status = %d body=%s", missing.Code, missing.Body.String())
	}
}

func TestInternalModifyRoutesRequireAPIKey(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := newInternalModifyTestRouter(&handler{})

	req := httptest.NewRequest(http.MethodPost, "/internal/sandboxes/sb-1/modify", strings.NewReader(`{}`))
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d body=%s", rr.Code, rr.Body.String())
	}
}
