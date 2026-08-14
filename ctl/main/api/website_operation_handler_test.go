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

type fakeGetWebsiteOperationLogic struct {
	websitelogic.Logic
	op *website.OperationEntity
}

func (f *fakeGetWebsiteOperationLogic) GetOperation(_, _ string) (*website.OperationEntity, error) {
	return f.op, nil
}

func TestWebsiteOperationEndpointReturnsMinimalSnakeCaseDTO(t *testing.T) {
	leaseExpiry := time.Now().UTC().Add(time.Hour)
	h := &websiteHandler{logic: &fakeGetWebsiteOperationLogic{op: &website.OperationEntity{
		OperationID:    "wo-1",
		SiteID:         "ws-1",
		ReleaseID:      "wr-1",
		OperationType:  website.OpTypeDelete,
		Status:         website.OpStatusRunning,
		ErrorMessage:   "",
		LeaseToken:     "must-not-leak",
		LeaseExpiresAt: &leaseExpiry,
		Attempt:        2,
	}}}
	req := httptest.NewRequest(http.MethodGet, "/v1/websites/ws-1/operations/wo-1", nil)
	req.Header.Set(headerUserID, "user-1")
	rec := httptest.NewRecorder()

	h.handleGetOperation(rec, req, "wo-1")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(payload.Data) != 3 {
		t.Fatalf("data keys = %#v, want only operation_id/status/error_message", payload.Data)
	}
	if payload.Data["operation_id"] != "wo-1" || payload.Data["status"] != website.OpStatusRunning || payload.Data["error_message"] != "" {
		t.Fatalf("data = %#v", payload.Data)
	}
	for _, forbidden := range []string{"OperationID", "Status", "ErrorMessage", "LeaseToken", "lease_token", "site_id", "release_id"} {
		if _, exists := payload.Data[forbidden]; exists {
			t.Fatalf("response leaked %q: %#v", forbidden, payload.Data)
		}
	}
}
