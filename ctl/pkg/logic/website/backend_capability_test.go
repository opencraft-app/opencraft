package website

import (
	"encoding/json"
	"errors"
	"testing"

	"ctl/pkg/errcode"
	quotaModel "ctl/pkg/model/userresourcequota"
	websiteModel "ctl/pkg/model/website"
	"ctl/pkg/resource"
)

func TestBackendCapabilityIsExplicitlyUnavailable(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedPassAndBundle(t, "user-1", "bundle-1", testQuotaJSON)
	cap, err := NewLogic().GetCapability("user-1")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(cap)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"backend", "data"} {
		var feature struct {
			Enabled *bool `json:"enabled"`
		}
		if err := json.Unmarshal(payload[name], &feature); err != nil {
			t.Errorf("%s capability missing or invalid: %v", name, err)
			continue
		}
		if feature.Enabled == nil || *feature.Enabled {
			t.Errorf("%s.enabled must explicitly be false", name)
		}
	}
	for _, name := range []string{"max_sites", "used_sites", "monthly_traffic_bytes", "used_traffic_bytes", "storage_bytes", "used_storage_bytes", "max_artifact_size", "max_files"} {
		if _, ok := payload[name]; !ok {
			t.Errorf("lost legacy capability %s", name)
		}
	}
}

func releaseRequestWithKind(t *testing.T, kind string) CreateReleaseRequest {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"kind": kind, "artifact_hash": validSHA256, "artifact_size": 10, "file_count": 1})
	if err != nil {
		t.Fatal(err)
	}
	var req CreateReleaseRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		t.Fatal(err)
	}
	return req
}

func TestBackendReleaseKindsFailBeforeSideEffects(t *testing.T) {
	for _, tc := range []struct {
		kind, code string
		status     int
	}{
		{"fullstack", "WEBSITE_BACKEND_UNAVAILABLE", 409},
		{"backend", "WEBSITE_INVALID_PARAM", 400},
		{"STATIC", "WEBSITE_INVALID_PARAM", 400},
		{" static ", "WEBSITE_INVALID_PARAM", 400},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			l := setupCreateReleaseTest(t, 1000)
			result, err := l.CreateRelease("user-1", "ws-a", releaseRequestWithKind(t, tc.kind))
			var businessErr *errcode.Error
			if !errors.As(err, &businessErr) || businessErr.Code != tc.code || businessErr.HTTPStatus != tc.status {
				t.Errorf("error = %v, want %s/%d", err, tc.code, tc.status)
			}
			if result != nil {
				t.Error("rejected request returned a release/upload result")
			}
			for _, table := range []string{websiteModel.ReleasesTable, websiteModel.OperationsTable} {
				var count int64
				if err := resource.GormDB.Table(table).Count(&count).Error; err != nil {
					t.Fatal(err)
				}
				if count != 0 {
					t.Errorf("rejected request persisted %d rows in %s", count, table)
				}
			}
			var quota quotaModel.Entity
			if err := resource.GormDB.Table(quotaModel.TableName).Where("user_id = ?", "user-1").First(&quota).Error; err != nil {
				t.Fatal(err)
			}
			if quota.ResourceQuotaAvailable != 2 || quota.ResourceQuotaTotal != 3 {
				t.Error("rejected release changed quota")
			}
			site, err := l.siteDao.GetBySiteID("ws-a")
			if err != nil {
				t.Fatal(err)
			}
			if site.Status != websiteModel.SiteStatusActive || site.OperationGeneration != 1 {
				t.Errorf("rejected request changed site: status=%s generation=%d", site.Status, site.OperationGeneration)
			}
		})
	}
}

func TestBackendReleaseGatePreservesOwnership(t *testing.T) {
	l := setupCreateReleaseTest(t, 1000)
	for _, siteID := range []string{"ws-a", "ws-missing"} {
		result, err := l.CreateRelease("other-user", siteID, releaseRequestWithKind(t, "fullstack"))
		if result != nil || !errors.Is(err, errcode.ErrWebsiteNotFound) {
			t.Errorf("site %s: result must be nil and error not found, got %v", siteID, err)
		}
	}
}

func TestBackendReleaseGatePreservesStaticPublishing(t *testing.T) {
	for _, kind := range []string{"", "static"} {
		t.Run("kind="+kind, func(t *testing.T) {
			l := setupCreateReleaseTest(t, 1000)
			req := validReleaseRequest(10)
			if kind != "" {
				req = releaseRequestWithKind(t, kind)
			}
			result, err := l.CreateRelease("user-1", "ws-a", req)
			if err != nil {
				t.Fatal(err)
			}
			if result == nil || result.ReleaseID == "" || result.OperationID == "" || result.UploadURL == "" {
				t.Fatal("static publish did not produce a complete release result")
			}
		})
	}
}

func TestBackendReleaseGatePrecedesUploadSigning(t *testing.T) {
	l := setupCreateReleaseTest(t, 1000)
	for _, name := range []string{"WEBSITE_COS_BUCKET", "WEBSITE_COS_REGION", "WEBSITE_COS_SECRET_ID", "WEBSITE_COS_SECRET_KEY", "TENCENT_SECRET_ID", "TENCENT_SECRET_KEY"} {
		t.Setenv(name, "")
	}
	_, err := l.CreateRelease("user-1", "ws-a", releaseRequestWithKind(t, "fullstack"))
	if !errors.Is(err, errcode.ErrWebsiteBackendUnavailable) {
		t.Fatalf("error = %v, want backend unavailable before signing", err)
	}
}

func TestBackendReleaseGatePreservesSiteStateGuards(t *testing.T) {
	for _, status := range []string{websiteModel.SiteStatusSuspended, websiteModel.SiteStatusBlocked, websiteModel.SiteStatusDeleting} {
		t.Run(status, func(t *testing.T) {
			l := setupCreateReleaseTest(t, 1000)
			if err := resource.GormDB.Table(websiteModel.SitesTable).Where("site_id = ?", "ws-a").Update("status", status).Error; err != nil {
				t.Fatal(err)
			}
			_, err := l.CreateRelease("user-1", "ws-a", releaseRequestWithKind(t, "fullstack"))
			if !errors.Is(err, errcode.ErrWebsiteNotActive) {
				t.Fatalf("error = %v, want site not active", err)
			}
		})
	}
}

func TestBackendDataCapabilityRequiresIndependentGateAndBackendConfiguration(t *testing.T) {
	for _, tc := range []struct {
		name, dataGate, backendGate, baseURL, token, userID string
		want                                                bool
	}{
		{"data default closed", "", "1", "http://runtime.internal", "fixture-deploy-token", "user-1", false},
		{"explicit open", "1", "1", "http://runtime.internal", "fixture-deploy-token", "user-1", true},
		{"another authenticated user open", "1", "1", "http://runtime.internal", "fixture-deploy-token", "user-2", true},
		{"unknown data flag closed", "true", "1", "http://runtime.internal", "fixture-deploy-token", "user-1", false},
		{"backend default closed", "1", "", "http://runtime.internal", "fixture-deploy-token", "user-1", false},
		{"backend disabled", "1", "0", "http://runtime.internal", "fixture-deploy-token", "user-1", false},
		{"unknown backend flag closed", "1", "true", "http://runtime.internal", "fixture-deploy-token", "user-1", false},
		{"empty user closed", "1", "1", "http://runtime.internal", "fixture-deploy-token", "", false},
		{"missing runtime closed", "1", "1", "", "fixture-deploy-token", "user-1", false},
		{"missing token closed", "1", "1", "http://runtime.internal", "", "user-1", false},
		{"invalid URL closed", "1", "1", "http://runtime.internal/unexpected", "fixture-deploy-token", "user-1", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("WEBSITE_BACKEND_DATA_ENABLED", tc.dataGate)
			t.Setenv("WEBSITE_BACKEND_ENABLED", tc.backendGate)
			t.Setenv("WEBSITE_BACKEND_BETA_USERS", "different-legacy-owner")
			t.Setenv("WEBSITE_RUNTIME_BASE_URL", tc.baseURL)
			t.Setenv("WEBSITE_RUNTIME_DEPLOY_TOKEN", tc.token)
			if got := backendDataEnabledFor(tc.userID); got != tc.want {
				t.Fatalf("data gate = %v, want %v", got, tc.want)
			}
		})
	}
}
