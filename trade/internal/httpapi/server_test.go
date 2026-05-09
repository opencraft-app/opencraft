package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func init() {
	gin.SetMode(gin.TestMode)
}

func newTestRouter() *gin.Engine {
	return NewRouter(ServerConfig{
		InternalServiceToken:    "test-token",
		JifeiComponentName:      "trade",
		JifeiProtocolVersion:    "1.0",
		JifeiOurInterfacePrefix: "lightvela",
	})
}

func TestNewRouter_Healthz(t *testing.T) {
	r := newTestRouter()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if body["status"] != "ok" {
		t.Errorf("expected status=ok, got %+v", body)
	}
}

func TestNewRouter_JifeiCallback_StubCheckCreate(t *testing.T) {
	r := newTestRouter()
	body := `{
        "seqId": "seq-int",
        "interface": {"interfaceName": "lightvela.pass.checkCreate", "para": {}}
    }`
	req := httptest.NewRequest(http.MethodPost, "/trade/jifei/callback", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected HTTP 200, got %d", rec.Code)
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid framework JSON: %v", err)
	}
	// stub 返非零 returnCode（迭代 4 不接业务逻辑）
	if v, ok := resp["returnCode"].(float64); !ok || int(v) == 0 {
		t.Errorf("expected non-zero returnCode for stub, got %+v", resp["returnCode"])
	}
	// returnCode == returnValue 不变量
	if resp["returnCode"] != resp["returnValue"] {
		t.Errorf("Q58 invariant: returnCode==returnValue must hold; got %+v / %+v",
			resp["returnCode"], resp["returnValue"])
	}
}

func TestNewRouter_JifeiCallback_RoutingErrorReturnsFrameworkError(t *testing.T) {
	r := newTestRouter()
	// 不合法 prefix
	body := `{"interface": {"interfaceName": "qcloud.pass.checkCreate"}}`
	req := httptest.NewRequest(http.MethodPost, "/trade/jifei/callback", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected HTTP 200 even for protocol error, got %d", rec.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	// 必须不是 352014（防误退款）
	if rc, _ := resp["returnCode"].(float64); int(rc) == 352014 {
		t.Errorf("PROTOCOL error should NEVER return refund magic 352014")
	}
}
