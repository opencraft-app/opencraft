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
