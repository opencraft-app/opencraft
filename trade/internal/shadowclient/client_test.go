// Package shadowclient 单测覆盖 trade → shadow 内部反查的 HTTP 协议层。
package shadowclient

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// helper：构造一个返回指定 (status, bodyJSON) 的 httptest.Server。
//
// captureFn 可选，用于断言请求侧字段（path / header / query）。
func newTestServer(t *testing.T, status int, bodyJSON string, captureFn func(*http.Request)) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if captureFn != nil {
			captureFn(r)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if bodyJSON != "" {
			_, _ = w.Write([]byte(bodyJSON))
		}
	}))
}

func TestGetBindingByExternalUserID_Success_Int64Payload(t *testing.T) {
	var (
		gotMethod string
		gotPath   string
		gotQuery  string
		gotAuth   string
	)
	body := `{"code":"OK","message":"success","request_id":"req-1","data":{"user_id":"u-001","uin":12345,"owner_uin":12345,"app_id":67890}}`
	srv := newTestServer(t, http.StatusOK, body, func(r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		gotAuth = r.Header.Get("Authorization")
	})
	defer srv.Close()

	c := New(srv.URL, "token-xyz")
	got, err := c.GetBindingByExternalUserID(context.Background(), "u-001")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if gotMethod != http.MethodGet {
		t.Errorf("method = %q, want GET", gotMethod)
	}
	if gotPath != "/internal/shadow/binding" {
		t.Errorf("path = %q, want /internal/shadow/binding", gotPath)
	}
	if !strings.Contains(gotQuery, "external_user_id=u-001") {
		t.Errorf("query = %q, want external_user_id=u-001 substring", gotQuery)
	}
	if gotAuth != "Bearer token-xyz" {
		t.Errorf("auth = %q, want Bearer token-xyz", gotAuth)
	}
	if got.UserID != "u-001" || got.Uin != "12345" || got.OwnerUin != "12345" || got.AppID != "67890" {
		t.Errorf("binding = %+v, want {u-001,12345,12345,67890}", got)
	}
}

func TestGetBindingByExternalUserID_Success_StringPayload(t *testing.T) {
	// shadow 端如果已经做 stringify（uin/app_id 出 string）也能解析
	body := `{"code":"OK","data":{"user_id":"u-002","uin":"99999","owner_uin":"99999","app_id":"888"}}`
	srv := newTestServer(t, http.StatusOK, body, nil)
	defer srv.Close()

	c := New(srv.URL, "tok")
	got, err := c.GetBindingByExternalUserID(context.Background(), "u-002")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got.Uin != "99999" || got.AppID != "888" {
		t.Errorf("binding = %+v, want uin=99999 app_id=888", got)
	}
}

func TestGetBindingByExternalUserID_NotFound(t *testing.T) {
	body := `{"code":"BINDING_NOT_FOUND","message":"no binding","request_id":"req-2"}`
	srv := newTestServer(t, http.StatusNotFound, body, nil)
	defer srv.Close()

	c := New(srv.URL, "tok")
	_, err := c.GetBindingByExternalUserID(context.Background(), "u-missing")
	if err == nil {
		t.Fatal("want err, got nil")
	}
	if !errors.Is(err, ErrBindingNotFound) {
		t.Errorf("err = %v, want ErrBindingNotFound", err)
	}
}

func TestGetBindingByExternalUserID_Unauthorized(t *testing.T) {
	body := `{"code":"UNAUTHORIZED","message":"bad token"}`
	srv := newTestServer(t, http.StatusUnauthorized, body, nil)
	defer srv.Close()

	c := New(srv.URL, "wrong")
	_, err := c.GetBindingByExternalUserID(context.Background(), "u-001")
	if err == nil {
		t.Fatal("want err")
	}
	if !errors.Is(err, ErrUnauthorized) {
		t.Errorf("err = %v, want ErrUnauthorized", err)
	}
}

func TestGetBindingByExternalUserID_500_TypedError(t *testing.T) {
	body := `{"code":"INTERNAL_ERROR","message":"oops","request_id":"req-3"}`
	srv := newTestServer(t, http.StatusInternalServerError, body, nil)
	defer srv.Close()

	c := New(srv.URL, "tok")
	_, err := c.GetBindingByExternalUserID(context.Background(), "u-001")
	if err == nil {
		t.Fatal("want err")
	}
	var typed *Error
	if !errors.As(err, &typed) {
		t.Fatalf("want *Error, got %T (%v)", err, err)
	}
	if typed.HTTPStatus != http.StatusInternalServerError {
		t.Errorf("HTTPStatus = %d, want 500", typed.HTTPStatus)
	}
	if typed.Code != "INTERNAL_ERROR" || typed.RequestID != "req-3" {
		t.Errorf("typed = %+v", typed)
	}
}

func TestGetBindingByExternalUserID_NonJSONErrorBody(t *testing.T) {
	srv := newTestServer(t, http.StatusBadGateway, `<html>nginx 502</html>`, nil)
	defer srv.Close()

	c := New(srv.URL, "tok")
	_, err := c.GetBindingByExternalUserID(context.Background(), "u-001")
	if err == nil {
		t.Fatal("want err")
	}
	var typed *Error
	if !errors.As(err, &typed) {
		t.Fatalf("want *Error, got %T", err)
	}
	if typed.HTTPStatus != http.StatusBadGateway {
		t.Errorf("HTTPStatus = %d, want 502", typed.HTTPStatus)
	}
	if !strings.Contains(typed.Message, "nginx") {
		t.Errorf("message = %q, want to contain raw body", typed.Message)
	}
}

func TestGetBindingByExternalUserID_EmptyExternalUserID(t *testing.T) {
	c := New("http://localhost:8080", "tok")
	_, err := c.GetBindingByExternalUserID(context.Background(), "")
	if err == nil {
		t.Fatal("want err for empty externalUserID")
	}
	if !strings.Contains(err.Error(), "externalUserID is required") {
		t.Errorf("err = %v, want 'externalUserID is required' message", err)
	}
}

func TestGetBindingByExternalUserID_EmptyBaseURL(t *testing.T) {
	c := New("", "tok")
	_, err := c.GetBindingByExternalUserID(context.Background(), "u-001")
	if err == nil {
		t.Fatal("want err for empty baseURL")
	}
	if !strings.Contains(err.Error(), "baseURL is empty") {
		t.Errorf("err = %v, want 'baseURL is empty' message", err)
	}
}

func TestGetBindingByExternalUserID_EmptyDataField(t *testing.T) {
	body := `{"code":"OK","message":"no data"}`
	srv := newTestServer(t, http.StatusOK, body, nil)
	defer srv.Close()

	c := New(srv.URL, "tok")
	_, err := c.GetBindingByExternalUserID(context.Background(), "u-001")
	if err == nil {
		t.Fatal("want err for missing data field")
	}
	if !strings.Contains(err.Error(), "empty data field") {
		t.Errorf("err = %v, want 'empty data field' substring", err)
	}
}

func TestGetBindingByExternalUserID_DataMissingUinAndAppID(t *testing.T) {
	body := `{"code":"OK","data":{"user_id":"u-only"}}`
	srv := newTestServer(t, http.StatusOK, body, nil)
	defer srv.Close()

	c := New(srv.URL, "tok")
	_, err := c.GetBindingByExternalUserID(context.Background(), "u-only")
	if err == nil {
		t.Fatal("want err for missing uin/app_id")
	}
	if !strings.Contains(err.Error(), "missing uin/app_id") {
		t.Errorf("err = %v, want 'missing uin/app_id' substring", err)
	}
}

func TestGetBindingByExternalUserID_NoToken_NoAuthHeader(t *testing.T) {
	var gotAuth string
	srv := newTestServer(t, http.StatusOK,
		`{"code":"OK","data":{"user_id":"u","uin":1,"owner_uin":1,"app_id":2}}`,
		func(r *http.Request) { gotAuth = r.Header.Get("Authorization") })
	defer srv.Close()

	c := New(srv.URL, "") // 空 token：不应发 Authorization header
	_, err := c.GetBindingByExternalUserID(context.Background(), "u")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if gotAuth != "" {
		t.Errorf("auth = %q, want empty when token is empty", gotAuth)
	}
}

func TestGetBindingByExternalUserID_CustomHTTPClient(t *testing.T) {
	srv := newTestServer(t, http.StatusOK,
		`{"code":"OK","data":{"user_id":"u","uin":1,"owner_uin":1,"app_id":2}}`, nil)
	defer srv.Close()

	customClient := &http.Client{Timeout: 1 * time.Second}
	c := New(srv.URL, "tok", Options{HTTPClient: customClient})
	if _, err := c.GetBindingByExternalUserID(context.Background(), "u"); err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
}

func TestNewUsesSeparateCredentialExchangeTimeout(t *testing.T) {
	client := New("http://shadow.test", "token")
	httpClient, ok := client.(*httpClient)
	if !ok {
		t.Fatalf("New returned %T, want *httpClient", client)
	}
	if httpClient.httpClient.Timeout != 4*time.Second {
		t.Fatalf("binding timeout = %s, want 4s", httpClient.httpClient.Timeout)
	}
	if httpClient.credentialHTTPClient.Timeout != 20*time.Second {
		t.Fatalf("credential timeout = %s, want 20s", httpClient.credentialHTTPClient.Timeout)
	}
}

// 验证 Binding JSON tag 与 shadow 内部 storage.Binding 字段命名对齐。
// 这是一个静态断言测试，主要预防字段重构时漏改。
func TestBinding_JSONFieldNames(t *testing.T) {
	b := Binding{UserID: "u", Uin: "100", OwnerUin: "100", AppID: "200"}
	raw, err := json.Marshal(&b)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	str := string(raw)
	for _, key := range []string{`"user_id"`, `"uin"`, `"owner_uin"`, `"app_id"`} {
		if !strings.Contains(str, key) {
			t.Errorf("marshaled JSON missing %s: %s", key, str)
		}
	}
}

func TestGetTemporaryCredentialsByExternalUserID_Success(t *testing.T) {
	var (
		gotMethod string
		gotPath   string
		gotAuth   string
		gotBody   map[string]string
	)
	body := `{"code":"OK","data":{"uin":300000000053,"owner_uin":300000000053,"tmp_secret_id":"tmp-id","tmp_secret_key":"tmp-key","token":"tmp-token","expired_at":"2099-08-13T04:00:00Z"}}`
	srv := newTestServer(t, http.StatusOK, body, func(r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode request body: %v", err)
		}
	})
	defer srv.Close()

	c := New(srv.URL, "token-xyz")
	got, err := c.GetTemporaryCredentialsByExternalUserID(context.Background(), "usr_1")
	if err != nil {
		t.Fatalf("GetTemporaryCredentialsByExternalUserID: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/internal/shadow/credentials" {
		t.Fatalf("request = %s %s, want POST /internal/shadow/credentials", gotMethod, gotPath)
	}
	if gotAuth != "Bearer token-xyz" {
		t.Fatalf("Authorization = %q", gotAuth)
	}
	if gotBody["external_user_id"] != "usr_1" || gotBody["client_ua"] != "lightvela-trade" {
		t.Fatalf("request body = %+v", gotBody)
	}
	if got.Uin != "300000000053" || got.OwnerUin != "300000000053" ||
		got.SecretID != "tmp-id" || got.SecretKey != "tmp-key" || got.Token != "tmp-token" {
		t.Fatalf("credentials = %+v", got)
	}
	if got.ExpiredAt.Format(time.RFC3339) != "2099-08-13T04:00:00Z" {
		t.Fatalf("ExpiredAt = %s", got.ExpiredAt)
	}
}

func TestGetPaymentContextByExternalUserID_Success(t *testing.T) {
	var (
		gotMethod string
		gotPath   string
		gotAuth   string
		gotBody   map[string]string
	)
	srv := newTestServer(t, http.StatusOK,
		`{"code":"OK","data":{"has_payment_method":true,"uin":300000000053,"owner_uin":300000000053,"tmp_secret_id":"tmp-id","tmp_secret_key":"tmp-key","token":"tmp-token","expired_at":"2099-08-13T04:00:00Z"}}`,
		func(r *http.Request) {
			gotMethod = r.Method
			gotPath = r.URL.Path
			gotAuth = r.Header.Get("Authorization")
			if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
				t.Errorf("decode request body: %v", err)
			}
		})
	defer srv.Close()

	client := New(srv.URL, "token-xyz")
	paymentContext, err := client.GetPaymentContextByExternalUserID(context.Background(), "usr_1")
	if err != nil {
		t.Fatalf("GetPaymentContextByExternalUserID: %v", err)
	}
	if !paymentContext.HasPaymentMethod || paymentContext.Credentials.SecretID != "tmp-id" || paymentContext.Credentials.Token != "tmp-token" {
		t.Fatalf("unexpected payment context: %+v", paymentContext)
	}
	if gotMethod != http.MethodPost || gotPath != "/internal/payment-methods/context" {
		t.Fatalf("request = %s %s", gotMethod, gotPath)
	}
	if gotBody["external_user_id"] != "usr_1" || gotBody["client_ua"] != "lightvela-trade" {
		t.Fatalf("request body = %+v", gotBody)
	}
	if gotAuth != "Bearer token-xyz" {
		t.Fatalf("Authorization = %q", gotAuth)
	}
}

func TestGetTemporaryCredentialsByExternalUserID_RejectsIncompleteResponseWithoutLeakingSecrets(t *testing.T) {
	body := `{"code":"OK","data":{"uin":300000000053,"owner_uin":300000000053,"tmp_secret_id":"tmp-id","tmp_secret_key":"sensitive-key","token":""}}`
	srv := newTestServer(t, http.StatusOK, body, nil)
	defer srv.Close()

	c := New(srv.URL, "token-xyz")
	_, err := c.GetTemporaryCredentialsByExternalUserID(context.Background(), "usr_1")
	if err == nil || !strings.Contains(err.Error(), "incomplete") {
		t.Fatalf("error = %v, want incomplete credentials", err)
	}
	if strings.Contains(err.Error(), "sensitive-key") {
		t.Fatalf("error leaked temporary credential: %v", err)
	}
}

func TestGetTemporaryCredentialsByExternalUserID_RejectsExpiredResponse(t *testing.T) {
	body := `{"code":"OK","data":{"uin":300000000053,"owner_uin":300000000053,"tmp_secret_id":"tmp-id","tmp_secret_key":"tmp-key","token":"tmp-token","expired_at":"2020-01-01T00:00:00Z"}}`
	srv := newTestServer(t, http.StatusOK, body, nil)
	defer srv.Close()

	c := New(srv.URL, "token-xyz")
	_, err := c.GetTemporaryCredentialsByExternalUserID(context.Background(), "usr_1")
	if err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("error = %v, want expired credentials", err)
	}
}
