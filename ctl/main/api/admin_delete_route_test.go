package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	passlogic "ctl/pkg/logic/pass"
)

type adminDeletePassLogic struct {
	passlogic.Logic

	called bool
	userID string
	passID string
}

func (l *adminDeletePassLogic) DeletePass(userID, passID string) (*passlogic.PassDetail, error) {
	l.called = true
	l.userID = userID
	l.passID = passID
	return &passlogic.PassDetail{PassID: passID, UserID: userID}, nil
}

func TestAdminDeletePass_RouteCallsSharedDeleteLogic(t *testing.T) {
	logic := &adminDeletePassLogic{}
	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{logic: logic})

	req := httptest.NewRequest(http.MethodPost,
		"/admin/api/ctl/passes/lhpass-delete-1/delete",
		strings.NewReader(`{"user_id":"usr-delete-1"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("got %d want 200; body=%s", rec.Code, rec.Body.String())
	}
	if !logic.called {
		t.Fatalf("DeletePass was not called")
	}
	if logic.userID != "usr-delete-1" || logic.passID != "lhpass-delete-1" {
		t.Fatalf("DeletePass called with userID=%q passID=%q", logic.userID, logic.passID)
	}

	var payload struct {
		Data struct {
			Deleted bool `json:"deleted"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v; body=%s", err, rec.Body.String())
	}
	if !payload.Data.Deleted {
		t.Fatalf("expected deleted=true; body=%s", rec.Body.String())
	}
}
