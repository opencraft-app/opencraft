package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono/referral/internal/ctlclient"
	"git.woa.com/wisp/mono/referral/internal/domain"
	"git.woa.com/wisp/mono/referral/internal/service"
)

type httpAdminStore struct {
	preview *domain.AttributionResetPreview
}

func (s *httpAdminStore) AttributionResetPreview(context.Context, string, string) (*domain.AttributionResetPreview, error) {
	return s.preview, nil
}
func (s *httpAdminStore) AttributionResetResult(context.Context, string) (*domain.AttributionResetResult, error) {
	return nil, nil
}
func (s *httpAdminStore) CompleteAttributionReset(_ context.Context, preview domain.AttributionResetPreview, key, _, _ string, now time.Time) (*domain.AttributionResetResult, error) {
	return &domain.AttributionResetResult{OperationID: "rrst_1", IdempotencyKey: key, InviteeUserID: preview.Attribution.InviteeUserID, AttributionID: preview.Attribution.ID, RewardsRemoved: len(preview.Rewards), CompletedAt: now}, nil
}

type httpCreditRevoker struct{}

func (httpCreditRevoker) Revoke(context.Context, ctlclient.RevokeRequest) error { return nil }

func TestDisabledReferralRoutesAreHidden(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/referrals/codes/ABC234", nil)
	rec := httptest.NewRecorder()
	NewRouter(false, nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d, want 404", rec.Code)
	}
}

func TestAuthenticatedRouteRejectsMissingGatewayIdentity(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/referrals/me/stats", nil)
	rec := httptest.NewRecorder()
	NewRouter(true, nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d, want 401", rec.Code)
	}
}

func TestAdminAttributionPreviewAndReset(t *testing.T) {
	adminStore := &httpAdminStore{preview: &domain.AttributionResetPreview{
		Attribution: domain.Attribution{ID: "rattr_1", CampaignID: "campaign", InviteeUserID: "invitee", InviterUserID: "inviter", ReferralCode: "CODE234"},
		Rewards:     []domain.AttributionReward{{ID: "reward_1", Status: domain.RewardStatusCancelled}},
	}}
	svc := service.NewWithAdmin(nil, adminStore, httpCreditRevoker{}, "https://lightvela.com")
	router := NewRouter(true, svc)

	previewReq := httptest.NewRequest(http.MethodGet, "/admin/api/referral/attributions/invitee", nil)
	previewRec := httptest.NewRecorder()
	router.ServeHTTP(previewRec, previewReq)
	if previewRec.Code != http.StatusOK || !strings.Contains(previewRec.Body.String(), `"attribution_id":"rattr_1"`) {
		t.Fatalf("preview status=%d body=%s", previewRec.Code, previewRec.Body.String())
	}

	body, _ := json.Marshal(resetAttributionRequest{
		ExpectedAttributionID: "rattr_1", IdempotencyKey: "ops-1", Operator: "operator", Reason: "wrong attribution",
	})
	resetReq := httptest.NewRequest(http.MethodPost, "/admin/api/referral/attributions/invitee/reset", strings.NewReader(string(body)))
	resetRec := httptest.NewRecorder()
	router.ServeHTTP(resetRec, resetReq)
	if resetRec.Code != http.StatusOK || !strings.Contains(resetRec.Body.String(), `"operation_id":"rrst_1"`) {
		t.Fatalf("reset status=%d body=%s", resetRec.Code, resetRec.Body.String())
	}
}
