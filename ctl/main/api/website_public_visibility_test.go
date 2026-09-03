package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	websitelogic "ctl/pkg/logic/website"
	"ctl/pkg/model/website"
)

type fakePublicWebsiteLogic struct {
	websitelogic.Logic
	site *website.SiteEntity
}

func (f *fakePublicWebsiteLogic) GetSite(_, _ string) (*website.SiteEntity, error) {
	return f.site, nil
}

func TestPublicGetSiteDoesNotExposeUserID(t *testing.T) {
	expiresAt := time.Date(2026, 8, 28, 3, 0, 0, 0, time.UTC)
	site := &website.SiteEntity{
		SiteID:         "ws-1",
		Status:         website.SiteStatusActive,
		CloudPath:      "sites/ws-1/releases/wr-1/",
		PublicURL:      "https://ws-1.example.test/",
		AccessMode:     website.SiteAccessModeShareCode,
		ShareExpiresAt: &expiresAt,
	}
	site.UserID = "user-1"

	h := &websiteHandler{logic: &fakePublicWebsiteLogic{site: site}}
	req := httptest.NewRequest(http.MethodGet, "/v1/websites/ws-1", nil)
	req.Header.Set(headerUserID, "user-1")
	rec := httptest.NewRecorder()

	h.handleGetSite(rec, req, "ws-1")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if _, exists := payload.Data["user_id"]; exists {
		t.Fatalf("public site response must not expose user_id: %#v", payload.Data)
	}
	if _, exists := payload.Data["ShareGeneration"]; exists {
		t.Fatalf("public site response must not expose share generation: %#v", payload.Data)
	}
	if _, exists := payload.Data["share_generation"]; exists {
		t.Fatalf("public site response must not expose share generation: %#v", payload.Data)
	}
}
