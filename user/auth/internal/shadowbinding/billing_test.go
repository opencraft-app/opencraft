package shadowbinding

import (
	"context"
	"encoding/json"
	"testing"
)

func TestBillingAccountRequestEnablesAutoOpenForShadowUin(t *testing.T) {
	req, err := newBillingAccountRequest(context.Background(), 450860000002)
	if err != nil {
		t.Fatalf("build billing account request: %v", err)
	}
	if req.GetService() != "billing" || req.GetVersion() != "2018-07-09" || req.GetAction() != "DescribeBillingAccountInner" {
		t.Fatalf("unexpected billing API: service=%q version=%q action=%q", req.GetService(), req.GetVersion(), req.GetAction())
	}
	body, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal billing request: %v", err)
	}
	var params map[string]any
	if err := json.Unmarshal(body, &params); err != nil {
		t.Fatalf("decode billing request: %v", err)
	}
	if params["IsAutoOpenAccount"] != float64(1) || params["QueryUin"] != "450860000002" {
		t.Fatalf("unexpected billing request parameters: %+v", params)
	}
}

func TestBillingAccountRequestRejectsMissingShadowUin(t *testing.T) {
	if _, err := newBillingAccountRequest(context.Background(), 0); err == nil {
		t.Fatal("expected missing shadow UIN to be rejected")
	}
}
