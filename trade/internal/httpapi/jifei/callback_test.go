package jifei

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func init() {
	gin.SetMode(gin.TestMode)
}

// 端到端：构造 gin engine + dispatcher + stub，发真 HTTP POST，验证响应 framework 结构。
//
// 注意：迭代 6 起 InstallStubHandlers 不再注册 stub（checkCreate / createResource 都已经
// 有真 handler 落地），所以本测试 helper 直接注册"测试用 stub" handler 来保持本文件断言
// 形态不变（只验证 dispatcher / callback HTTP 框架本身，不验证业务 handler）。
func newCallbackEngine(t *testing.T) *gin.Engine {
	t.Helper()
	b := NewFrameworkBuilder("trade", "1.0")
	d := NewDispatcher("lightvela", b)
	// 测试本地注册 stub（不影响生产装配路径）
	d.Register(InterfaceNameCheckCreate, stubHandler(d, InterfaceNameCheckCreate, 5))
	d.Register(InterfaceNameCreateResource, stubHandler(d, InterfaceNameCreateResource, 6))

	e := gin.New()
	e.Use(gin.Recovery())
	e.POST("/trade/jifei/callback", CallbackHandler(d))
	return e
}

// helper：发起 POST 并解析 framework 出参。
func postCallback(t *testing.T, e *gin.Engine, body string) (*httptest.ResponseRecorder, Framework) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/trade/jifei/callback", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	var resp Framework
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("response is not valid framework JSON: %v\nbody=%s", err, rec.Body.String())
	}
	return rec, resp
}

func TestCallbackHandler_HappyPath_StubCheckCreate_HTTP200_NonZeroReturnCode(t *testing.T) {
	e := newCallbackEngine(t)
	body := `{
        "eventId": "evt-1", "componentName": "trade",
        "seqId": "seq-x", "spanId": "span-x",
        "interface": {"interfaceName": "lightvela.pass.checkCreate", "para": {"appId": 100}}
    }`
	rec, resp := postCallback(t, e, body)

	// HTTP 状态恒 200（PDF Q58：jifei 按 returnCode 判定，HTTP status 不参与）。
	if rec.Code != http.StatusOK {
		t.Errorf("expected HTTP 200, got %d", rec.Code)
	}
	// 业务层是 stub → 非零 returnCode（让 jifei 重试）。
	if resp.ReturnCode != ReturnCodeNotImplemented {
		t.Errorf("expected stub returnCode=%d, got %d", ReturnCodeNotImplemented, resp.ReturnCode)
	}
	if resp.ReturnCode != resp.ReturnValue {
		t.Errorf("Q58 strict invariant: returnCode==returnValue; got %d != %d", resp.ReturnCode, resp.ReturnValue)
	}
	if resp.ComponentName != "trade" || resp.Version != "1.0" {
		t.Errorf("componentName/version not propagated; got %q / %q", resp.ComponentName, resp.Version)
	}
}

func TestCallbackHandler_MalformedJSON_HTTP200_InvalidEnvelopeReturnCode(t *testing.T) {
	e := newCallbackEngine(t)
	rec, resp := postCallback(t, e, `{INVALID JSON`)

	// 即使 envelope 损坏，dispatcher 仍能返 framework 错误响应 → HTTP 200。
	if rec.Code != http.StatusOK {
		t.Errorf("expected HTTP 200 for malformed JSON, got %d", rec.Code)
	}
	if resp.ReturnCode != ReturnCodeInvalidEnvelope {
		t.Errorf("expected ReturnCodeInvalidEnvelope=%d, got %d", ReturnCodeInvalidEnvelope, resp.ReturnCode)
	}
}

func TestCallbackHandler_UnknownInterface_HTTP200_UnknownReturnCode(t *testing.T) {
	e := newCallbackEngine(t)
	body := `{"interface": {"interfaceName": "lightvela.pass.somethingNew", "para": {}}}`
	rec, resp := postCallback(t, e, body)

	if rec.Code != http.StatusOK {
		t.Errorf("expected HTTP 200, got %d", rec.Code)
	}
	if resp.ReturnCode != ReturnCodeUnknownInterface {
		t.Errorf("expected ReturnCodeUnknownInterface=%d, got %d", ReturnCodeUnknownInterface, resp.ReturnCode)
	}
}

func TestCallbackHandler_RefundReturnCode_NeverConflictsWithErrorPaths(t *testing.T) {
	// 综合再保险：跑完整一组协议层错路径，断言所有响应都不是 352014（避免误退款）。
	e := newCallbackEngine(t)
	cases := []struct {
		name string
		body string
	}{
		{"malformed envelope", `{INVALID`},
		{"empty interfaceName", `{"interface": {"interfaceName": ""}}`},
		{"two segments", `{"interface": {"interfaceName": "lightvela.pass"}}`},
		{"wrong prefix", `{"interface": {"interfaceName": "qcloud.pass.checkCreate"}}`},
		{"unknown subProduct", `{"interface": {"interfaceName": "lightvela.unknown.checkCreate"}}`},
		{"unknown action", `{"interface": {"interfaceName": "lightvela.pass.unknownAction"}}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, resp := postCallback(t, e, c.body)
			if resp.ReturnCode == RefundReturnCode {
				t.Errorf("PROTOCOL ERROR triggered refund (returnCode=%d) — would cause unintended user refund!", resp.ReturnCode)
			}
		})
	}
}

func TestCallbackHandler_BodyShape_PassesPDFFrameworkCurlExample(t *testing.T) {
	// 用近似 PDF 第 5 页 curl 示例的入参格式跑一遍，断言 dispatcher 解包成功。
	e := newCallbackEngine(t)
	body := `{
        "eventId": "1234567",
        "componentName": "trade",
        "seqId": "abcdef",
        "spanId": "12345",
        "interface": {
            "interfaceName": "lightvela.pass.checkCreate",
            "para": {
                "appId": 1234567890,
                "uin": "100020003000",
                "productCode": "lightvela",
                "subProductCode": "pass",
                "region": "ap-shanghai",
                "payMode": 0,
                "goodsDetail": {
                    "pid": 999999,
                    "timeSpan": 1,
                    "timeUnit": "MONTH",
                    "goodsNum": 1
                },
                "dealName": "deal-test-001"
            }
        }
    }`
	rec, resp := postCallback(t, e, body)

	if rec.Code != http.StatusOK {
		t.Errorf("expected HTTP 200, got %d", rec.Code)
	}
	if resp.ReturnCode != ReturnCodeNotImplemented {
		t.Errorf("PDF-shape envelope should reach checkCreate stub (returnCode=%d), got %d",
			ReturnCodeNotImplemented, resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "abcdef") {
		t.Errorf("seqId should be echoed in stub message, got %q", resp.ReturnMessage)
	}
}
