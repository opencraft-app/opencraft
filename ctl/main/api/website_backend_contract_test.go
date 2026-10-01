package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	websitelogic "ctl/pkg/logic/website"
	websiteModel "ctl/pkg/model/website"
	"ctl/test/testutil"
)

// Exercise the real HTTP decoder, ownership lookup, logic gate and error envelope.
// No pass/operation/release tables or cloud credentials are needed: rejected
// kinds must stop before signing uploads or preparing a deployment.
func TestWebsiteBackendReleaseHTTPContract(t *testing.T) {
	for _, tc := range []struct {
		name, user, kind, code string
		status                 int
	}{
		{"fullstack", "owner", `"fullstack"`, "WEBSITE_BACKEND_UNAVAILABLE", 409},
		{"unknown", "owner", `"python"`, "WEBSITE_INVALID_PARAM", 400},
		{"wrong-type", "owner", `42`, "WEBSITE_INVALID_PARAM", 400},
		{"cross-user", "other", `"fullstack"`, "WEBSITE_NOT_FOUND", 404},
		{"anonymous", "", `"fullstack"`, "UNAUTHORIZED", 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := testutil.NewSQLiteDB(t, &websiteModel.SiteEntity{})
			site := &websiteModel.SiteEntity{SiteID: "ws-contract", Status: websiteModel.SiteStatusActive}
			site.UserID = "owner"
			if err := db.Create(site).Error; err != nil {
				t.Fatal(err)
			}
			h := &websiteHandler{logic: websitelogic.NewLogic()}
			body := `{"kind":` + tc.kind + `,"artifact_hash":"` + strings.Repeat("a", 64) + `","artifact_size":10,"file_count":1}`
			req := httptest.NewRequest(http.MethodPost, "/v1/websites/ws-contract/releases", strings.NewReader(body))
			if tc.user != "" {
				req.Header.Set(headerUserID, tc.user)
			}
			rec := httptest.NewRecorder()
			h.handleWebsitesByID(rec, req)
			var payload struct {
				Code string          `json:"code"`
				Data json.RawMessage `json:"data"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
				t.Fatal(err)
			}
			if rec.Code != tc.status || payload.Code != tc.code {
				t.Errorf("status/code = %d/%s, want %d/%s", rec.Code, payload.Code, tc.status, tc.code)
			}
			if strings.Contains(rec.Body.String(), "upload_url") || strings.Contains(rec.Body.String(), "operation_id") {
				t.Error("rejected request exposed a deployment result")
			}
		})
	}
}

type websiteCapabilityContractLogic struct {
	websitelogic.Logic
	calls int
}

func (l *websiteCapabilityContractLogic) GetCapability(string) (*websitelogic.Capability, error) {
	l.calls++
	return &websitelogic.Capability{MaxSites: 3, MaxFiles: 500}, nil
}

func TestWebsiteCapabilityHTTPIncludesUnavailableFeatures(t *testing.T) {
	l := &websiteCapabilityContractLogic{}
	h := &websiteHandler{logic: l}
	req := httptest.NewRequest(http.MethodGet, "/v1/websites/capability", nil)
	req.Header.Set(headerUserID, "owner")
	rec := httptest.NewRecorder()
	h.handleWebsitesRoot(rec, req)
	if rec.Code != http.StatusOK || l.calls != 1 {
		t.Fatalf("status/calls = %d/%d", rec.Code, l.calls)
	}
	var payload struct {
		Code string                     `json:"code"`
		Data map[string]json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Code != "OK" {
		t.Fatalf("code = %s", payload.Code)
	}
	for _, key := range []string{"backend", "data"} {
		var feature struct {
			Enabled *bool `json:"enabled"`
		}
		if err := json.Unmarshal(payload.Data[key], &feature); err != nil {
			t.Fatal(err)
		}
		if feature.Enabled == nil || *feature.Enabled {
			t.Errorf("%s.enabled must be explicitly false", key)
		}
	}
	if string(payload.Data["max_sites"]) != "3" || string(payload.Data["max_files"]) != "500" {
		t.Error("legacy capability values changed")
	}
}
