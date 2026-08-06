package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ctl/pkg/errcode"
)

// 参数校验的原因必须真正出现在响应体里。
// errcode.Wrap 的原因串会被 writeHTTPError 丢弃，只剩通用的
// "invalid website parameters"，调用方看不出到底缺了什么。
func TestInvalidWebsiteParamCarriesReasonIntoResponse(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/websites", nil)

	writeHTTPError(rec, req, invalidWebsiteParam("bundle_id is required"))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got status %d, want 400", rec.Code)
	}
	var resp struct {
		Code    string            `json:"code"`
		Details map[string]string `json:"details"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Code != "WEBSITE_INVALID_PARAM" {
		t.Fatalf("error code = %q, want WEBSITE_INVALID_PARAM", resp.Code)
	}
	if !strings.Contains(resp.Details["reason"], "bundle_id is required") {
		t.Fatalf("response must carry the reason, got %s", rec.Body.String())
	}
}

// 错误码语义不能变：调用方按 WEBSITE_INVALID_PARAM 判断的逻辑必须继续成立。
func TestInvalidWebsiteParamUnwrapsToWebsiteInvalidParam(t *testing.T) {
	err := invalidWebsiteParam("name is required")
	if !errors.Is(err, errcode.ErrWebsiteInvalidParam) {
		t.Fatalf("must unwrap to ErrWebsiteInvalidParam, got %v", err)
	}
}
