package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ctl/pkg/errcode"
	websitelogic "ctl/pkg/logic/website"
	"ctl/pkg/model/website"
)

// fakeReviveLogic 只实现测试用到的方法，其余接口方法由嵌入的 nil 接口占位。
// 一旦被意外调用会 panic，这正好暴露路由把请求分发错了。
type fakeReviveLogic struct {
	websitelogic.Logic
	calledWith string
	op         *website.OperationEntity
	err        error
}

func (f *fakeReviveLogic) ReviveOperation(operationID string) (*website.OperationEntity, error) {
	f.calledWith = operationID
	return f.op, f.err
}

func newReviveRequest(t *testing.T, method, path, token string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(""))
	if token != "" {
		req.Header.Set("X-Internal-Token", token)
	}
	return req
}

func TestReviveRequiresInternalToken(t *testing.T) {
	t.Setenv("WEBSITE_INTERNAL_API_TOKEN", "expected-token")
	fake := &fakeReviveLogic{}
	h := &websiteHandler{logic: fake}

	for _, token := range []string{"", "wrong-token"} {
		rec := httptest.NewRecorder()
		h.handleInternalOperations(rec, newReviveRequest(t, http.MethodPost, "/internal/ctl/websites/operations/wo-1/revive", token))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("token %q: got status %d, want 401", token, rec.Code)
		}
		if fake.calledWith != "" {
			t.Fatalf("token %q must not reach the logic layer", token)
		}
	}
}

func TestReviveRejectsNonPostMethods(t *testing.T) {
	t.Setenv("WEBSITE_INTERNAL_API_TOKEN", "expected-token")
	fake := &fakeReviveLogic{}
	h := &websiteHandler{logic: fake}

	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		rec := httptest.NewRecorder()
		h.handleInternalOperations(rec, newReviveRequest(t, method, "/internal/ctl/websites/operations/wo-1/revive", "expected-token"))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s: got status %d, want 405", method, rec.Code)
		}
		if fake.calledWith != "" {
			t.Fatalf("%s must not reach the logic layer", method)
		}
	}
}

func TestRevivePassesOperationIDAndReturnsOperation(t *testing.T) {
	t.Setenv("WEBSITE_INTERNAL_API_TOKEN", "expected-token")
	fake := &fakeReviveLogic{op: &website.OperationEntity{
		OperationID:   "wo-464eb1f654cd5d91",
		OperationType: website.OpTypeDelete,
		Status:        website.OpStatusCreated,
	}}
	h := &websiteHandler{logic: fake}

	rec := httptest.NewRecorder()
	h.handleInternalOperations(rec, newReviveRequest(t, http.MethodPost, "/internal/ctl/websites/operations/wo-464eb1f654cd5d91/revive", "expected-token"))

	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d body %s, want 200", rec.Code, rec.Body.String())
	}
	if fake.calledWith != "wo-464eb1f654cd5d91" {
		t.Fatalf("logic received operation id %q", fake.calledWith)
	}
	var resp struct {
		Data struct {
			Status    string `json:"status"`
			Operation struct {
				OperationID string `json:"operation_id"`
				Status      string `json:"status"`
			} `json:"operation"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Data.Status != "revived" {
		t.Fatalf("response status = %q", resp.Data.Status)
	}
	if resp.Data.Operation.Status != website.OpStatusCreated {
		t.Fatalf("revived operation status = %q, want %q", resp.Data.Operation.Status, website.OpStatusCreated)
	}
}

// 复活失败必须把业务错误原样透出，否则运维只能看到 500，无法区分
// 「状态不对」和「围栏拦住了」。
func TestRevivePropagatesLogicError(t *testing.T) {
	t.Setenv("WEBSITE_INTERNAL_API_TOKEN", "expected-token")
	fake := &fakeReviveLogic{err: errcode.Wrap(errcode.ErrWebsiteOperationNotRevivable, "operation status is %q", website.OpStatusSuccess)}
	h := &websiteHandler{logic: fake}

	rec := httptest.NewRecorder()
	h.handleInternalOperations(rec, newReviveRequest(t, http.MethodPost, "/internal/ctl/websites/operations/wo-1/revive", "expected-token"))

	if rec.Code != http.StatusConflict {
		t.Fatalf("got status %d body %s, want 409", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "WEBSITE_OPERATION_NOT_REVIVABLE") {
		t.Fatalf("response must carry the business code, got %s", rec.Body.String())
	}
}
