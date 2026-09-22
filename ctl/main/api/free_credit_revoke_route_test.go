package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	passlogic "ctl/pkg/logic/pass"
	"ctl/pkg/transport"
)

type recordingFreeCreditRevokeLogic struct {
	passlogic.Logic
	req *transport.RevokeFreeCreditRequest
}

func (l *recordingFreeCreditRevokeLogic) RevokeFreeCredit(req *transport.RevokeFreeCreditRequest) (*transport.RevokeFreeCreditResponse, error) {
	l.req = req
	return &transport.RevokeFreeCreditResponse{UserID: req.UserID, RevokedSubscriptionNames: req.SubscriptionNames}, nil
}

func TestInternalFreeCreditRevokeRequiresBearerAndForwardsExactNames(t *testing.T) {
	t.Setenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "internal-token")
	logic := &recordingFreeCreditRevokeLogic{}
	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{logic: logic})
	body := `{"user_id":"usr-1","subscription_names":["free-credit:referral:reward-1"]}`

	unauthorized := httptest.NewRequest(http.MethodPost, "/internal/ctl/passes/free-credit/revoke", strings.NewReader(body))
	unauthorizedRec := httptest.NewRecorder()
	router.ServeHTTP(unauthorizedRec, unauthorized)
	if unauthorizedRec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status=%d body=%s", unauthorizedRec.Code, unauthorizedRec.Body.String())
	}

	authorized := httptest.NewRequest(http.MethodPost, "/internal/ctl/passes/free-credit/revoke", strings.NewReader(body))
	authorized.Header.Set("Authorization", "Bearer internal-token")
	authorized.Header.Set("Content-Type", "application/json")
	authorizedRec := httptest.NewRecorder()
	router.ServeHTTP(authorizedRec, authorized)
	if authorizedRec.Code != http.StatusOK || logic.req == nil || logic.req.UserID != "usr-1" || len(logic.req.SubscriptionNames) != 1 {
		t.Fatalf("status=%d body=%s req=%+v", authorizedRec.Code, authorizedRec.Body.String(), logic.req)
	}
}
