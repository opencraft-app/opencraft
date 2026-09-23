package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParseDianshiRecordFilterAllowsEmptyFilter(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/admin/api/ctl/dianshi/orders", nil)

	filter, err := parseDianshiRecordFilter(req)
	if err != nil {
		t.Fatalf("parseDianshiRecordFilter empty query: %v", err)
	}
	if filter.ExternalUserID != "" || filter.Uin != "" || filter.ActivityID != 0 ||
		filter.BundleID != "" || filter.DealName != "" || filter.Limit != 0 {
		t.Fatalf("unexpected filter: %+v", filter)
	}
}

func TestParseDianshiRecordFilterScene(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/admin/api/ctl/dianshi/orders?scene=renew", nil)
	filter, err := parseDianshiRecordFilter(req)
	if err != nil {
		t.Fatalf("parse scene: %v", err)
	}
	if filter.Scene != "renew" {
		t.Fatalf("scene=%q want renew", filter.Scene)
	}

	badReq := httptest.NewRequest(http.MethodGet, "/admin/api/ctl/dianshi/orders?scene=refund", nil)
	if _, err := parseDianshiRecordFilter(badReq); err == nil {
		t.Fatal("expected invalid scene error")
	}
}
