package jifeiclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// envelopeForSuccess 是测试 helper：构造 returnCode=0 的成功 CGW envelope。
func envelopeForSuccess(t *testing.T, returnValue any) []byte {
	t.Helper()
	rv, err := json.Marshal(returnValue)
	if err != nil {
		t.Fatalf("marshal returnValue: %v", err)
	}
	rcZero := 0
	env := envelope{
		Version:       CGWVersion,
		EventID:       "test-event-id",
		ReturnCode:    &rcZero,
		ReturnMessage: "success",
		ReturnValue:   rv,
	}
	b, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	return b
}

// envelopeForError 是测试 helper：构造 returnCode != 0 的业务失败 envelope。
func envelopeForError(t *testing.T, code int, msg string) []byte {
	t.Helper()
	env := envelope{
		Version:       CGWVersion,
		EventID:       "test-event-id",
		ReturnCode:    &code,
		ReturnMessage: msg,
	}
	b, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	return b
}

// fixedEventIDProvider 返回确定性 eventId，用于断言 framework 字段一致性。
func fixedEventIDProvider() string {
	return "deadbeef00000000deadbeef00000000"
}

// fixedNowProvider 返回确定性时间戳。
func fixedNowProvider() time.Time {
	return time.Date(2026, 5, 8, 12, 0, 0, 0, time.UTC)
}

// TestGetPrice_Success 覆盖 happy-path：
//   - HTTP 请求方式 / 路径 / Host header / x-qcloud-user-id 正确
//   - framework 顶层 7 字段全部正确（version / componentName / eventId / timestamp / seqId / interface.interfaceName）
//   - request body 内 para 字段与 GetPriceRequest 一致
//   - 响应 returnValue 反序列化到 GetPriceResponse 后字段值正确
func TestGetPrice_Success(t *testing.T) {
	var (
		seenMethod     string
		seenHost       string
		seenUserID     string
		seenInterface  string
		seenComponent  string
		seenVersion    string
		seenEventID    string
		seenTimestamp  string
		seenSeqID      string
		seenParaOwner  string
		seenResInfoLen int
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenMethod = r.Method
		seenHost = r.Host
		seenUserID = r.Header.Get(CGWUserIDHeader)

		body, _ := io.ReadAll(r.Body)
		var env envelope
		if err := json.Unmarshal(body, &env); err != nil {
			t.Fatalf("unmarshal request envelope: %v", err)
		}
		seenVersion = env.Version
		seenComponent = env.ComponentName
		seenEventID = env.EventID
		seenTimestamp = env.Timestamp
		seenSeqID = env.SeqID
		if env.Interface != nil {
			seenInterface = env.Interface.InterfaceName
			var para GetPriceRequest
			if err := json.Unmarshal(env.Interface.Para, &para); err != nil {
				t.Fatalf("unmarshal para: %v", err)
			}
			seenParaOwner = para.OwnerUin
			seenResInfoLen = len(para.ResInfo)
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(envelopeForSuccess(t, GetPriceResponse{
			Data: []GetPriceData{
				{
					Price:         "100.00",
					TotalCost:     "100.00",
					RealTotalCost: "80.00",
					Currency:      "CNY",
					PolicyDetail:  &PolicyDetail{Total: 0.8, User: 0.9, Common: 1.0},
				},
			},
		}))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-service-uin-100012345678", Options{
		EventIDProvider: fixedEventIDProvider,
		NowProvider:     fixedNowProvider,
	})

	resp, err := cli.GetPrice(context.Background(), &GetPriceRequest{
		OwnerUin: "100012345678",
		Uin:      "100012345678",
		ResInfo: []GetPriceItem{
			{
				GoodsCategoryID: "100059",
				Currency:        "CNY",
				GoodsNum:        1,
				PayMode:         1,
				Action:          "purchase",
				GoodsDetail: map[string]interface{}{
					"productCode":    "p_lighthouse",
					"subProductCode": "sp_lighthouse_bundle_linux_small",
					"pid":            "1234",
					"timeSpan":       1,
					"timeUnit":       "m",
					"sv_key1":        "v1",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("GetPrice: %v", err)
	}

	// 出参字段断言
	if got := len(resp.Data); got != 1 {
		t.Fatalf("Data len: got %d want 1", got)
	}
	if got := resp.Data[0].RealTotalCost; got != "80.00" {
		t.Errorf("RealTotalCost: got %q want %q", got, "80.00")
	}
	if resp.Data[0].PolicyDetail == nil || resp.Data[0].PolicyDetail.Total != 0.8 {
		t.Errorf("PolicyDetail.Total: got %+v want 0.8", resp.Data[0].PolicyDetail)
	}

	// 请求字段断言
	if seenMethod != http.MethodPost {
		t.Errorf("HTTP method: got %s want POST", seenMethod)
	}
	if seenHost != CGWHostHeader {
		t.Errorf("Host header: got %q want %q", seenHost, CGWHostHeader)
	}
	if seenUserID != "trade-service-uin-100012345678" {
		t.Errorf("x-qcloud-user-id: got %q", seenUserID)
	}
	if seenVersion != CGWVersion {
		t.Errorf("envelope.version: got %q want %q", seenVersion, CGWVersion)
	}
	if seenComponent != ComponentNamePrice {
		t.Errorf("envelope.componentName: got %q want %q", seenComponent, ComponentNamePrice)
	}
	if seenInterface != InterfaceNameGetPrice {
		t.Errorf("envelope.interface.interfaceName: got %q want %q", seenInterface, InterfaceNameGetPrice)
	}
	if seenEventID != fixedEventIDProvider() {
		t.Errorf("envelope.eventId: got %q want fixed", seenEventID)
	}
	if seenSeqID != fixedEventIDProvider() {
		t.Errorf("envelope.seqId: got %q want fixed", seenSeqID)
	}
	if seenTimestamp == "" {
		t.Errorf("envelope.timestamp empty")
	}
	if seenParaOwner != "100012345678" {
		t.Errorf("para.OwnerUin: got %q", seenParaOwner)
	}
	if seenResInfoLen != 1 {
		t.Errorf("para.ResInfo len: got %d want 1", seenResInfoLen)
	}
}

// TestGetPrice_NoSignatureField 验证 Q47：trade → jifei 请求方向不传 auth.signature。
//
// 直接断言 request body 序列化结果不含 "signature" / "auth" 字段（不区分大小写）。
func TestGetPrice_NoSignatureField(t *testing.T) {
	var bodyStr string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		bodyStr = string(body)
		_, _ = w.Write(envelopeForSuccess(t, GetPriceResponse{Data: []GetPriceData{}}))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin", Options{
		EventIDProvider: fixedEventIDProvider,
		NowProvider:     fixedNowProvider,
	})
	_, err := cli.GetPrice(context.Background(), &GetPriceRequest{
		OwnerUin: "1", Uin: "1",
		ResInfo: []GetPriceItem{{Action: "purchase", GoodsNum: 1, PayMode: 1}},
	})
	if err != nil {
		t.Fatalf("GetPrice: %v", err)
	}

	lower := strings.ToLower(bodyStr)
	if strings.Contains(lower, "signature") {
		t.Errorf("Q47 violated: request body contains \"signature\":\n%s", bodyStr)
	}
	if strings.Contains(lower, `"auth"`) {
		t.Errorf("Q47 violated: request body contains \"auth\" field:\n%s", bodyStr)
	}
}

// TestGetPrice_OmitsQ48Fields 验证 Q48：tagList / voucherIds / agentPay 三类字段不传。
//
// 注意：本 client 通过 GetPriceItem struct 字段集本身没有这三项，因此天然不传 — 但用 raw JSON
// 解析 request body 兜底校验，避免未来误改 struct 引入这三项。
func TestGetPrice_OmitsQ48Fields(t *testing.T) {
	var bodyStr string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		bodyStr = string(body)
		_, _ = w.Write(envelopeForSuccess(t, GetPriceResponse{Data: []GetPriceData{}}))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin", Options{
		EventIDProvider: fixedEventIDProvider,
		NowProvider:     fixedNowProvider,
	})
	_, err := cli.GetPrice(context.Background(), &GetPriceRequest{
		OwnerUin: "1", Uin: "1",
		ResInfo: []GetPriceItem{{Action: "purchase", GoodsNum: 1, PayMode: 1}},
	})
	if err != nil {
		t.Fatalf("GetPrice: %v", err)
	}
	for _, banned := range []string{"tagList", "voucherIds", "agentPay"} {
		if strings.Contains(bodyStr, banned) {
			t.Errorf("Q48 violated: request body contains banned field %q:\n%s", banned, bodyStr)
		}
	}
}

// TestGetPrice_BusinessError 验证 returnCode != 0 时返 *CGWError。
func TestGetPrice_BusinessError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(envelopeForError(t, 100007, "InvalidParameter.GoodsCategoryId"))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin")
	_, err := cli.GetPrice(context.Background(), &GetPriceRequest{
		OwnerUin: "1", Uin: "1",
		ResInfo: []GetPriceItem{{Action: "purchase", GoodsNum: 1, PayMode: 1}},
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	var cgwErr *CGWError
	if !errors.As(err, &cgwErr) {
		t.Fatalf("expected *CGWError, got %T: %v", err, err)
	}
	if cgwErr.ReturnCode != 100007 {
		t.Errorf("ReturnCode: got %d want 100007", cgwErr.ReturnCode)
	}
	if cgwErr.ReturnMessage != "InvalidParameter.GoodsCategoryId" {
		t.Errorf("ReturnMessage: got %q", cgwErr.ReturnMessage)
	}
	if cgwErr.InterfaceName != InterfaceNameGetPrice {
		t.Errorf("InterfaceName: got %q want %q", cgwErr.InterfaceName, InterfaceNameGetPrice)
	}
}

// TestGetPrice_HTTPNon200 验证 HTTP 非 2xx 时返 ErrCGWHTTPNon200。
func TestGetPrice_HTTPNon200(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("upstream gateway error"))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin")
	_, err := cli.GetPrice(context.Background(), &GetPriceRequest{
		OwnerUin: "1", Uin: "1",
		ResInfo: []GetPriceItem{{Action: "purchase"}},
	})
	if !errors.Is(err, ErrCGWHTTPNon200) {
		t.Fatalf("expected ErrCGWHTTPNon200, got: %v", err)
	}
}

// TestGetPrice_InvalidEnvelope 验证响应 envelope 缺 returnCode 时返 ErrCGWInvalidEnvelope。
func TestGetPrice_InvalidEnvelope(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// HTTP 200 但 returnCode 字段缺失（恶意 / 错版网关响应）
		_, _ = w.Write([]byte(`{"version":"1.0","returnMessage":"ok"}`))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin")
	_, err := cli.GetPrice(context.Background(), &GetPriceRequest{
		OwnerUin: "1", Uin: "1",
		ResInfo: []GetPriceItem{{Action: "purchase"}},
	})
	if !errors.Is(err, ErrCGWInvalidEnvelope) {
		t.Fatalf("expected ErrCGWInvalidEnvelope, got: %v", err)
	}
}

// TestGetPrice_InvalidEnvelopeBadJSON 验证响应 body 不是合法 JSON 时返 ErrCGWInvalidEnvelope。
func TestGetPrice_InvalidEnvelopeBadJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html>gateway down</html>`))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin")
	_, err := cli.GetPrice(context.Background(), &GetPriceRequest{
		OwnerUin: "1", Uin: "1",
		ResInfo: []GetPriceItem{{Action: "purchase"}},
	})
	if !errors.Is(err, ErrCGWInvalidEnvelope) {
		t.Fatalf("expected ErrCGWInvalidEnvelope, got: %v", err)
	}
}

// TestGetPrice_ContextCancelStopsRequest 验证 context 取消立即生效。
func TestGetPrice_ContextCancelStopsRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		_, _ = w.Write(envelopeForSuccess(t, GetPriceResponse{Data: []GetPriceData{}}))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()

	start := time.Now()
	_, err := cli.GetPrice(ctx, &GetPriceRequest{
		OwnerUin: "1", Uin: "1",
		ResInfo: []GetPriceItem{{Action: "purchase"}},
	})
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("expected error from context cancel, got nil")
	}
	if elapsed > 150*time.Millisecond {
		t.Errorf("context cancel was too slow: %v", elapsed)
	}
}

// TestGenerateDeals_Success 覆盖下单 happy-path：
//   - PascalCase 字段 OwnerUin / Uin / GoodsInfos / GoodsCategoryId / PayMode 正确
//   - 响应 BigDealId / DealNames 提取正确
//   - request body 不含 Currency / TagList / VoucherIDs / AgentPay 字段（Q42 / Q48）
func TestGenerateDeals_Success(t *testing.T) {
	var (
		seenInterface  string
		seenComponent  string
		seenParaOwner  string
		seenGoodsLen   int
		seenCategoryID string
		seenPayMode    int
		bodyStr        string
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		bodyStr = string(body)

		var env envelope
		if err := json.Unmarshal(body, &env); err != nil {
			t.Fatalf("unmarshal request envelope: %v", err)
		}
		seenComponent = env.ComponentName
		if env.Interface != nil {
			seenInterface = env.Interface.InterfaceName
			var para GenerateDealsRequest
			if err := json.Unmarshal(env.Interface.Para, &para); err != nil {
				t.Fatalf("unmarshal para: %v", err)
			}
			seenParaOwner = para.OwnerUin
			seenGoodsLen = len(para.GoodsInfos)
			if seenGoodsLen > 0 {
				seenCategoryID = para.GoodsInfos[0].GoodsCategoryID
				seenPayMode = para.GoodsInfos[0].PayMode
			}
		}

		_, _ = w.Write(envelopeForSuccess(t, GenerateDealsResponse{
			BigDealID: "20260508BIG00001",
			DealNames: []string{"20260508DEAL00001"},
			PriceInfos: []map[string]interface{}{
				{"RealTotalCost": "80.00", "Currency": "CNY"},
			},
		}))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin")
	resp, err := cli.GenerateDeals(context.Background(), &GenerateDealsRequest{
		OwnerUin: "100012345678",
		Uin:      "100012345678",
		GoodsInfos: []GoodsInfo{
			{
				GoodsCategoryID: "100059",
				RegionID:        47,
				ZoneID:          470004,
				GoodsNum:        1,
				PayMode:         1,
				GoodsDetail: map[string]interface{}{
					"productCode":    "p_lighthouse",
					"subProductCode": "sp_lighthouse_bundle_linux_small",
					"pid":            "1234",
					"timeSpan":       1,
					"timeUnit":       "m",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("GenerateDeals: %v", err)
	}

	if resp.BigDealID != "20260508BIG00001" {
		t.Errorf("BigDealID: got %q", resp.BigDealID)
	}
	if len(resp.DealNames) != 1 || resp.DealNames[0] != "20260508DEAL00001" {
		t.Errorf("DealNames: got %v", resp.DealNames)
	}
	if seenInterface != InterfaceNameGenerateDeals {
		t.Errorf("interfaceName: got %q want %q", seenInterface, InterfaceNameGenerateDeals)
	}
	if seenComponent != ComponentNameDeal {
		t.Errorf("componentName: got %q want %q", seenComponent, ComponentNameDeal)
	}
	if seenParaOwner != "100012345678" {
		t.Errorf("OwnerUin: got %q", seenParaOwner)
	}
	if seenGoodsLen != 1 {
		t.Errorf("GoodsInfos len: got %d", seenGoodsLen)
	}
	if seenCategoryID != "100059" {
		t.Errorf("GoodsCategoryId: got %q", seenCategoryID)
	}
	if seenPayMode != 1 {
		t.Errorf("PayMode: got %d", seenPayMode)
	}

	// Q42 / Q48 字段集校验
	for _, banned := range []string{`"Currency"`, `"TagList"`, `"VoucherIDs"`, `"AgentPay"`, `"GoodsAlias"`} {
		if strings.Contains(bodyStr, banned) {
			t.Errorf("forbidden field %s present in body:\n%s", banned, bodyStr)
		}
	}
}

// TestGenerateDeals_BusinessError 验证下单业务失败传播 *CGWError。
func TestGenerateDeals_BusinessError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(envelopeForError(t, 100016, "Balance.Insufficient"))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin")
	_, err := cli.GenerateDeals(context.Background(), &GenerateDealsRequest{
		OwnerUin: "1", Uin: "1",
		GoodsInfos: []GoodsInfo{{GoodsCategoryID: "100059", GoodsNum: 1, PayMode: 1}},
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	var cgwErr *CGWError
	if !errors.As(err, &cgwErr) {
		t.Fatalf("expected *CGWError, got %T: %v", err, err)
	}
	if cgwErr.ReturnCode != 100016 {
		t.Errorf("ReturnCode: got %d want 100016", cgwErr.ReturnCode)
	}
	if cgwErr.InterfaceName != InterfaceNameGenerateDeals {
		t.Errorf("InterfaceName: got %q", cgwErr.InterfaceName)
	}
}

// TestGenerateDeals_NilRequest 验证 client-side 入参校验。
func TestGenerateDeals_NilRequest(t *testing.T) {
	cli := New("http://unused", "trade-uin")
	_, err := cli.GenerateDeals(context.Background(), nil)
	if err == nil {
		t.Fatal("expected error for nil request")
	}
	if !strings.Contains(err.Error(), "nil request") {
		t.Errorf("error should mention nil request: %v", err)
	}
}

// TestGetPrice_NilRequest 验证 GetPrice 也做 nil 校验。
func TestGetPrice_NilRequest(t *testing.T) {
	cli := New("http://unused", "trade-uin")
	_, err := cli.GetPrice(context.Background(), nil)
	if err == nil {
		t.Fatal("expected error for nil request")
	}
}

// TestNew_EmptyBaseURL 验证 baseURL 缺失时 do 阶段报错。
func TestNew_EmptyBaseURL(t *testing.T) {
	cli := New("", "trade-uin")
	_, err := cli.GetPrice(context.Background(), &GetPriceRequest{
		OwnerUin: "1", Uin: "1",
		ResInfo: []GetPriceItem{{Action: "purchase"}},
	})
	if err == nil {
		t.Fatal("expected error for empty baseURL")
	}
	if !strings.Contains(err.Error(), "baseURL") {
		t.Errorf("error should mention baseURL: %v", err)
	}
}

// TestNew_TrimsBaseURL 验证 baseURL 末尾斜杠 / 空白被裁剪。
func TestNew_TrimsBaseURL(t *testing.T) {
	c := New("  http://example.com/api/  ", "  user  ").(*client)
	if c.baseURL != "http://example.com/api" {
		t.Errorf("baseURL: got %q want %q", c.baseURL, "http://example.com/api")
	}
	if c.xQCloudUserID != "user" {
		t.Errorf("xQCloudUserID: got %q", c.xQCloudUserID)
	}
}

// TestNew_CustomHTTPClient 验证 Options.HTTPClient 注入生效。
func TestNew_CustomHTTPClient(t *testing.T) {
	custom := &http.Client{Timeout: 17 * time.Second}
	c := New("http://x", "u", Options{HTTPClient: custom}).(*client)
	if c.httpClient != custom {
		t.Errorf("HTTPClient not injected")
	}
}

// TestCryptoRandHex 验证默认 eventId 生成器产出非空 32 字符串。
func TestCryptoRandHex(t *testing.T) {
	got := cryptoRandHex()
	if got == "" {
		t.Error("cryptoRandHex returned empty")
	}
	// 16 byte 编码后是 32 字符；fallback 路径以 "ts-" 开头变长，两者都接受。
	if !strings.HasPrefix(got, "ts-") && len(got) != 32 {
		t.Errorf("cryptoRandHex unexpected length: %d %q", len(got), got)
	}
}

// TestTruncate 验证 truncate helper 正确截断。
func TestTruncate(t *testing.T) {
	if got := truncate([]byte("short"), 100); got != "short" {
		t.Errorf("short body: got %q", got)
	}
	long := strings.Repeat("a", 10)
	got := truncate([]byte(long), 5)
	if got != "aaaaa...(truncated)" {
		t.Errorf("truncated body: got %q", got)
	}
}
