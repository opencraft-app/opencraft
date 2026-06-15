package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	api "cvm-mock-e2b/api-gin/gen"
	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/provider"
	"cvm-mock-e2b/internal/service"
	"cvm-mock-e2b/internal/store"
)

const (
	handlerTestVpcID    = "vpc-test"
	handlerTestSubnetID = "subnet-test"
	handlerTestZone     = "ap-beijing-8"
)

var handlerTestSecurityGroups = []string{"sg-test"}

type stubCommandRunner struct {
	runResp provider.CommandInvocation
	runErr  error
	runReq  struct {
		region     string
		instanceID string
		script     string
	}

	getResp provider.CommandResult
	getErr  error
	getReq  struct {
		region       string
		invocationID string
		instanceID   string
	}

	sessionResp provider.TerminalSession
	sessionErr  error
	sessionReq  struct {
		region     string
		instanceID string
	}
}

func (s *stubCommandRunner) RunCommand(_ context.Context, region, instanceID, script string) (provider.CommandInvocation, error) {
	s.runReq.region = region
	s.runReq.instanceID = instanceID
	s.runReq.script = script
	return s.runResp, s.runErr
}

func (s *stubCommandRunner) GetCommandInvocation(_ context.Context, region, invocationID, instanceID string) (provider.CommandResult, error) {
	s.getReq.region = region
	s.getReq.invocationID = invocationID
	s.getReq.instanceID = instanceID
	return s.getResp, s.getErr
}

func (s *stubCommandRunner) StartTerminalSession(_ context.Context, region, instanceID string) (provider.TerminalSession, error) {
	s.sessionReq.region = region
	s.sessionReq.instanceID = instanceID
	return s.sessionResp, s.sessionErr
}

func newHandlerTestRouter(h *handler) *gin.Engine {
	return newHandlerTestRouterWithAuth(h, "")
}

func newHandlerTestRouterWithAuth(h *handler, authServiceURL string) *gin.Engine {
	r := gin.New()
	api.RegisterHandlers(r, h)
	authenticated := r.Group("/")
	authenticated.Use(userSessionAuth(authServiceURL))
	registerTATRoutes(authenticated, h)
	internal := r.Group("/internal")
	registerPoolRoutes(internal, h)
	registerTemplateClassRoutes(internal, h)
	return r
}

func TestListPoolsInternalRouteReturnsEmptyArray(t *testing.T) {
	gin.SetMode(gin.TestMode)

	svc := service.NewService(store.NewMemoryStore())
	router := newHandlerTestRouter(&handler{svc: svc})
	req := httptest.NewRequest(http.MethodGet, "/internal/pools", nil)
	rr := httptest.NewRecorder()

	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rr.Code, rr.Body.String())
	}
	if body := strings.TrimSpace(rr.Body.String()); body != "[]" {
		t.Fatalf("expected empty JSON array, got %s", body)
	}
}

func TestListPoolsInternalRouteIncludesExplicitLegacyBindingFields(t *testing.T) {
	gin.SetMode(gin.TestMode)

	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	pool, err := svc.CreatePool(ctx, "legacy", "", "img-legacy", 0, handlerTestVpcID, handlerTestSubnetID, handlerTestZone, handlerTestSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	router := newHandlerTestRouter(&handler{svc: svc})
	req := httptest.NewRequest(http.MethodGet, "/internal/pools", nil)
	rr := httptest.NewRecorder()

	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rr.Code, rr.Body.String())
	}
	var resp []map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(resp) != 1 {
		t.Fatalf("expected one pool, got %+v", resp)
	}
	if resp[0]["id"] != pool.ID {
		t.Fatalf("expected pool %s, got %+v", pool.ID, resp[0])
	}
	if value, ok := resp[0]["template_class_id"]; !ok || value != "" {
		t.Fatalf("expected explicit empty template_class_id, got value=%#v ok=%v body=%s", value, ok, rr.Body.String())
	}
	if value, ok := resp[0]["sku_id"]; !ok || value != "" {
		t.Fatalf("expected explicit empty sku_id, got value=%#v ok=%v body=%s", value, ok, rr.Body.String())
	}
}

func TestListPoolInstancesInternalRouteReturnsEmptyArray(t *testing.T) {
	gin.SetMode(gin.TestMode)

	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	pool, err := svc.CreatePool(ctx, "empty", "", "img-empty", 0, handlerTestVpcID, handlerTestSubnetID, handlerTestZone, handlerTestSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	router := newHandlerTestRouter(&handler{svc: svc})
	req := httptest.NewRequest(http.MethodGet, "/internal/pools/"+pool.ID+"/instances", nil)
	rr := httptest.NewRecorder()

	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rr.Code, rr.Body.String())
	}
	if body := strings.TrimSpace(rr.Body.String()); body != "[]" {
		t.Fatalf("expected empty JSON array, got %s", body)
	}
}

func newAuthIntrospectionServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.TrimSpace(r.Header.Get("Authorization")) != "Bearer session-good" {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "unauthorized"})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": map[string]any{
				"user": map[string]any{
					"id":    "usr_test",
					"email": "test@example.com",
				},
			},
		})
	}))
}

func createAllocatedSandbox(t *testing.T, svc *service.Service) (core.Pool, core.Instance, core.Sandbox) {
	t.Helper()
	ctx := context.Background()
	verifyOK := func(context.Context, string) error { return nil }

	pool, err := svc.CreatePool(ctx, "target", "", "img-test", 0, handlerTestVpcID, handlerTestSubnetID, handlerTestZone, handlerTestSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, pool.ID, 1, []string{"10.0.0.10"}, []string{"ins-test-1"}, verifyOK); err != nil {
		t.Fatalf("refill pool: %v", err)
	}
	inst, err := svc.Allocate(ctx, pool.ID)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	sb, err := svc.CreateSandbox(ctx, core.Sandbox{
		ID:             "sb-test-1",
		InstanceID:     inst.ID,
		PoolID:         pool.ID,
		Region:         "ap-beijing",
		TimeoutSeconds: 300,
		CreatedAt:      time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("create sandbox: %v", err)
	}
	return pool, inst, sb
}

func TestPostSandboxesWithoutTemplateIDAllocatesFromAnyPool(t *testing.T) {
	gin.SetMode(gin.TestMode)

	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }

	if _, err := svc.CreatePool(ctx, "empty", "", "img-test", 0, handlerTestVpcID, handlerTestSubnetID, handlerTestZone, handlerTestSecurityGroups); err != nil {
		t.Fatalf("create empty pool: %v", err)
	}
	targetPool, err := svc.CreatePool(ctx, "target", "", "img-test", 0, handlerTestVpcID, handlerTestSubnetID, handlerTestZone, handlerTestSecurityGroups)
	if err != nil {
		t.Fatalf("create target pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, targetPool.ID, 1, []string{"10.0.0.10"}, []string{"cloud-1"}, verifyOK); err != nil {
		t.Fatalf("refill target pool: %v", err)
	}

	router := newHandlerTestRouter(&handler{svc: svc})

	req := httptest.NewRequest(http.MethodPost, "/sandboxes", bytes.NewBufferString(`{"metadata":{"owner":"test"}}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rr.Code, rr.Body.String())
	}

	var resp api.Sandbox
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.TemplateID != targetPool.ID {
		t.Fatalf("expected templateID %s, got %s", targetPool.ID, resp.TemplateID)
	}
}

func TestPostSandboxesWithTemplateIDDoesNotFallback(t *testing.T) {
	gin.SetMode(gin.TestMode)

	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }

	emptyPool, err := svc.CreatePool(ctx, "empty", "", "img-test", 0, handlerTestVpcID, handlerTestSubnetID, handlerTestZone, handlerTestSecurityGroups)
	if err != nil {
		t.Fatalf("create empty pool: %v", err)
	}
	otherPool, err := svc.CreatePool(ctx, "other", "", "img-test", 0, handlerTestVpcID, handlerTestSubnetID, handlerTestZone, handlerTestSecurityGroups)
	if err != nil {
		t.Fatalf("create other pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, otherPool.ID, 1, []string{"10.0.0.11"}, []string{"cloud-2"}, verifyOK); err != nil {
		t.Fatalf("refill other pool: %v", err)
	}

	router := newHandlerTestRouter(&handler{svc: svc})

	req := httptest.NewRequest(http.MethodPost, "/sandboxes", bytes.NewBufferString(`{"templateID":"`+emptyPool.ID+`"}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d body=%s", rr.Code, rr.Body.String())
	}
}

func TestPostSandboxesWithTemplateClassIDUsesSandboxBindings(t *testing.T) {
	gin.SetMode(gin.TestMode)

	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }

	boundPool, err := svc.CreatePool(ctx, "bound", "", "img-test", 0, handlerTestVpcID, handlerTestSubnetID, handlerTestZone, handlerTestSecurityGroups)
	if err != nil {
		t.Fatalf("create bound pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, boundPool.ID, 1, []string{"10.0.0.12"}, []string{"cloud-3"}, verifyOK); err != nil {
		t.Fatalf("refill bound pool: %v", err)
	}
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		Name:           "OpenClaw Default",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertTemplatePoolBinding(ctx, core.TemplatePoolBinding{
		TemplateClassID: "openclaw-default",
		PoolID:          boundPool.ID,
		Priority:        1,
		AdmissionState:  core.BindingAdmissionStateActive,
	}); err != nil {
		t.Fatalf("upsert template binding: %v", err)
	}

	router := newHandlerTestRouter(&handler{svc: svc})

	req := httptest.NewRequest(http.MethodPost, "/sandboxes", bytes.NewBufferString(`{"templateClassID":"openclaw-default"}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rr.Code, rr.Body.String())
	}

	var resp api.Sandbox
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.TemplateID != boundPool.ID {
		t.Fatalf("expected resolved templateID %s, got %s", boundPool.ID, resp.TemplateID)
	}
	if resp.TemplateClassID == nil || *resp.TemplateClassID != "openclaw-default" {
		t.Fatalf("expected templateClassID openclaw-default, got %+v", resp.TemplateClassID)
	}
	if resp.ResolutionSource == nil || *resp.ResolutionSource != "sandbox_binding" {
		t.Fatalf("expected sandbox_binding resolution source, got %+v", resp.ResolutionSource)
	}
}

func TestPostSandboxesAcceptsSnakeCaseTemplateClassID(t *testing.T) {
	gin.SetMode(gin.TestMode)

	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }

	legacyPool, err := svc.CreatePool(ctx, "legacy", "", "img-legacy", 0, handlerTestVpcID, handlerTestSubnetID, handlerTestZone, handlerTestSecurityGroups)
	if err != nil {
		t.Fatalf("create legacy pool: %v", err)
	}
	boundPool, err := svc.CreatePool(ctx, "bound", "", "img-bound", 0, handlerTestVpcID, handlerTestSubnetID, handlerTestZone, handlerTestSecurityGroups)
	if err != nil {
		t.Fatalf("create bound pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, boundPool.ID, 1, []string{"10.0.0.13"}, []string{"cloud-4"}, verifyOK); err != nil {
		t.Fatalf("refill bound pool: %v", err)
	}
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		Name:           "OpenClaw Default",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertTemplatePoolBinding(ctx, core.TemplatePoolBinding{
		TemplateClassID: "openclaw-default",
		PoolID:          boundPool.ID,
		Priority:        1,
		AdmissionState:  core.BindingAdmissionStateActive,
	}); err != nil {
		t.Fatalf("upsert template binding: %v", err)
	}

	router := newHandlerTestRouter(&handler{svc: svc})

	req := httptest.NewRequest(http.MethodPost, "/sandboxes", bytes.NewBufferString(`{"template_class_id":"openclaw-default","templateID":"`+legacyPool.ID+`"}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rr.Code, rr.Body.String())
	}

	var resp api.Sandbox
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.TemplateID != boundPool.ID {
		t.Fatalf("expected snake-case template class to resolve bound pool %s, got %s", boundPool.ID, resp.TemplateID)
	}
	if resp.TemplateClassID == nil || *resp.TemplateClassID != "openclaw-default" {
		t.Fatalf("expected templateClassID openclaw-default, got %+v", resp.TemplateClassID)
	}
}

func TestPostSandboxesWithSKUIDRestrictsAllocationToRequestedSKU(t *testing.T) {
	gin.SetMode(gin.TestMode)

	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }

	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "hermes",
		Name:           "Hermes",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}

	for _, sku := range []core.SKU{
		{
			ID:              "sku-hermes-2c4g",
			Name:            "Hermes 2C4G",
			TemplateClassID: "hermes",
			BaseImage:       "img-small",
			DesiredImageID:  "img-small",
			StableImageID:   "img-small",
			InstanceType:    "SA9.MEDIUM2",
		},
		{
			ID:              "sku-hermes-4c8g",
			Name:            "Hermes 4C8G",
			TemplateClassID: "hermes",
			BaseImage:       "img-large",
			DesiredImageID:  "img-large",
			StableImageID:   "img-large",
			InstanceType:    "SA5.LARGE8",
		},
	} {
		if _, err := svc.UpsertSKU(ctx, sku); err != nil {
			t.Fatalf("upsert sku %s: %v", sku.ID, err)
		}
	}

	for _, binding := range []core.TemplateSkuBinding{
		{
			TemplateClassID:    "hermes",
			SKUID:              "sku-hermes-2c4g",
			Priority:           99,
			Weight:             1,
			AdmissionState:     string(core.BindingAdmissionStateActive),
			RolloutEligibility: true,
		},
		{
			TemplateClassID:    "hermes",
			SKUID:              "sku-hermes-4c8g",
			Priority:           1,
			Weight:             1,
			AdmissionState:     string(core.BindingAdmissionStateActive),
			RolloutEligibility: true,
		},
	} {
		if _, err := svc.UpsertTemplateSkuBinding(ctx, binding); err != nil {
			t.Fatalf("upsert template sku binding %s: %v", binding.SKUID, err)
		}
	}

	smallPool, err := svc.CreatePool(ctx, "hermes-small", "", "img-small", 0, handlerTestVpcID, handlerTestSubnetID, handlerTestZone, handlerTestSecurityGroups)
	if err != nil {
		t.Fatalf("create small pool: %v", err)
	}
	smallPool.SKUID = "sku-hermes-2c4g"
	if _, err := svc.UpdatePool(ctx, smallPool); err != nil {
		t.Fatalf("update small pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, smallPool.ID, 1, []string{"10.0.0.21"}, []string{"cloud-small"}, verifyOK); err != nil {
		t.Fatalf("refill small pool: %v", err)
	}

	largePool, err := svc.CreatePool(ctx, "hermes-large", "", "img-large", 0, handlerTestVpcID, handlerTestSubnetID, handlerTestZone, handlerTestSecurityGroups)
	if err != nil {
		t.Fatalf("create large pool: %v", err)
	}
	largePool.SKUID = "sku-hermes-4c8g"
	if _, err := svc.UpdatePool(ctx, largePool); err != nil {
		t.Fatalf("update large pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, largePool.ID, 1, []string{"10.0.0.22"}, []string{"cloud-large"}, verifyOK); err != nil {
		t.Fatalf("refill large pool: %v", err)
	}

	router := newHandlerTestRouter(&handler{svc: svc})

	req := httptest.NewRequest(http.MethodPost, "/sandboxes", bytes.NewBufferString(`{"templateClassID":"hermes","sku_id":"sku-hermes-2c4g"}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rr.Code, rr.Body.String())
	}

	var resp api.Sandbox
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.TemplateID != smallPool.ID {
		t.Fatalf("expected requested sku to resolve small pool %s, got %s", smallPool.ID, resp.TemplateID)
	}
	if resp.TemplateClassID == nil || *resp.TemplateClassID != "hermes" {
		t.Fatalf("expected templateClassID hermes, got %+v", resp.TemplateClassID)
	}
}

func TestPostSandboxesShadowModeReturnsResolutionDivergence(t *testing.T) {
	gin.SetMode(gin.TestMode)

	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }

	legacyPool, err := svc.CreatePool(ctx, "legacy", "", "img-test", 0, handlerTestVpcID, handlerTestSubnetID, handlerTestZone, handlerTestSecurityGroups)
	if err != nil {
		t.Fatalf("create legacy pool: %v", err)
	}
	bindingPool, err := svc.CreatePool(ctx, "binding", "", "img-test", 0, handlerTestVpcID, handlerTestSubnetID, handlerTestZone, handlerTestSecurityGroups)
	if err != nil {
		t.Fatalf("create binding pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, legacyPool.ID, 1, []string{"10.0.0.13"}, []string{"cloud-4"}, verifyOK); err != nil {
		t.Fatalf("refill legacy pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, bindingPool.ID, 1, []string{"10.0.0.14"}, []string{"cloud-5"}, verifyOK); err != nil {
		t.Fatalf("refill binding pool: %v", err)
	}
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-shadow",
		Name:           "OpenClaw Shadow",
		ResolutionMode: core.ResolutionModeShadow,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertTemplatePoolBinding(ctx, core.TemplatePoolBinding{
		TemplateClassID: "openclaw-shadow",
		PoolID:          bindingPool.ID,
		Priority:        1,
		AdmissionState:  core.BindingAdmissionStateActive,
	}); err != nil {
		t.Fatalf("upsert template binding: %v", err)
	}

	router := newHandlerTestRouter(&handler{svc: svc})
	req := httptest.NewRequest(http.MethodPost, "/sandboxes", bytes.NewBufferString(`{"templateClassID":"openclaw-shadow","templateID":"`+legacyPool.ID+`"}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rr.Code, rr.Body.String())
	}

	var resp api.Sandbox
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.ResolutionSource == nil || *resp.ResolutionSource != "shadow_legacy" {
		t.Fatalf("expected shadow_legacy resolution source, got %+v", resp.ResolutionSource)
	}
	if resp.ResolutionDivergence == nil || !strings.Contains(*resp.ResolutionDivergence, legacyPool.ID) {
		t.Fatalf("expected divergence mentioning %s, got %+v", legacyPool.ID, resp.ResolutionDivergence)
	}
}

func TestPatchPoolInternalRouteUpdatesBaseImageAndMarksCleanDry(t *testing.T) {
	gin.SetMode(gin.TestMode)

	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }

	pool, err := svc.CreatePool(ctx, "target", "", "img-old", 0, handlerTestVpcID, handlerTestSubnetID, handlerTestZone, handlerTestSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	insts, err := svc.RefillVerified(ctx, pool.ID, 2, []string{"10.0.0.10", "10.0.0.11"}, []string{"cloud-1", "cloud-2"}, verifyOK)
	if err != nil {
		t.Fatalf("refill target pool: %v", err)
	}
	allocated, err := svc.Allocate(ctx, pool.ID)
	if err != nil {
		t.Fatalf("allocate instance: %v", err)
	}

	router := newHandlerTestRouter(&handler{svc: svc})
	req := httptest.NewRequest(http.MethodPatch, "/internal/pools/"+pool.ID, bytes.NewBufferString(`{"base_image":"img-new","mark_clean_as_dry":true}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rr.Code, rr.Body.String())
	}

	gotPool, err := svc.GetPool(ctx, pool.ID)
	if err != nil {
		t.Fatalf("get pool: %v", err)
	}
	if gotPool.BaseImage != "img-new" {
		t.Fatalf("expected base image updated, got %q", gotPool.BaseImage)
	}

	for _, inst := range insts {
		got, err := svc.GetInstance(ctx, inst.ID)
		if err != nil {
			t.Fatalf("get instance %s: %v", inst.ID, err)
		}
		if inst.ID == allocated.ID {
			if got.State != core.StateAllocated {
				t.Fatalf("expected allocated instance to stay ALLOCATED, got %s", got.State)
			}
			continue
		}
		if got.State != core.StateDry {
			t.Fatalf("expected clean instance %s to become DRY, got %s", inst.ID, got.State)
		}
	}
}

func TestPatchPoolInternalRouteUpdatesInstanceTypeAndMarksCleanDry(t *testing.T) {
	gin.SetMode(gin.TestMode)

	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }

	pool, err := svc.CreatePool(ctx, "target", "", "img-old", 0, handlerTestVpcID, handlerTestSubnetID, handlerTestZone, handlerTestSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	insts, err := svc.RefillVerified(ctx, pool.ID, 2, []string{"10.0.0.10", "10.0.0.11"}, []string{"cloud-1", "cloud-2"}, verifyOK)
	if err != nil {
		t.Fatalf("refill target pool: %v", err)
	}
	allocated, err := svc.Allocate(ctx, pool.ID)
	if err != nil {
		t.Fatalf("allocate instance: %v", err)
	}

	router := newHandlerTestRouter(&handler{svc: svc})
	req := httptest.NewRequest(http.MethodPatch, "/internal/pools/"+pool.ID, bytes.NewBufferString(`{"instance_type":"SA5.MEDIUM4","mark_clean_as_dry":true}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rr.Code, rr.Body.String())
	}

	gotPool, err := svc.GetPool(ctx, pool.ID)
	if err != nil {
		t.Fatalf("get pool: %v", err)
	}
	if gotPool.InstanceType != "SA5.MEDIUM4" {
		t.Fatalf("expected instance type updated, got %q", gotPool.InstanceType)
	}

	for _, inst := range insts {
		got, err := svc.GetInstance(ctx, inst.ID)
		if err != nil {
			t.Fatalf("get instance %s: %v", inst.ID, err)
		}
		if inst.ID == allocated.ID {
			if got.State != core.StateAllocated {
				t.Fatalf("expected allocated instance to stay ALLOCATED, got %s", got.State)
			}
			continue
		}
		if got.State != core.StateDry {
			t.Fatalf("expected clean instance %s to become DRY, got %s", inst.ID, got.State)
		}
	}
}

func TestPostPoolInternalRouteCreatesPool(t *testing.T) {
	gin.SetMode(gin.TestMode)

	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	router := newHandlerTestRouter(&handler{svc: svc})

	req := httptest.NewRequest(http.MethodPost, "/internal/pools", bytes.NewBufferString(`{
		"name":"pool-sh-preview",
		"description":"preview pool",
		"base_image":"img-preview",
		"desired_capacity":3,
		"instance_type":"SA5.MEDIUM4",
		"vpc_id":"vpc-preview",
		"subnet_id":"subnet-preview",
		"zone":"ap-shanghai-5",
		"security_groups":["sg-a","sg-b"]
	}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rr.Code, rr.Body.String())
	}

	var pool core.Pool
	if err := json.Unmarshal(rr.Body.Bytes(), &pool); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	if pool.Name != "pool-sh-preview" {
		t.Fatalf("expected name updated, got %q", pool.Name)
	}
	if pool.BaseImage != "img-preview" {
		t.Fatalf("expected base image img-preview, got %q", pool.BaseImage)
	}
	if pool.DesiredCap != 3 {
		t.Fatalf("expected desired_capacity 3, got %d", pool.DesiredCap)
	}
	if pool.InstanceType != "SA5.MEDIUM4" {
		t.Fatalf("expected instance_type preserved, got %q", pool.InstanceType)
	}
	if pool.Status != core.PoolStatusActive {
		t.Fatalf("expected active status, got %q", pool.Status)
	}
	if pool.VpcID != "vpc-preview" || pool.SubnetID != "subnet-preview" || pool.Zone != "ap-shanghai-5" {
		t.Fatalf("unexpected network config: vpc=%q subnet=%q zone=%q", pool.VpcID, pool.SubnetID, pool.Zone)
	}
	if got := len(pool.SecurityGroups); got != 2 {
		t.Fatalf("expected 2 security groups, got %d", got)
	}

	stored, err := svc.GetPool(ctx, pool.ID)
	if err != nil {
		t.Fatalf("get created pool: %v", err)
	}
	if stored.Name != "pool-sh-preview" {
		t.Fatalf("expected stored pool name, got %q", stored.Name)
	}
}

func TestInternalTemplateClassRoutesLockServedContract(t *testing.T) {
	gin.SetMode(gin.TestMode)

	svc := service.NewService(store.NewMemoryStore())
	router := newHandlerTestRouter(&handler{svc: svc})

	createReq := httptest.NewRequest(http.MethodPost, "/internal/template-classes", bytes.NewBufferString(`{
		"id":"hermes",
		"name":"Hermes",
		"description":"Hermes runtime",
		"workload_type":"bot",
		"region":"ap-singapore",
		"resolution_mode":"sandbox_primary",
		"status":"active"
	}`))
	createReq.Header.Set("Content-Type", "application/json")
	createRR := httptest.NewRecorder()
	router.ServeHTTP(createRR, createReq)
	if createRR.Code != http.StatusCreated {
		t.Fatalf("expected template class create 201, got %d body=%s", createRR.Code, createRR.Body.String())
	}
	var created core.TemplateClass
	if err := json.Unmarshal(createRR.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode template class: %v", err)
	}
	if created.ID != "hermes" || created.Region != "ap-singapore" || created.ResolutionMode != core.ResolutionModeSandboxPrimary {
		t.Fatalf("unexpected template class: %+v", created)
	}

	listReq := httptest.NewRequest(http.MethodGet, "/internal/template-classes", nil)
	listRR := httptest.NewRecorder()
	router.ServeHTTP(listRR, listReq)
	if listRR.Code != http.StatusOK {
		t.Fatalf("expected template class list 200, got %d body=%s", listRR.Code, listRR.Body.String())
	}
	var listed []core.TemplateClass
	if err := json.Unmarshal(listRR.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode template classes: %v", err)
	}
	if len(listed) != 1 || listed[0].ID != "hermes" {
		t.Fatalf("expected listed hermes template class, got %+v", listed)
	}
}

func TestInternalSKURoutesLockServedContract(t *testing.T) {
	gin.SetMode(gin.TestMode)

	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "hermes",
		Name:           "Hermes",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	router := newHandlerTestRouter(&handler{svc: svc})

	createReq := httptest.NewRequest(http.MethodPost, "/internal/skus", bytes.NewBufferString(`{
		"id":"sku-hermes-2c4g",
		"name":"Hermes 2C4G",
		"template_class_id":"hermes",
		"base_image":"img-hermes-stable",
		"desired_image_id":"img-hermes-desired",
		"instance_type":"SA5.MEDIUM4",
		"default_desired_capacity":2
	}`))
	createReq.Header.Set("Content-Type", "application/json")
	createRR := httptest.NewRecorder()
	router.ServeHTTP(createRR, createReq)
	if createRR.Code != http.StatusCreated {
		t.Fatalf("expected sku create 201, got %d body=%s", createRR.Code, createRR.Body.String())
	}
	var created core.SKU
	if err := json.Unmarshal(createRR.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode sku: %v", err)
	}
	if created.ID != "sku-hermes-2c4g" || created.TemplateClassID != "hermes" || created.RolloutState != core.SKURolloutStateStable {
		t.Fatalf("unexpected sku: %+v", created)
	}

	listReq := httptest.NewRequest(http.MethodGet, "/internal/skus", nil)
	listRR := httptest.NewRecorder()
	router.ServeHTTP(listRR, listReq)
	if listRR.Code != http.StatusOK {
		t.Fatalf("expected sku list 200, got %d body=%s", listRR.Code, listRR.Body.String())
	}
	var listed []core.SKU
	if err := json.Unmarshal(listRR.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode skus: %v", err)
	}
	if len(listed) != 1 || listed[0].ID != "sku-hermes-2c4g" {
		t.Fatalf("expected listed sku-hermes-2c4g, got %+v", listed)
	}
}

func TestInternalTemplateBindingReplaceRoutesLockServedContract(t *testing.T) {
	gin.SetMode(gin.TestMode)

	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "hermes",
		Name:           "Hermes",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertSKU(ctx, core.SKU{
		ID:              "sku-hermes-2c4g",
		Name:            "Hermes 2C4G",
		TemplateClassID: "hermes",
		BaseImage:       "img-hermes",
		DesiredImageID:  "img-hermes",
		InstanceType:    "SA5.MEDIUM4",
	}); err != nil {
		t.Fatalf("upsert sku: %v", err)
	}
	pool, err := svc.CreatePool(ctx, "hermes-pool", "", "img-hermes", 0, handlerTestVpcID, handlerTestSubnetID, handlerTestZone, handlerTestSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	router := newHandlerTestRouter(&handler{svc: svc})

	skuReq := httptest.NewRequest(http.MethodPut, "/internal/template-classes/hermes/skus", bytes.NewBufferString(`[
		{"sku_id":"sku-hermes-2c4g","priority":1,"weight":100,"admission_state":"active","rollout_eligibility":true}
	]`))
	skuReq.Header.Set("Content-Type", "application/json")
	skuRR := httptest.NewRecorder()
	router.ServeHTTP(skuRR, skuReq)
	if skuRR.Code != http.StatusOK {
		t.Fatalf("expected sku binding replace 200, got %d body=%s", skuRR.Code, skuRR.Body.String())
	}
	var skuBindings []core.TemplateSkuBinding
	if err := json.Unmarshal(skuRR.Body.Bytes(), &skuBindings); err != nil {
		t.Fatalf("decode sku bindings: %v", err)
	}
	if len(skuBindings) != 1 || skuBindings[0].SKUID != "sku-hermes-2c4g" || skuBindings[0].Weight != 100 {
		t.Fatalf("unexpected sku bindings: %+v", skuBindings)
	}

	poolReq := httptest.NewRequest(http.MethodPut, "/internal/template-classes/hermes/bindings", bytes.NewBufferString(`[
		{"pool_id":"`+pool.ID+`","priority":1,"weight":100,"role":"primary","admission_state":"active"}
	]`))
	poolReq.Header.Set("Content-Type", "application/json")
	poolRR := httptest.NewRecorder()
	router.ServeHTTP(poolRR, poolReq)
	if poolRR.Code != http.StatusOK {
		t.Fatalf("expected pool binding replace 200, got %d body=%s", poolRR.Code, poolRR.Body.String())
	}
	var poolBindings []core.TemplatePoolBinding
	if err := json.Unmarshal(poolRR.Body.Bytes(), &poolBindings); err != nil {
		t.Fatalf("decode pool bindings: %v", err)
	}
	if len(poolBindings) != 1 || poolBindings[0].PoolID != pool.ID || poolBindings[0].Role != core.PoolBindingRolePrimary {
		t.Fatalf("unexpected pool bindings: %+v", poolBindings)
	}
}

func TestPostSandboxTATCommandRunsAgainstSandboxInstance(t *testing.T) {
	gin.SetMode(gin.TestMode)

	svc := service.NewService(store.NewMemoryStore())
	pool, _, sb := createAllocatedSandbox(t, svc)
	authServer := newAuthIntrospectionServer(t)
	defer authServer.Close()
	commands := &stubCommandRunner{
		runResp: provider.CommandInvocation{
			CommandID:    "cmd-1",
			InvocationID: "inv-1",
			InstanceID:   "ins-test-1",
			Region:       "ap-beijing",
			Status:       "PENDING",
		},
	}

	router := newHandlerTestRouterWithAuth(&handler{svc: svc, commands: commands}, authServer.URL)

	req := httptest.NewRequest(http.MethodPost, "/sandboxes/"+sb.ID+"/tat/commands", bytes.NewBufferString(`{"bash":"hostname"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer session-good")
	rr := httptest.NewRecorder()

	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d body=%s", rr.Code, rr.Body.String())
	}
	if commands.runReq.region != "ap-beijing" {
		t.Fatalf("expected region ap-beijing, got %s", commands.runReq.region)
	}
	if commands.runReq.instanceID != "ins-test-1" {
		t.Fatalf("expected instanceID ins-test-1, got %s", commands.runReq.instanceID)
	}
	if commands.runReq.script != "hostname" {
		t.Fatalf("expected script hostname, got %s", commands.runReq.script)
	}

	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got := resp["sandboxID"]; got != sb.ID {
		t.Fatalf("expected sandboxID %s, got %v", sb.ID, got)
	}
	if got := resp["poolID"]; got != pool.ID {
		t.Fatalf("expected poolID %s, got %v", pool.ID, got)
	}
	if got := resp["invocationID"]; got != "inv-1" {
		t.Fatalf("expected invocationID inv-1, got %v", got)
	}
}

func TestPostSandboxTATSessionReturnsTerminalBootstrap(t *testing.T) {
	gin.SetMode(gin.TestMode)

	svc := service.NewService(store.NewMemoryStore())
	pool, _, sb := createAllocatedSandbox(t, svc)
	authServer := newAuthIntrospectionServer(t)
	defer authServer.Close()
	commands := &stubCommandRunner{
		sessionResp: provider.TerminalSession{
			SessionID:      "sess-1",
			Region:         "ap-beijing",
			InstanceID:     "ins-test-1",
			OwnerUin:       "10001",
			LoginUin:       "10002",
			AppID:          12345,
			WsURL:          "wss://ap-beijing.forward.tat-tc.tencent.cn/ws",
			Cols:           120,
			Rows:           32,
			TimeoutSeconds: 3600,
			Username:       "agentuser",
			WorkingDir:     "/home/agentuser",
		},
	}

	router := newHandlerTestRouterWithAuth(&handler{svc: svc, terminals: commands}, authServer.URL)

	req := httptest.NewRequest(http.MethodPost, "/sandboxes/"+sb.ID+"/tat/session", nil)
	req.Header.Set("Authorization", "Bearer session-good")
	rr := httptest.NewRecorder()

	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rr.Code, rr.Body.String())
	}
	if commands.sessionReq.region != "ap-beijing" {
		t.Fatalf("expected region ap-beijing, got %s", commands.sessionReq.region)
	}
	if commands.sessionReq.instanceID != "ins-test-1" {
		t.Fatalf("expected instanceID ins-test-1, got %s", commands.sessionReq.instanceID)
	}

	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got := resp["sandboxID"]; got != sb.ID {
		t.Fatalf("expected sandboxID %s, got %v", sb.ID, got)
	}
	if got := resp["poolID"]; got != pool.ID {
		t.Fatalf("expected poolID %s, got %v", pool.ID, got)
	}
	if got := resp["sessionId"]; got != "sess-1" {
		t.Fatalf("expected sessionId sess-1, got %v", got)
	}
	if got := resp["wsUrl"]; got != "wss://ap-beijing.forward.tat-tc.tencent.cn/ws" {
		t.Fatalf("expected wsUrl, got %v", got)
	}
	if got := resp["timeoutSeconds"]; got != float64(3600) {
		t.Fatalf("expected timeoutSeconds 3600, got %v", got)
	}
	if got := resp["username"]; got != "agentuser" {
		t.Fatalf("expected username agentuser, got %v", got)
	}
	if got := resp["workingDirectory"]; got != "/home/agentuser" {
		t.Fatalf("expected workingDirectory /home/agentuser, got %v", got)
	}
}

func TestPostSandboxTATSessionLogsProviderFailureContext(t *testing.T) {
	gin.SetMode(gin.TestMode)

	var logs bytes.Buffer
	prevLogOutput := log.Writer()
	log.SetOutput(&logs)
	defer log.SetOutput(prevLogOutput)

	svc := service.NewService(store.NewMemoryStore())
	pool, _, sb := createAllocatedSandbox(t, svc)
	authServer := newAuthIntrospectionServer(t)
	defer authServer.Close()
	commands := &stubCommandRunner{
		sessionErr: errors.New("tat start session denied"),
	}

	router := newHandlerTestRouterWithAuth(&handler{svc: svc, terminals: commands}, authServer.URL)

	req := httptest.NewRequest(http.MethodPost, "/sandboxes/"+sb.ID+"/tat/session", nil)
	req.Header.Set("Authorization", "Bearer session-good")
	rr := httptest.NewRecorder()

	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d body=%s", rr.Code, rr.Body.String())
	}
	logText := logs.String()
	for _, want := range []string{
		"[api] tat session start failed",
		"sandbox=" + sb.ID,
		"pool=" + pool.ID,
		"region=ap-beijing",
		"cloud=ins-test-1",
		"err=tat start session denied",
	} {
		if !strings.Contains(logText, want) {
			t.Fatalf("expected log to contain %q, got %s", want, logText)
		}
	}
}

func TestGetSandboxTATCommandResultReturnsInvocationResult(t *testing.T) {
	gin.SetMode(gin.TestMode)

	svc := service.NewService(store.NewMemoryStore())
	pool, _, sb := createAllocatedSandbox(t, svc)
	authServer := newAuthIntrospectionServer(t)
	defer authServer.Close()
	commands := &stubCommandRunner{
		getResp: provider.CommandResult{
			CommandInvocation: provider.CommandInvocation{
				CommandID:    "cmd-1",
				InvocationID: "inv-1",
				InstanceID:   "ins-test-1",
				Region:       "ap-beijing",
				Status:       "SUCCESS",
			},
			ExitCode:  0,
			Output:    "sandbox-probe-bj8\n",
			ErrorInfo: "",
		},
	}

	router := newHandlerTestRouterWithAuth(&handler{svc: svc, commands: commands}, authServer.URL)

	req := httptest.NewRequest(http.MethodGet, "/sandboxes/"+sb.ID+"/tat/commands/inv-1", nil)
	req.Header.Set("Authorization", "Bearer session-good")
	rr := httptest.NewRecorder()

	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rr.Code, rr.Body.String())
	}
	if commands.getReq.region != "ap-beijing" {
		t.Fatalf("expected region ap-beijing, got %s", commands.getReq.region)
	}
	if commands.getReq.instanceID != "ins-test-1" {
		t.Fatalf("expected instanceID ins-test-1, got %s", commands.getReq.instanceID)
	}
	if commands.getReq.invocationID != "inv-1" {
		t.Fatalf("expected invocationID inv-1, got %s", commands.getReq.invocationID)
	}

	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got := resp["poolID"]; got != pool.ID {
		t.Fatalf("expected poolID %s, got %v", pool.ID, got)
	}
	if got := resp["output"]; got != "sandbox-probe-bj8\n" {
		t.Fatalf("expected output, got %v", got)
	}
}

func TestPostSandboxTATSessionRequiresAuthenticatedUser(t *testing.T) {
	gin.SetMode(gin.TestMode)

	svc := service.NewService(store.NewMemoryStore())
	_, _, sb := createAllocatedSandbox(t, svc)
	authServer := newAuthIntrospectionServer(t)
	defer authServer.Close()

	router := newHandlerTestRouterWithAuth(&handler{svc: svc, terminals: &stubCommandRunner{}}, authServer.URL)

	req := httptest.NewRequest(http.MethodPost, "/sandboxes/"+sb.ID+"/tat/session", nil)
	rr := httptest.NewRecorder()

	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d body=%s", rr.Code, rr.Body.String())
	}
}

func TestPostSandboxTATSessionRequiresSandboxRegion(t *testing.T) {
	gin.SetMode(gin.TestMode)

	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	verifyOK := func(context.Context, string) error { return nil }

	pool, err := svc.CreatePool(ctx, "target", "", "img-test", 0, handlerTestVpcID, handlerTestSubnetID, handlerTestZone, handlerTestSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	if _, err := svc.RefillVerified(ctx, pool.ID, 1, []string{"10.0.0.10"}, []string{"ins-test-1"}, verifyOK); err != nil {
		t.Fatalf("refill pool: %v", err)
	}
	inst, err := svc.Allocate(ctx, pool.ID)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	sb, err := svc.CreateSandbox(ctx, core.Sandbox{
		ID:             "sb-test-missing-region",
		InstanceID:     inst.ID,
		PoolID:         pool.ID,
		TimeoutSeconds: 300,
		CreatedAt:      time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("create sandbox: %v", err)
	}

	authServer := newAuthIntrospectionServer(t)
	defer authServer.Close()

	router := newHandlerTestRouterWithAuth(&handler{svc: svc, terminals: &stubCommandRunner{}}, authServer.URL)

	req := httptest.NewRequest(http.MethodPost, "/sandboxes/"+sb.ID+"/tat/session", nil)
	req.Header.Set("Authorization", "Bearer session-good")
	rr := httptest.NewRecorder()

	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d body=%s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "sandbox region missing") {
		t.Fatalf("expected sandbox region missing error, got %s", rr.Body.String())
	}
}

func TestInternalTemplateClassResolveRouteReturnsActivePools(t *testing.T) {
	gin.SetMode(gin.TestMode)

	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	pool, err := svc.CreatePool(ctx, "bound", "", "img-test", 0, handlerTestVpcID, handlerTestSubnetID, handlerTestZone, handlerTestSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		Name:           "OpenClaw Default",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}
	if _, err := svc.UpsertTemplatePoolBinding(ctx, core.TemplatePoolBinding{
		TemplateClassID: "openclaw-default",
		PoolID:          pool.ID,
		Priority:        1,
		AdmissionState:  core.BindingAdmissionStateActive,
	}); err != nil {
		t.Fatalf("upsert template binding: %v", err)
	}

	router := newHandlerTestRouter(&handler{svc: svc})
	req := httptest.NewRequest(http.MethodGet, "/internal/template-classes/openclaw-default/resolve", nil)
	rr := httptest.NewRecorder()

	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rr.Code, rr.Body.String())
	}

	var resp struct {
		TemplateClass core.TemplateClass         `json:"template_class"`
		Bindings      []core.TemplatePoolBinding `json:"bindings"`
		Pools         []core.Pool                `json:"pools"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.TemplateClass.ID != "openclaw-default" {
		t.Fatalf("expected template_class openclaw-default, got %+v", resp.TemplateClass)
	}
	if len(resp.Bindings) != 1 || resp.Bindings[0].PoolID != pool.ID {
		t.Fatalf("expected binding for pool %s, got %+v", pool.ID, resp.Bindings)
	}
	if len(resp.Pools) != 1 || resp.Pools[0].ID != pool.ID {
		t.Fatalf("expected resolved pool %s, got %+v", pool.ID, resp.Pools)
	}
}

// stubPauseProvider is a CloudProvider that records StopInstance / StartInstance
// calls and lets tests script their return values. It satisfies the full
// CloudProvider interface for use as handler.cloud in pause-path tests.
type stubPauseProvider struct {
	stopCalls  int
	stopWith   []string
	stopErr    error
	startCalls int
	startWith  []string
	startErr   error
}

func (p *stubPauseProvider) CreateInstance(context.Context, core.Pool) (string, string, error) {
	return "", "", nil
}
func (p *stubPauseProvider) ReinstallInstance(context.Context, string, string) error {
	return nil
}
func (p *stubPauseProvider) DescribeInstance(context.Context, string) (string, error) {
	return "", nil
}
func (p *stubPauseProvider) TerminateInstance(context.Context, string) error { return nil }
func (p *stubPauseProvider) VerifyInstance(context.Context, string) error    { return nil }
func (p *stubPauseProvider) StopInstance(_ context.Context, cloudID string) error {
	p.stopCalls++
	p.stopWith = append(p.stopWith, cloudID)
	return p.stopErr
}
func (p *stubPauseProvider) StartInstance(_ context.Context, cloudID string) error {
	p.startCalls++
	p.startWith = append(p.startWith, cloudID)
	return p.startErr
}
func (p *stubPauseProvider) CreateInstanceSnapshot(context.Context, provider.CreateInstanceSnapshotRequest) (string, error) {
	return "", errors.New("stubPauseProvider: CreateInstanceSnapshot not configured")
}
func (p *stubPauseProvider) DescribeInstanceSnapshot(context.Context, string) (provider.SnapshotStatus, string, error) {
	return "", "", errors.New("stubPauseProvider: DescribeInstanceSnapshot not configured")
}

func TestPostSandboxesSandboxIDPauseUsesLegacyReleaseWhenCloudPauseResumeDisabled(t *testing.T) {
	gin.SetMode(gin.TestMode)
	svc := service.NewService(store.NewMemoryStore())
	_, inst, sb := createAllocatedSandbox(t, svc)
	cp := &stubPauseProvider{}
	router := newHandlerTestRouter(&handler{svc: svc, cloud: cp})

	req := httptest.NewRequest(http.MethodPost, "/sandboxes/"+sb.ID+"/pause", nil)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", rr.Code, rr.Body.String())
	}
	if cp.stopCalls != 0 {
		t.Fatalf("legacy pause must not call StopInstance, got %d calls", cp.stopCalls)
	}
	got, err := svc.GetInstance(context.Background(), inst.ID)
	if err != nil {
		t.Fatalf("get instance: %v", err)
	}
	if got.State != core.StateDry {
		t.Fatalf("expected legacy pause to release instance to DRY, got %s", got.State)
	}
}

func TestPostSandboxesSandboxIDResumeUsesLegacyNoopWhenCloudPauseResumeDisabled(t *testing.T) {
	gin.SetMode(gin.TestMode)
	svc := service.NewService(store.NewMemoryStore())
	_, inst, sb := createAllocatedSandbox(t, svc)
	if _, err := svc.Release(context.Background(), inst.ID); err != nil {
		t.Fatalf("release to DRY: %v", err)
	}
	cp := &stubPauseProvider{}
	router := newHandlerTestRouter(&handler{svc: svc, cloud: cp})

	req := httptest.NewRequest(http.MethodPost, "/sandboxes/"+sb.ID+"/resume", nil)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rr.Code, rr.Body.String())
	}
	if cp.startCalls != 0 {
		t.Fatalf("legacy resume must not call StartInstance, got %d calls", cp.startCalls)
	}
	got, err := svc.GetInstance(context.Background(), inst.ID)
	if err != nil {
		t.Fatalf("get instance: %v", err)
	}
	if got.State != core.StateDry {
		t.Fatalf("expected legacy resume to leave instance in DRY, got %s", got.State)
	}
}

// TestPostSandboxesSandboxIDPauseHappyPath asserts that the new pause handler
// (Q26-D 修订版 + Q29=E5) drives ALLOCATED → PAUSING → PAUSED via cp.StopInstance,
// instead of the legacy ALLOCATED → DRY release path.
func TestPostSandboxesSandboxIDPauseHappyPath(t *testing.T) {
	gin.SetMode(gin.TestMode)
	svc := service.NewService(store.NewMemoryStore())
	_, inst, sb := createAllocatedSandbox(t, svc)
	cp := &stubPauseProvider{}
	router := newHandlerTestRouter(&handler{svc: svc, cloud: cp, cloudPauseResume: true})

	req := httptest.NewRequest(http.MethodPost, "/sandboxes/"+sb.ID+"/pause", nil)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", rr.Code, rr.Body.String())
	}
	if cp.stopCalls != 1 {
		t.Fatalf("expected exactly 1 StopInstance call, got %d", cp.stopCalls)
	}
	if len(cp.stopWith) != 1 || cp.stopWith[0] != inst.CloudID {
		t.Fatalf("expected StopInstance(%q), got %v", inst.CloudID, cp.stopWith)
	}
	got, err := svc.GetInstance(context.Background(), inst.ID)
	if err != nil {
		t.Fatalf("get instance: %v", err)
	}
	if got.State != core.StatePaused {
		t.Fatalf("expected instance state PAUSED after pause, got %s", got.State)
	}
}

// TestPostSandboxesSandboxIDPauseRollsBackOnStopFailure asserts that when
// cp.StopInstance fails, the handler rolls PAUSING back to ALLOCATED so the
// upstream ctl child-task (Q22-I-D / Q36=a) can retry within the 1h window.
func TestPostSandboxesSandboxIDPauseRollsBackOnStopFailure(t *testing.T) {
	gin.SetMode(gin.TestMode)
	svc := service.NewService(store.NewMemoryStore())
	_, inst, sb := createAllocatedSandbox(t, svc)
	cp := &stubPauseProvider{stopErr: errors.New("cvm StopInstances rate limited")}
	router := newHandlerTestRouter(&handler{svc: svc, cloud: cp, cloudPauseResume: true})

	req := httptest.NewRequest(http.MethodPost, "/sandboxes/"+sb.ID+"/pause", nil)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d body=%s", rr.Code, rr.Body.String())
	}
	got, err := svc.GetInstance(context.Background(), inst.ID)
	if err != nil {
		t.Fatalf("get instance: %v", err)
	}
	if got.State != core.StateAllocated {
		t.Fatalf("expected instance rolled back to ALLOCATED, got %s", got.State)
	}
}

// TestPostSandboxesSandboxIDPauseIdempotent asserts that calling pause a second
// time on an already-paused sandbox returns 204 without invoking cp.StopInstance.
func TestPostSandboxesSandboxIDPauseIdempotent(t *testing.T) {
	gin.SetMode(gin.TestMode)
	svc := service.NewService(store.NewMemoryStore())
	_, inst, sb := createAllocatedSandbox(t, svc)
	cp := &stubPauseProvider{}
	router := newHandlerTestRouter(&handler{svc: svc, cloud: cp, cloudPauseResume: true})

	// First call: ALLOCATED → PAUSED.
	req := httptest.NewRequest(http.MethodPost, "/sandboxes/"+sb.ID+"/pause", nil)
	router.ServeHTTP(httptest.NewRecorder(), req)
	if cp.stopCalls != 1 {
		t.Fatalf("first pause: expected 1 StopInstance, got %d", cp.stopCalls)
	}
	got, _ := svc.GetInstance(context.Background(), inst.ID)
	if got.State != core.StatePaused {
		t.Fatalf("first pause: expected PAUSED, got %s", got.State)
	}

	// Second call must be no-op and 204.
	req2 := httptest.NewRequest(http.MethodPost, "/sandboxes/"+sb.ID+"/pause", nil)
	rr2 := httptest.NewRecorder()
	router.ServeHTTP(rr2, req2)
	if rr2.Code != http.StatusNoContent {
		t.Fatalf("second pause: expected 204, got %d body=%s", rr2.Code, rr2.Body.String())
	}
	if cp.stopCalls != 1 {
		t.Fatalf("second pause: expected no extra StopInstance, got total %d", cp.stopCalls)
	}
}

// createPausedSandbox is a helper that builds a freshly allocated sandbox and
// drives it through the pause path so subsequent resume tests start from
// PAUSED state. It returns the same triple as createAllocatedSandbox plus the
// stub provider used during the pause (so tests may inspect call counts).
func createPausedSandbox(t *testing.T, svc *service.Service) (core.Pool, core.Instance, core.Sandbox) {
	t.Helper()
	pool, inst, sb := createAllocatedSandbox(t, svc)
	cp := &stubPauseProvider{}
	router := newHandlerTestRouter(&handler{svc: svc, cloud: cp, cloudPauseResume: true})
	req := httptest.NewRequest(http.MethodPost, "/sandboxes/"+sb.ID+"/pause", nil)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("pre-pause failed: code=%d body=%s", rr.Code, rr.Body.String())
	}
	got, err := svc.GetInstance(context.Background(), inst.ID)
	if err != nil {
		t.Fatalf("get instance after pause: %v", err)
	}
	if got.State != core.StatePaused {
		t.Fatalf("expected PAUSED after pre-pause, got %s", got.State)
	}
	return pool, got, sb
}

// TestPostSandboxesSandboxIDResumeHappyPath asserts that the new resume handler
// (R-F 2026-05-15) drives PAUSED → RESUMING → ALLOCATED via cp.StartInstance,
// instead of the legacy noop that only returned 201 without touching CVM.
//
// Protocol contract (different from Pause's 204 No Content): resume returns
// 201 Created + Sandbox JSON body, matching ctl/pkg/instance/logic.go's
// resumeSandbox expectation.
func TestPostSandboxesSandboxIDResumeHappyPath(t *testing.T) {
	gin.SetMode(gin.TestMode)
	svc := service.NewService(store.NewMemoryStore())
	_, inst, sb := createPausedSandbox(t, svc)
	cp := &stubPauseProvider{}
	router := newHandlerTestRouter(&handler{svc: svc, cloud: cp, cloudPauseResume: true})

	req := httptest.NewRequest(http.MethodPost, "/sandboxes/"+sb.ID+"/resume", nil)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rr.Code, rr.Body.String())
	}
	if cp.startCalls != 1 {
		t.Fatalf("expected exactly 1 StartInstance call, got %d", cp.startCalls)
	}
	if len(cp.startWith) != 1 || cp.startWith[0] != inst.CloudID {
		t.Fatalf("expected StartInstance(%q), got %v", inst.CloudID, cp.startWith)
	}
	got, err := svc.GetInstance(context.Background(), inst.ID)
	if err != nil {
		t.Fatalf("get instance: %v", err)
	}
	if got.State != core.StateAllocated {
		t.Fatalf("expected instance state ALLOCATED after resume, got %s", got.State)
	}
}

// TestPostSandboxesSandboxIDResumeRollsBackOnStartFailure asserts that when
// cp.StartInstance fails, the handler rolls RESUMING back to PAUSED so the
// upstream ctl child-task (R-D / RenewPassTask) can retry within the 1h window.
func TestPostSandboxesSandboxIDResumeRollsBackOnStartFailure(t *testing.T) {
	gin.SetMode(gin.TestMode)
	svc := service.NewService(store.NewMemoryStore())
	_, inst, sb := createPausedSandbox(t, svc)
	cp := &stubPauseProvider{startErr: errors.New("cvm StartInstances rate limited")}
	router := newHandlerTestRouter(&handler{svc: svc, cloud: cp, cloudPauseResume: true})

	req := httptest.NewRequest(http.MethodPost, "/sandboxes/"+sb.ID+"/resume", nil)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d body=%s", rr.Code, rr.Body.String())
	}
	got, err := svc.GetInstance(context.Background(), inst.ID)
	if err != nil {
		t.Fatalf("get instance: %v", err)
	}
	if got.State != core.StatePaused {
		t.Fatalf("expected instance rolled back to PAUSED, got %s", got.State)
	}
}

// TestPostSandboxesSandboxIDResumeIdempotent asserts that calling resume on an
// already-allocated sandbox returns 201 + body without invoking cp.StartInstance.
// This matches ctl's expectedResumeConflictMessages tolerance for "already running".
func TestPostSandboxesSandboxIDResumeIdempotent(t *testing.T) {
	gin.SetMode(gin.TestMode)
	svc := service.NewService(store.NewMemoryStore())
	_, inst, sb := createPausedSandbox(t, svc)
	cp := &stubPauseProvider{}
	router := newHandlerTestRouter(&handler{svc: svc, cloud: cp, cloudPauseResume: true})

	// First call: PAUSED → ALLOCATED.
	req := httptest.NewRequest(http.MethodPost, "/sandboxes/"+sb.ID+"/resume", nil)
	router.ServeHTTP(httptest.NewRecorder(), req)
	if cp.startCalls != 1 {
		t.Fatalf("first resume: expected 1 StartInstance, got %d", cp.startCalls)
	}
	got, _ := svc.GetInstance(context.Background(), inst.ID)
	if got.State != core.StateAllocated {
		t.Fatalf("first resume: expected ALLOCATED, got %s", got.State)
	}

	// Second call must be no-op and 201.
	req2 := httptest.NewRequest(http.MethodPost, "/sandboxes/"+sb.ID+"/resume", nil)
	rr2 := httptest.NewRecorder()
	router.ServeHTTP(rr2, req2)
	if rr2.Code != http.StatusCreated {
		t.Fatalf("second resume: expected 201, got %d body=%s", rr2.Code, rr2.Body.String())
	}
	if cp.startCalls != 1 {
		t.Fatalf("second resume: expected no extra StartInstance, got total %d", cp.startCalls)
	}
}

// TestPostSandboxesSandboxIDResumeNotPaused asserts that calling resume on a
// sandbox in DRY state (or any non-{PAUSED, RESUMING, ALLOCATED} state) is
// rejected with 409, avoiding accidental cp.StartInstance pollution.
func TestPostSandboxesSandboxIDResumeNotPaused(t *testing.T) {
	gin.SetMode(gin.TestMode)
	svc := service.NewService(store.NewMemoryStore())
	_, inst, sb := createAllocatedSandbox(t, svc)
	// Push the instance to DRY (release path), which is neither PAUSED nor
	// ALLOCATED, so resume must reject with 409.
	if _, err := svc.Release(context.Background(), inst.ID); err != nil {
		t.Fatalf("release to DRY: %v", err)
	}
	got, _ := svc.GetInstance(context.Background(), inst.ID)
	if got.State != core.StateDry {
		t.Fatalf("expected DRY before resume, got %s", got.State)
	}

	cp := &stubPauseProvider{}
	router := newHandlerTestRouter(&handler{svc: svc, cloud: cp, cloudPauseResume: true})
	req := httptest.NewRequest(http.MethodPost, "/sandboxes/"+sb.ID+"/resume", nil)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d body=%s", rr.Code, rr.Body.String())
	}
	if cp.startCalls != 0 {
		t.Fatalf("expected 0 StartInstance calls on conflict, got %d", cp.startCalls)
	}
}

// TestDeleteSandboxesSandboxIDReleasesPausedInstance asserts that deleting a
// sandbox whose underlying instance is in PAUSED (i.e. the trade pass
// destroy-after-isolation path) successfully drives the instance to DRY so the
// reset worker can sweep it back into the CLEAN pool. Prior to the Release
// transition fix, Release would silently fail and leak the instance in PAUSED
// forever (orphans visible in pool-bj8 联调环境验证).
func TestDeleteSandboxesSandboxIDReleasesPausedInstance(t *testing.T) {
	gin.SetMode(gin.TestMode)
	svc := service.NewService(store.NewMemoryStore())
	_, inst, sb := createPausedSandbox(t, svc)

	router := newHandlerTestRouter(&handler{svc: svc})
	req := httptest.NewRequest(http.MethodDelete, "/sandboxes/"+sb.ID, nil)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", rr.Code, rr.Body.String())
	}
	got, err := svc.GetInstance(context.Background(), inst.ID)
	if err != nil {
		t.Fatalf("get instance: %v", err)
	}
	if got.State != core.StateDry {
		t.Fatalf("expected instance state DRY after deleting paused sandbox, got %s", got.State)
	}
	if _, err := svc.GetSandbox(context.Background(), sb.ID); err != core.ErrSandboxNotFound {
		t.Fatalf("expected sandbox row deleted, got err=%v", err)
	}
}
