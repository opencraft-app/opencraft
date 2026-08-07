package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/service"
	"cvm-mock-e2b/internal/store"
)

const (
	apiTestVpcID    = "vpc-test"
	apiTestSubnetID = "subnet-test"
	apiTestZone     = "ap-beijing-8"
)

var apiTestSecurityGroups = []string{"sg-test"}

func seedAPITestPoolSKU(t *testing.T, svc *service.Service) {
	t.Helper()
	ctx := context.Background()
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
	if _, err := svc.UpsertTemplateSkuBinding(ctx, core.TemplateSkuBinding{
		TemplateClassID:    "hermes",
		SKUID:              "sku-hermes-2c4g",
		AdmissionState:     "active",
		RolloutEligibility: true,
	}); err != nil {
		t.Fatalf("upsert template sku binding: %v", err)
	}
}

func TestPostPoolsUsesBoundSafeCreateContract(t *testing.T) {
	svc := service.NewService(store.NewMemoryStore())
	seedAPITestPoolSKU(t, svc)
	body := bytes.NewBufferString(`{
		"name":"pool-sg-sa2",
		"base_image":"img-hermes",
		"desired_capacity":30,
		"instance_type":"SA2.MEDIUM4",
		"status":"active",
		"sku_id":"sku-hermes-2c4g",
		"vpc_id":"vpc-test",
		"subnet_id":"subnet-test",
		"zone":"ap-singapore-4",
		"security_groups":["sg-test"]
	}`)
	req := httptest.NewRequest(http.MethodPost, "/pools", body)
	rec := httptest.NewRecorder()
	New(svc, nil).Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rec.Code, rec.Body.String())
	}
	var pool core.Pool
	if err := json.Unmarshal(rec.Body.Bytes(), &pool); err != nil {
		t.Fatalf("decode pool: %v", err)
	}
	if pool.SKUID != "sku-hermes-2c4g" || pool.TemplateClassID != "hermes" {
		t.Fatalf("expected sku/class binding, got sku=%q class=%q", pool.SKUID, pool.TemplateClassID)
	}
	if pool.DesiredCap != 0 || pool.Status != core.PoolStatusPaused {
		t.Fatalf("expected safe defaults, got desired=%d status=%q", pool.DesiredCap, pool.Status)
	}
}

func TestPatchPoolsRejectsChangingBoundSKU(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	seedAPITestPoolSKU(t, svc)
	pool, err := svc.CreatePool(ctx, "legacy", "", "img-hermes", 0, apiTestVpcID, apiTestSubnetID, apiTestZone, apiTestSecurityGroups)
	if err != nil {
		t.Fatalf("create legacy pool: %v", err)
	}
	pool.SKUID = "sku-hermes-2c4g"
	pool.TemplateClassID = "hermes"
	if _, err := svc.UpdatePool(ctx, pool); err != nil {
		t.Fatalf("bind pool fixture: %v", err)
	}

	req := httptest.NewRequest(http.MethodPatch, "/pools/"+pool.ID, bytes.NewBufferString(`{"sku_id":"other-sku"}`))
	rec := httptest.NewRecorder()
	New(svc, nil).Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestPatchPoolUpdatesStatusAndInstanceType(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	pool, err := svc.CreatePool(ctx, "patch-me", "", "img-test", 3, apiTestVpcID, apiTestSubnetID, apiTestZone, apiTestSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}

	body, err := json.Marshal(map[string]any{
		"status":        core.PoolStatusPaused,
		"pause_reason":  "terminal create error",
		"instance_type": "S5.MEDIUM4",
	})
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}

	req := httptest.NewRequest(http.MethodPatch, "/pools/"+pool.ID, bytes.NewReader(body))
	rec := httptest.NewRecorder()
	New(svc, nil).Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	got, err := svc.GetPool(ctx, pool.ID)
	if err != nil {
		t.Fatalf("get pool: %v", err)
	}
	if got.Status != core.PoolStatusPaused {
		t.Fatalf("expected paused status, got %q", got.Status)
	}
	if got.InstanceType != "S5.MEDIUM4" {
		t.Fatalf("expected instance_type updated, got %q", got.InstanceType)
	}
	if got.PauseReason != "terminal create error" {
		t.Fatalf("expected pause reason updated, got %q", got.PauseReason)
	}
}

func TestPatchPoolBaseImageCanMarkCleanInventoryDry(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	pool, err := svc.CreatePool(ctx, "switch-image", "", "img-old", 2, apiTestVpcID, apiTestSubnetID, apiTestZone, apiTestSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	insts, err := svc.RefillVerified(ctx, pool.ID, 2, []string{"10.0.0.10", "10.0.0.11"}, []string{"ins-1", "ins-2"}, func(context.Context, string) error {
		return nil
	})
	if err != nil {
		t.Fatalf("refill verified: %v", err)
	}
	allocated, err := svc.Allocate(ctx, pool.ID)
	if err != nil {
		t.Fatalf("allocate instance: %v", err)
	}

	body, err := json.Marshal(map[string]any{
		"base_image":        "img-new",
		"mark_clean_as_dry": true,
	})
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}

	req := httptest.NewRequest(http.MethodPatch, "/pools/"+pool.ID, bytes.NewReader(body))
	rec := httptest.NewRecorder()
	New(svc, nil).Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
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

func TestPatchPoolInstanceTypeCanMarkCleanInventoryDry(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	pool, err := svc.CreatePool(ctx, "switch-type", "", "img-old", 2, apiTestVpcID, apiTestSubnetID, apiTestZone, apiTestSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	insts, err := svc.RefillVerified(ctx, pool.ID, 2, []string{"10.0.0.10", "10.0.0.11"}, []string{"ins-1", "ins-2"}, func(context.Context, string) error {
		return nil
	})
	if err != nil {
		t.Fatalf("refill verified: %v", err)
	}
	allocated, err := svc.Allocate(ctx, pool.ID)
	if err != nil {
		t.Fatalf("allocate instance: %v", err)
	}

	body, err := json.Marshal(map[string]any{
		"instance_type":     "SA5.MEDIUM4",
		"mark_clean_as_dry": true,
	})
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}

	req := httptest.NewRequest(http.MethodPatch, "/pools/"+pool.ID, bytes.NewReader(body))
	rec := httptest.NewRecorder()
	New(svc, nil).Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
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

func TestTemplateClassRoutesPersistAndResolveBindings(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())

	pool, err := svc.CreatePool(ctx, "resolve-me", "", "img-test", 1, apiTestVpcID, apiTestSubnetID, apiTestZone, apiTestSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}

	templateClassBody, err := json.Marshal(core.TemplateClass{
		ID:             "openclaw-default",
		Name:           "OpenClaw Default",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	})
	if err != nil {
		t.Fatalf("marshal template class: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/template-classes", bytes.NewReader(templateClassBody))
	rec := httptest.NewRecorder()
	New(svc, nil).Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rec.Code, rec.Body.String())
	}

	bindingBody, err := json.Marshal([]core.TemplatePoolBinding{{
		PoolID:         pool.ID,
		Priority:       1,
		AdmissionState: core.BindingAdmissionStateActive,
	}})
	if err != nil {
		t.Fatalf("marshal bindings: %v", err)
	}
	req = httptest.NewRequest(http.MethodPut, "/template-classes/openclaw-default/bindings", bytes.NewReader(bindingBody))
	rec = httptest.NewRecorder()
	New(svc, nil).Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/template-classes/openclaw-default/resolve", nil)
	rec = httptest.NewRecorder()
	New(svc, nil).Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	var resp struct {
		Pools []core.Pool `json:"pools"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode resolve response: %v", err)
	}
	if len(resp.Pools) != 1 || resp.Pools[0].ID != pool.ID {
		t.Fatalf("expected resolved pool %s, got %+v", pool.ID, resp.Pools)
	}
}

func TestSKURoutesPersistAndResolveTemplateClassBindings(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())

	templateClassBody, err := json.Marshal(core.TemplateClass{
		ID:             "openclaw-default",
		Name:           "OpenClaw Default",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	})
	if err != nil {
		t.Fatalf("marshal template class: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/template-classes", bytes.NewReader(templateClassBody))
	rec := httptest.NewRecorder()
	New(svc, nil).Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rec.Code, rec.Body.String())
	}

	skuBody, err := json.Marshal(core.SKU{
		ID:              "sku-default",
		Name:            "Default SKU",
		TemplateClassID: "openclaw-default",
		BaseImage:       "img-base",
		DesiredImageID:  "img-base",
		StableImageID:   "img-base",
		InstanceType:    "SA9.MEDIUM2",
		RolloutState:    core.SKURolloutStateStable,
	})
	if err != nil {
		t.Fatalf("marshal sku: %v", err)
	}
	req = httptest.NewRequest(http.MethodPost, "/skus", bytes.NewReader(skuBody))
	rec = httptest.NewRecorder()
	New(svc, nil).Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rec.Code, rec.Body.String())
	}

	pool, err := svc.CreatePool(ctx, "sku-pool", "", "img-base", 1, apiTestVpcID, apiTestSubnetID, apiTestZone, apiTestSecurityGroups)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	pool.SKUID = "sku-default"
	if _, err := svc.UpdatePool(ctx, pool); err != nil {
		t.Fatalf("update pool sku id: %v", err)
	}

	bindingBody, err := json.Marshal([]core.TemplateSkuBinding{{
		SKUID:              "sku-default",
		Priority:           1,
		Weight:             1,
		AdmissionState:     "active",
		RolloutEligibility: true,
	}})
	if err != nil {
		t.Fatalf("marshal sku bindings: %v", err)
	}
	req = httptest.NewRequest(http.MethodPut, "/template-classes/openclaw-default/skus", bytes.NewReader(bindingBody))
	rec = httptest.NewRecorder()
	New(svc, nil).Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/template-classes/openclaw-default/resolve", nil)
	rec = httptest.NewRecorder()
	New(svc, nil).Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Pools []core.Pool `json:"pools"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode resolve response: %v", err)
	}
	if len(resp.Pools) != 1 || resp.Pools[0].SKUID != "sku-default" {
		t.Fatalf("expected pool resolved from sku binding, got %+v", resp.Pools)
	}
}

func TestCapacityBundleRoutesPersistBundle(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	_ = ctx

	body, err := json.Marshal(core.CapacityBundle{
		ID:               "bundle-1",
		Region:           "ap-beijing",
		Zone:             apiTestZone,
		VpcID:            apiTestVpcID,
		SubnetID:         apiTestSubnetID,
		SecurityGroupIDs: apiTestSecurityGroups,
		Status:           core.CapacityBundleStatusWarm,
	})
	if err != nil {
		t.Fatalf("marshal bundle: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/capacity-bundles", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	New(svc, nil).Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/capacity-bundles", nil)
	rec = httptest.NewRecorder()
	New(svc, nil).Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	var bundles []core.CapacityBundle
	if err := json.Unmarshal(rec.Body.Bytes(), &bundles); err != nil {
		t.Fatalf("decode bundles response: %v", err)
	}
	if len(bundles) != 1 || bundles[0].ID != "bundle-1" {
		t.Fatalf("expected bundle-1, got %+v", bundles)
	}
}

func TestTemplateClassBindingsRouteReturnsNotFoundForUnknownClass(t *testing.T) {
	svc := service.NewService(store.NewMemoryStore())

	req := httptest.NewRequest(http.MethodGet, "/template-classes/missing/bindings", nil)
	rec := httptest.NewRecorder()
	New(svc, nil).Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestTemplateClassPolicyRouteReturnsBadRequestForInvalidInput(t *testing.T) {
	ctx := context.Background()
	svc := service.NewService(store.NewMemoryStore())
	if _, err := svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             "openclaw-default",
		Name:           "OpenClaw Default",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
	}); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}

	req := httptest.NewRequest(http.MethodPut, "/template-classes/openclaw-default/autoscale-policy", bytes.NewBufferString(`{"template_class_id":""}`))
	rec := httptest.NewRecorder()
	New(svc, nil).Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 because path-scoped template class id is authoritative, got %d body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/template-classes", bytes.NewBufferString(`{"resolution_mode":"broken"}`))
	rec = httptest.NewRecorder()
	New(svc, nil).Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}
}
