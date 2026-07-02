package internalapi

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestParseDianshiRecordFilterAllowsEmptyFilter(t *testing.T) {
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodGet, "/internal/trade/dianshi/orders", nil)

	filter, ok := parseDianshiRecordFilter(c)
	if !ok {
		t.Fatalf("parseDianshiRecordFilter empty query returned ok=false, status=%d body=%s", rec.Code, rec.Body.String())
	}
	if filter.ExternalUserID != "" || filter.Uin != "" || filter.ActivityID != 0 ||
		filter.BundleID != "" || filter.DealName != "" || filter.Limit != 0 {
		t.Fatalf("unexpected filter: %+v", filter)
	}
}
