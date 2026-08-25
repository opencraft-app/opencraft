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
//
// v1.7.15 B10 起业务数据载荷在顶层 Data 字段（与 returnValue 平级）。
// 入参 returnValue 命名沿用历史（实际是业务 payload 不是数字标志位）。
func envelopeForSuccess(t *testing.T, returnValue any) []byte {
	t.Helper()
	dataRaw, err := json.Marshal(returnValue)
	if err != nil {
		t.Fatalf("marshal data: %v", err)
	}
	rcZero := 0
	env := envelope{
		Version:       json.RawMessage(`"1.0"`),
		EventID:       12345,
		ReturnCode:    &rcZero,
		ReturnMessage: "success",
		Data:          dataRaw,
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
		Version:       json.RawMessage(`"1.0"`),
		EventID:       12345,
		ReturnCode:    &code,
		ReturnMessage: msg,
	}
	b, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	return b
}

// fixedEventIDProvider 返回确定性 eventId（v1.7.4 起 int64），用于断言 framework 字段一致性。
func fixedEventIDProvider() int64 {
	return 0xdeadbeef
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
		seenCaller     string // v1.7.4 新增 — 验证 caller 字段
		seenVersion    json.RawMessage
		seenEventID    int64
		seenTimestamp  int64
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
		seenCaller = env.Caller
		seenEventID = env.EventID
		seenTimestamp = env.Timestamp
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
		_, _ = w.Write(envelopeForSuccess(t, []GetPriceData{
			{
				Price:         "100.00",
				TotalCost:     "100.00",
				RealTotalCost: "80.00",
				Currency:      "CNY",
				PolicyDetail:  &PolicyDetail{Total: 0.8, User: 0.9, Common: 1.0},
				TaxDetail:     &TaxDetail{TaxRate: "0.07"},
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
				GoodsCategoryID: 100059,
				Currency:        "CNY",
				GoodsNum:        1,
				PayMode:         1,
				Action:          "purchase",
				GoodsDetail: map[string]interface{}{
					"productCode":    "p_lighthouse",
					"subProductCode": "sp_lighthouse_bundle_linux_small",
					"pid":            1234,
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
	if resp.Data[0].TaxDetail == nil || resp.Data[0].TaxDetail.TaxRate != "0.07" {
		t.Errorf("TaxDetail.TaxRate: got %+v want 0.07", resp.Data[0].TaxDetail)
	}

	// 请求字段断言
	if seenMethod != http.MethodPost {
		t.Errorf("HTTP method: got %s want POST", seenMethod)
	}
	// v1.7.4 起 client 不再主动注入 Host header（由 clgateway upstream 段重写，Q-INT-11=b）；
	// httptest server 拿到的 Host 是 server.URL 的本地 host:port，不再是 trade.itd.com。
	_ = seenHost
	if seenUserID != "trade-service-uin-100012345678" {
		t.Errorf("x-qcloud-user-id: got %q", seenUserID)
	}
	if string(seenVersion) != `"1.0"` {
		t.Errorf("envelope.version (raw JSON): got %q want %q", string(seenVersion), `"1.0"`)
	}
	if seenComponent != CGWComponentNameLightvela {
		t.Errorf("envelope.componentName: got %q want %q", seenComponent, CGWComponentNameLightvela)
	}
	if seenCaller != CGWComponentNameLightvela {
		t.Errorf("envelope.caller: got %q want %q", seenCaller, CGWComponentNameLightvela)
	}
	if seenInterface != InterfaceNameGetPrice {
		t.Errorf("envelope.interface.interfaceName: got %q want %q", seenInterface, InterfaceNameGetPrice)
	}
	if seenEventID != fixedEventIDProvider() {
		t.Errorf("envelope.eventId: got %d want fixed", seenEventID)
	}
	if seenTimestamp == 0 {
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
		_, _ = w.Write(envelopeForSuccess(t, []GetPriceData{}))
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
		_, _ = w.Write(envelopeForSuccess(t, []GetPriceData{}))
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
		_, _ = w.Write(envelopeForSuccess(t, []GetPriceData{}))
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
		seenCategoryID int64 // Q71：jifei wire 层 GoodsCategoryID 改 int64
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
			seenGoodsLen = len(para.Goods)
			if seenGoodsLen > 0 {
				seenCategoryID = para.Goods[0].GoodsCategoryID
				seenPayMode = para.Goods[0].PayMode
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
		Goods: []GoodsInfo{
			{
				GoodsCategoryID: 100059,
				RegionID:        47,
				ZoneID:          470004,
				GoodsNum:        1,
				PayMode:         1,
				GoodsDetail: map[string]interface{}{
					"productCode":    "p_lighthouse",
					"subProductCode": "sp_lighthouse_bundle_linux_small",
					"pid":            1234,
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
	if seenComponent != CGWComponentNameLightvela {
		t.Errorf("componentName: got %q want %q", seenComponent, CGWComponentNameLightvela)
	}
	if seenParaOwner != "100012345678" {
		t.Errorf("OwnerUin: got %q", seenParaOwner)
	}
	if seenGoodsLen != 1 {
		t.Errorf("GoodsInfos len: got %d", seenGoodsLen)
	}
	if seenCategoryID != 100059 {
		t.Errorf("GoodsCategoryId: got %d", seenCategoryID)
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
		Goods: []GoodsInfo{{GoodsCategoryID: 100059, GoodsNum: 1, PayMode: 1}},
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

// TestRandomEventIDInt64 验证默认 eventId 生成器产出 [1, 2^31) 范围正整数。
//
// 跑 100 次，预期：(a) 全部 > 0；(b) 全部 < 2^31（避开 jifei 网关层 int32 解析边界）；
// (c) 出现至少 50 个不同值（粗略验证随机性）。
func TestRandomEventIDInt64(t *testing.T) {
	const N = 100
	seen := make(map[int64]bool, N)
	for i := 0; i < N; i++ {
		got := randomEventIDInt64()
		if got <= 0 {
			t.Fatalf("randomEventIDInt64 returned non-positive: %d", got)
		}
		if got >= 1<<31 {
			t.Fatalf("randomEventIDInt64 out of int32 range: %d", got)
		}
		seen[got] = true
	}
	if len(seen) < N/2 {
		t.Errorf("randomEventIDInt64 randomness too low: %d unique in %d trials", len(seen), N)
	}
}

// TestEmptyXQCloudUserID_DoesNotSendHeader 验证 v1.7.4 协议校准：
// xQCloudUserID == "" 时（现网场景）client 跳过 x-qcloud-user-id header 注入。
//
// 设计动机：PDF §公共参数 `x-qcloud-user-id` 仅测试环境带（测试 uin 如 700000164995）；
// 现网由部署侧出口 IP 鉴权，不需要带这个 header。
func TestEmptyXQCloudUserID_DoesNotSendHeader(t *testing.T) {
	var (
		seenUserIDPresent bool
		seenUserIDValue   string
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, seenUserIDPresent = r.Header[CGWUserIDHeader]
		seenUserIDValue = r.Header.Get(CGWUserIDHeader)
		_, _ = w.Write(envelopeForSuccess(t, []GetPriceData{}))
	}))
	defer server.Close()

	cli := New(server.URL, "") // 现网场景：xQCloudUserID 空
	_, err := cli.GetPrice(context.Background(), &GetPriceRequest{
		OwnerUin: "1", Uin: "1",
		ResInfo: []GetPriceItem{{Action: "purchase", GoodsNum: 1, PayMode: 1}},
	})
	if err != nil {
		t.Fatalf("GetPrice: %v", err)
	}
	if seenUserIDPresent {
		t.Errorf("v1.7.4: empty xQCloudUserID must not send %s header (got value %q)",
			CGWUserIDHeader, seenUserIDValue)
	}
}

// TestNonEmptyXQCloudUserID_SendsTestUin 验证 v1.7.4 协议校准：
// xQCloudUserID 非空时（测试场景）client 注入 x-qcloud-user-id header = 测试 uin。
func TestNonEmptyXQCloudUserID_SendsTestUin(t *testing.T) {
	const testUin = "700000164995" // PDF §国内站测试环境 配套测试 uin
	var seenUserIDValue string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenUserIDValue = r.Header.Get(CGWUserIDHeader)
		_, _ = w.Write(envelopeForSuccess(t, []GetPriceData{}))
	}))
	defer server.Close()

	cli := New(server.URL, testUin)
	_, err := cli.GetPrice(context.Background(), &GetPriceRequest{
		OwnerUin: "1", Uin: "1",
		ResInfo: []GetPriceItem{{Action: "purchase", GoodsNum: 1, PayMode: 1}},
	})
	if err != nil {
		t.Fatalf("GetPrice: %v", err)
	}
	if seenUserIDValue != testUin {
		t.Errorf("v1.7.4: xQCloudUserID = %q, expected header value %q, got %q",
			testUin, testUin, seenUserIDValue)
	}
}

// TestEnvelopeOmitsSeqID 验证 v1.7.4 协议校准：
// 出向 envelope **不再包含** seqId 字段（PDF §公共参数 注释 "业务调用计费时不用传递"）。
func TestEnvelopeOmitsSeqID(t *testing.T) {
	var bodyStr string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		bodyStr = string(body)
		_, _ = w.Write(envelopeForSuccess(t, []GetPriceData{}))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin")
	_, err := cli.GetPrice(context.Background(), &GetPriceRequest{
		OwnerUin: "1", Uin: "1",
		ResInfo: []GetPriceItem{{Action: "purchase", GoodsNum: 1, PayMode: 1}},
	})
	if err != nil {
		t.Fatalf("GetPrice: %v", err)
	}
	if strings.Contains(bodyStr, `"seqId"`) {
		t.Errorf("v1.7.4 violated: request body contains \"seqId\" field:\n%s", bodyStr)
	}
}

// TestEnvelopeCallerEqualsComponentName 验证 v1.7.4 协议校准：
// 出向 envelope.caller 与 envelope.componentName 同值（PDF §公共参数 caller / componentName
// 描述完全相同，但都是必填字段，jifei 协议不合并）。
func TestEnvelopeCallerEqualsComponentName(t *testing.T) {
	var seenCaller, seenComponent string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var env envelope
		if err := json.Unmarshal(body, &env); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		seenCaller = env.Caller
		seenComponent = env.ComponentName
		_, _ = w.Write(envelopeForSuccess(t, []GetPriceData{}))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin")
	_, err := cli.GetPrice(context.Background(), &GetPriceRequest{
		OwnerUin: "1", Uin: "1",
		ResInfo: []GetPriceItem{{Action: "purchase", GoodsNum: 1, PayMode: 1}},
	})
	if err != nil {
		t.Fatalf("GetPrice: %v", err)
	}
	if seenCaller == "" {
		t.Error("v1.7.4: envelope.caller is empty (PDF requires non-empty)")
	}
	if seenCaller != seenComponent {
		t.Errorf("v1.7.4: caller (%q) must equal componentName (%q)", seenCaller, seenComponent)
	}
	if seenCaller != CGWComponentNameLightvela {
		t.Errorf("v1.7.4: caller = %q, expected %q (lightvela 业务约定)",
			seenCaller, CGWComponentNameLightvela)
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

// ============================================================================
// 8B-1.5: GenerateDealsAndPay tests
// ============================================================================

// TestGenerateDealsAndPay_Success 覆盖一体化下单+支付 happy-path：
//   - interfaceName=qcloud.Deal.generateDealsAndPay、componentName=Deal
//   - PascalCase 字段 OwnerUin / Uin / AppId / AutoVoucher / GoodsInfos[]（与 generateDeals 一致）
//   - 响应 DealNames / BigDealIds / ResourceIds / DealDeliverResults 正确解析
func TestGenerateDealsAndPay_Success(t *testing.T) {
	var (
		seenInterface string
		seenComponent string
		seenPara      GenerateDealsAndPayRequest
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var env envelope
		if err := json.Unmarshal(body, &env); err != nil {
			t.Fatalf("unmarshal envelope: %v", err)
		}
		seenInterface = env.Interface.InterfaceName
		seenComponent = env.ComponentName
		if err := json.Unmarshal(env.Interface.Para, &seenPara); err != nil {
			t.Fatalf("unmarshal para: %v", err)
		}
		_, _ = w.Write(envelopeForSuccess(t, GenerateDealsAndPayResponse{
			DealNames:  []string{"20260509000000001-001"},
			BigDealIDs: []string{"20260509000000001"},
			DealIDs:    []string{"1103944452"},
			ResourceIDs: map[string][]string{
				"20260509000000001-001": {"lhins-abc123"},
			},
			DealDeliverResults: map[string]map[string]interface{}{
				"20260509000000001-001": {"state": "0", "resourceId": []interface{}{"lhins-abc123"}},
			},
		}))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin", Options{
		EventIDProvider: fixedEventIDProvider,
		NowProvider:     fixedNowProvider,
	})
	autoVoucher := 1
	resp, err := cli.GenerateDealsAndPay(context.Background(), &GenerateDealsAndPayRequest{
		OwnerUin:    "100012345678",
		Uin:         "100012345678",
		AppID:       1300012345,
		AutoVoucher: &autoVoucher,
		Goods: []GoodsInfo{
			{
				GoodsCategoryID: 100018,
				RegionID:        8,
				GoodsNum:        1,
				PayMode:         1,
				GoodsDetail: map[string]interface{}{
					"productCode":    "p_lighthouse",
					"subProductCode": "sp_lighthouse_pass",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("GenerateDealsAndPay: %v", err)
	}
	if seenInterface != InterfaceNameGenerateDealsAndPay {
		t.Errorf("interfaceName: got %q want %q", seenInterface, InterfaceNameGenerateDealsAndPay)
	}
	if seenComponent != CGWComponentNameLightvela {
		t.Errorf("componentName: got %q want %q", seenComponent, CGWComponentNameLightvela)
	}
	if seenPara.OwnerUin != "100012345678" || seenPara.Uin != "100012345678" {
		t.Errorf("para owner/uin: %+v", seenPara)
	}
	if seenPara.AppID != 1300012345 {
		t.Errorf("para AppID = %d, want 1300012345", seenPara.AppID)
	}
	if seenPara.AutoVoucher == nil || *seenPara.AutoVoucher != 1 {
		t.Errorf("para AutoVoucher = %v, want *1", seenPara.AutoVoucher)
	}
	if len(seenPara.Goods) != 1 {
		t.Fatalf("para GoodsInfos len = %d", len(seenPara.Goods))
	}
	if seenPara.Goods[0].GoodsCategoryID != 100018 {
		t.Errorf("GoodsCategoryID: %d", seenPara.Goods[0].GoodsCategoryID)
	}
	if len(resp.DealNames) != 1 || resp.DealNames[0] != "20260509000000001-001" {
		t.Errorf("response DealNames: %v", resp.DealNames)
	}
	if len(resp.BigDealIDs) != 1 || resp.BigDealIDs[0] != "20260509000000001" {
		t.Errorf("response BigDealIDs: %v", resp.BigDealIDs)
	}
	if got := resp.ResourceIDs["20260509000000001-001"]; len(got) != 1 || got[0] != "lhins-abc123" {
		t.Errorf("response ResourceIDs: %v", resp.ResourceIDs)
	}
	if state, _ := resp.DealDeliverResults["20260509000000001-001"]["state"].(string); state != "0" {
		t.Errorf("response DealDeliverResults state: %v", resp.DealDeliverResults)
	}
}

// TestGenerateDealsAndPay_AutoVoucherOmittedWhenNil 验证 AutoVoucher = nil 时
// JSON 序列化省略字段（不显式给 jifei 传 0）。
func TestGenerateDealsAndPay_AutoVoucherOmittedWhenNil(t *testing.T) {
	var seenRawPara map[string]json.RawMessage
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var env envelope
		_ = json.Unmarshal(body, &env)
		_ = json.Unmarshal(env.Interface.Para, &seenRawPara)
		_, _ = w.Write(envelopeForSuccess(t, GenerateDealsAndPayResponse{
			DealNames: []string{"d1"}, BigDealIDs: []string{"b1"},
		}))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin")
	_, err := cli.GenerateDealsAndPay(context.Background(), &GenerateDealsAndPayRequest{
		OwnerUin: "1", Uin: "1",
		// AutoVoucher 故意不传
		Goods: []GoodsInfo{{GoodsCategoryID: 100018, GoodsNum: 1, PayMode: 1}},
	})
	if err != nil {
		t.Fatalf("GenerateDealsAndPay: %v", err)
	}
	if _, hasAutoVoucher := seenRawPara["AutoVoucher"]; hasAutoVoucher {
		t.Errorf("AutoVoucher field should be omitted when nil, raw para: %v", seenRawPara)
	}
}

// TestGenerateDealsAndPay_BusinessError 验证业务失败传播 *CGWError，
// 错误码取 PDF §6 的"账户余额不足 100207"。
func TestGenerateDealsAndPay_BusinessError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(envelopeForError(t, 100207, "Balance.Insufficient"))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin")
	_, err := cli.GenerateDealsAndPay(context.Background(), &GenerateDealsAndPayRequest{
		OwnerUin: "1", Uin: "1",
		Goods: []GoodsInfo{{GoodsCategoryID: 100018, GoodsNum: 1, PayMode: 1}},
	})
	if err == nil {
		t.Fatal("expected error")
	}
	var cgwErr *CGWError
	if !errors.As(err, &cgwErr) {
		t.Fatalf("err = %v, want *CGWError", err)
	}
	if cgwErr.ReturnCode != 100207 {
		t.Errorf("ReturnCode: got %d", cgwErr.ReturnCode)
	}
	if cgwErr.InterfaceName != InterfaceNameGenerateDealsAndPay {
		t.Errorf("InterfaceName: got %q", cgwErr.InterfaceName)
	}
}

// TestGenerateDealsAndPay_NilRequest 验证 client-side 入参校验。
func TestGenerateDealsAndPay_NilRequest(t *testing.T) {
	cli := New("http://unused", "trade-uin")
	_, err := cli.GenerateDealsAndPay(context.Background(), nil)
	if err == nil || !strings.Contains(err.Error(), "nil request") {
		t.Errorf("err = %v, want 'nil request'", err)
	}
}

// TestGenerateDealsAndPay_MissingOwnerUin 验证 OwnerUin 必填。
func TestGenerateDealsAndPay_MissingOwnerUin(t *testing.T) {
	cli := New("http://unused", "trade-uin")
	_, err := cli.GenerateDealsAndPay(context.Background(), &GenerateDealsAndPayRequest{
		Uin:   "1",
		Goods: []GoodsInfo{{GoodsCategoryID: 100018, GoodsNum: 1, PayMode: 1}},
	})
	if err == nil || !strings.Contains(err.Error(), "OwnerUin") {
		t.Errorf("err = %v, want 'OwnerUin' substring", err)
	}
}

// TestGenerateDealsAndPay_EmptyGoodsInfos 验证 GoodsInfos 必填。
func TestGenerateDealsAndPay_EmptyGoodsInfos(t *testing.T) {
	cli := New("http://unused", "trade-uin")
	_, err := cli.GenerateDealsAndPay(context.Background(), &GenerateDealsAndPayRequest{
		OwnerUin: "1", Uin: "1",
	})
	if err == nil || !strings.Contains(err.Error(), "Goods") {
		t.Errorf("err = %v, want 'Goods' substring", err)
	}
}

// ============================================================================
// GetMidasEarmarking tests（jifei `qcloud.margin.getMidasEarmarking`）
//
// 协议依据：PDF §4 入参 / §5 出参 / §6 错误码。注意 componentName="MC"（米大师 Midas Center
// 简写）与 interfaceName 的第二段 "margin" 命名不对齐 — 是 jifei 历史遗留命名（MC 是 jifei
// 内部模块码，margin 是云 API 别名命名），按 PDF curl 实例值写。
// ============================================================================

func TestGetMidasEarmarking_Success(t *testing.T) {
	var (
		seenInterface string
		seenComponent string
		seenPara      GetMidasEarmarkingRequest
	)
	tokenID := "E-260522160125881056"
	outTradeNo := "20260522995022875780461"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var env envelope
		if err := json.Unmarshal(body, &env); err != nil {
			t.Fatalf("unmarshal envelope: %v", err)
		}
		seenInterface = env.Interface.InterfaceName
		seenComponent = env.ComponentName
		if err := json.Unmarshal(env.Interface.Para, &seenPara); err != nil {
			t.Fatalf("unmarshal para: %v", err)
		}
		_, _ = w.Write(envelopeForSuccess(t, GetMidasEarmarkingResponse{
			BillID:     "20260509-bill-001",
			URL:        "https://buy.cloud.tencent.com/midas/cashier?token=xyz",
			AppID:      "1000029101",
			NeedCharge: 1,
			TokenID:    &tokenID,
			OutTradeNo: &outTradeNo,
			DealNames:  []string{"20260509000000001-001"},
			BigDealIDs: []string{"20260509000000001"},
		}))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin", Options{
		EventIDProvider: fixedEventIDProvider,
		NowProvider:     fixedNowProvider,
	})
	resp, err := cli.GetMidasEarmarking(context.Background(), &GetMidasEarmarkingRequest{
		OwnerUin:  "100012345678",
		Uin:       "100012345678",
		DealNames: []string{"20260509000000001-001"},
		CancelURL: "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe?pay=cancel",
		ReturnURL: "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe?pay=return",
	})
	if err != nil {
		t.Fatalf("GetMidasEarmarking: %v", err)
	}
	if seenInterface != InterfaceNameGetMidasEarmarking {
		t.Errorf("interfaceName: got %q want %q", seenInterface, InterfaceNameGetMidasEarmarking)
	}
	if seenComponent != CGWComponentNameLightvela {
		t.Errorf("componentName: got %q want %q", seenComponent, CGWComponentNameLightvela)
	}
	if seenPara.OwnerUin != "100012345678" || seenPara.Uin != "100012345678" {
		t.Errorf("para owner/uin: %+v", seenPara)
	}
	if len(seenPara.DealNames) != 1 || seenPara.DealNames[0] != "20260509000000001-001" {
		t.Errorf("para DealNames: %v", seenPara.DealNames)
	}
	if seenPara.CancelURL != "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe?pay=cancel" {
		t.Errorf("para CancelURL: %q", seenPara.CancelURL)
	}
	if seenPara.ReturnURL != "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe?pay=return" {
		t.Errorf("para ReturnURL: %q", seenPara.ReturnURL)
	}
	if resp.URL != "https://buy.cloud.tencent.com/midas/cashier?token=xyz" {
		t.Errorf("response URL: %q", resp.URL)
	}
	if resp.BillID != "20260509-bill-001" {
		t.Errorf("response BillID: %q", resp.BillID)
	}
	if resp.AppID != "1000029101" {
		t.Errorf("response AppID: %q", resp.AppID)
	}
	if resp.NeedCharge != 1 {
		t.Errorf("response NeedCharge: %d", resp.NeedCharge)
	}
	// 协议外字段（PDF 未列、实测稳定返）：要求按指针返回，便于业务层区分 "jifei 未返" vs "jifei 返空串"
	if resp.TokenID == nil || *resp.TokenID != tokenID {
		t.Errorf("response TokenID: got %v, want %q", resp.TokenID, tokenID)
	}
	if resp.OutTradeNo == nil || *resp.OutTradeNo != outTradeNo {
		t.Errorf("response OutTradeNo: got %v, want %q", resp.OutTradeNo, outTradeNo)
	}
	if len(resp.DealNames) != 1 || resp.DealNames[0] != "20260509000000001-001" {
		t.Errorf("response DealNames: %v", resp.DealNames)
	}
	if len(resp.BigDealIDs) != 1 || resp.BigDealIDs[0] != "20260509000000001" {
		t.Errorf("response BigDealIDs: %v", resp.BigDealIDs)
	}
}

func TestGetMidasEarmarking_ContractPayFieldsUseCGWLowerCamelCase(t *testing.T) {
	var body string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		body = string(raw)
		_, _ = w.Write(envelopeForSuccess(t, GetMidasEarmarkingResponse{
			URL:        "https://buy.cloud.tencent.com/midas/contract",
			NeedCharge: 1,
		}))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin", Options{
		EventIDProvider: fixedEventIDProvider,
		NowProvider:     fixedNowProvider,
	})
	_, err := cli.GetMidasEarmarking(context.Background(), &GetMidasEarmarkingRequest{
		OwnerUin:      "100012345678",
		Uin:           "100012345678",
		DealNames:     []string{"20260509000000001-001"},
		ContractOrder: 1,
		PayScene:      "credit_card",
	})
	if err != nil {
		t.Fatalf("GetMidasEarmarking: %v", err)
	}
	if !jsonBodyHasField(t, body, "contractOrder") {
		t.Fatalf("request body missing contractOrder: %s", body)
	}
	if !jsonBodyHasField(t, body, "payScene") {
		t.Fatalf("request body missing payScene: %s", body)
	}
	if jsonBodyHasField(t, body, "ContractOrder") || jsonBodyHasField(t, body, "PayScene") {
		t.Fatalf("CGW fields must use lowerCamelCase, got body: %s", body)
	}
}

func jsonBodyHasField(t *testing.T, body, field string) bool {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		t.Fatalf("unmarshal json body: %v", err)
	}
	return jsonValueHasField(v, field)
}

func jsonValueHasField(v any, field string) bool {
	switch typed := v.(type) {
	case map[string]any:
		for k, child := range typed {
			if k == field {
				return true
			}
			if jsonValueHasField(child, field) {
				return true
			}
		}
	case []any:
		for _, child := range typed {
			if jsonValueHasField(child, field) {
				return true
			}
		}
	}
	return false
}

// TestGetMidasEarmarking_RealProductionPayload 用一份 2026-05-23 北京 trade 联调环境
// (`/data/lightvela-bj-trade-cls-config`) 实测捕获的真实回包做 fixture，验证 jifei 协议外
// 字段（tokenId / outTradeNo / dealNames / bigDealIds / dealDeliverResults）能正确解析。
//
// 真实日志条目：trade-5dfdfdd467-4hgfs `[jifei-in] interface=qcloud.margin.getMidasEarmarking
// eventId=1783588984 ... status=200 body=...`（uin 已脱敏为 700000164995 占位 — 实际就是
// 联调用户 uin，不视为敏感信息）。
//
// 此用例的目的是 future-proof：如果将来有人按 PDF 协议把"未列字段"删了，本用例会立即挂掉。
func TestGetMidasEarmarking_RealProductionPayload(t *testing.T) {
	// 实测 jifei `data` 字段原文（见上方注释来源），保持原样以便断言字段映射准确。
	const realData = `{
		"appid": "1450008583",
		"url": "/v1/r/1450008583/qz_goods_info?transaction_id=E-260522160125881056&token_id=E-260522160125881056&pf=midas_group_pay-1000-html5-1000&out_trade_no=20260522995022875780461&deploy_env=stable",
		"tokenId": "E-260522160125881056",
		"billId": "20260522995022875780461",
		"outTradeNo": "20260522995022875780461",
		"needCharge": 1,
		"dealNames": ["20260522995022875821661"],
		"dealDeliverResults": {
			"20260522995022875821661": {"state":"1","resourceId":null}
		},
		"bigDealIds": ["20260522995022875821651"]
	}`

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rcZero := 0
		env := envelope{
			Version:       json.RawMessage(`"1.0"`),
			EventID:       1783588984,
			ReturnCode:    &rcZero,
			ReturnMessage: "ok",
			Data:          json.RawMessage(realData),
		}
		b, _ := json.Marshal(env)
		_, _ = w.Write(b)
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin")
	resp, err := cli.GetMidasEarmarking(context.Background(), &GetMidasEarmarkingRequest{
		OwnerUin:  "700000164995",
		Uin:       "700000164995",
		DealNames: []string{"20260522995022875821661"},
	})
	if err != nil {
		t.Fatalf("GetMidasEarmarking: %v", err)
	}

	// PDF 协议字段
	if resp.AppID != "1450008583" {
		t.Errorf("AppID: %q", resp.AppID)
	}
	if !strings.Contains(resp.URL, "transaction_id=E-260522160125881056") {
		t.Errorf("URL: %q", resp.URL)
	}
	if resp.BillID != "20260522995022875780461" {
		t.Errorf("BillID: %q", resp.BillID)
	}
	if resp.NeedCharge != 1 {
		t.Errorf("NeedCharge: %d", resp.NeedCharge)
	}

	// 协议外字段（关键点）
	if resp.TokenID == nil || *resp.TokenID != "E-260522160125881056" {
		t.Errorf("TokenID: %v", resp.TokenID)
	}
	if resp.OutTradeNo == nil || *resp.OutTradeNo != "20260522995022875780461" {
		t.Errorf("OutTradeNo: %v", resp.OutTradeNo)
	}
	if len(resp.DealNames) != 1 || resp.DealNames[0] != "20260522995022875821661" {
		t.Errorf("DealNames: %v", resp.DealNames)
	}
	if len(resp.BigDealIDs) != 1 || resp.BigDealIDs[0] != "20260522995022875821651" {
		t.Errorf("BigDealIDs: %v", resp.BigDealIDs)
	}
	if len(resp.DealDeliverResults) != 1 {
		t.Errorf("DealDeliverResults len: %d", len(resp.DealDeliverResults))
	}
	if got, ok := resp.DealDeliverResults["20260522995022875821661"]; !ok {
		t.Errorf("DealDeliverResults missing key for dealName")
	} else {
		if got.State != "1" {
			t.Errorf("DealDeliverResults.State: %q", got.State)
		}
		if got.ResourceID != nil {
			t.Errorf("DealDeliverResults.ResourceID: want nil, got %v", got.ResourceID)
		}
	}
}

// TestGetMidasEarmarking_OptionalFieldsMissing 验证 D3 兜底契约：当 jifei 回包没有
// PDF 协议外字段时（例如未来灰度变更或非 pc 通道回包），业务层应拿到 nil / 零长切片，
// 而不是把 ""/0 误当作有效值。
func TestGetMidasEarmarking_OptionalFieldsMissing(t *testing.T) {
	// 仅返 PDF 协议规定的 4 个字段
	const minimalData = `{
		"billId": "bill-only",
		"url": "https://buy.cloud.tencent.com/midas/minimal",
		"appid": "1000029101",
		"needCharge": 0
	}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rcZero := 0
		env := envelope{
			Version:       json.RawMessage(`"1.0"`),
			EventID:       1,
			ReturnCode:    &rcZero,
			ReturnMessage: "ok",
			Data:          json.RawMessage(minimalData),
		}
		b, _ := json.Marshal(env)
		_, _ = w.Write(b)
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin")
	resp, err := cli.GetMidasEarmarking(context.Background(), &GetMidasEarmarkingRequest{
		OwnerUin:  "1",
		Uin:       "1",
		DealNames: []string{"deal-1"},
	})
	if err != nil {
		t.Fatalf("GetMidasEarmarking: %v", err)
	}
	if resp.TokenID != nil {
		t.Errorf("TokenID: want nil, got %v", *resp.TokenID)
	}
	if resp.OutTradeNo != nil {
		t.Errorf("OutTradeNo: want nil, got %v", *resp.OutTradeNo)
	}
	if len(resp.DealNames) != 0 {
		t.Errorf("DealNames: want empty, got %v", resp.DealNames)
	}
	if len(resp.BigDealIDs) != 0 {
		t.Errorf("BigDealIDs: want empty, got %v", resp.BigDealIDs)
	}
	if len(resp.DealDeliverResults) != 0 {
		t.Errorf("DealDeliverResults: want empty, got %v", resp.DealDeliverResults)
	}
}

func TestGetMidasEarmarking_BusinessError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// PDF §6：100151 资源锁占用（typical）
		_, _ = w.Write(envelopeForError(t, 100151, "Resource.LockConflict"))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin")
	_, err := cli.GetMidasEarmarking(context.Background(), &GetMidasEarmarkingRequest{
		OwnerUin:  "100012345678",
		Uin:       "100012345678",
		DealNames: []string{"deal-1"},
	})
	if err == nil {
		t.Fatalf("expected business error")
	}
	var cgwErr *CGWError
	if !errors.As(err, &cgwErr) {
		t.Fatalf("expected *CGWError, got %T: %v", err, err)
	}
	if cgwErr.ReturnCode != 100151 {
		t.Errorf("ReturnCode: got %d, want 100151", cgwErr.ReturnCode)
	}
	if cgwErr.InterfaceName != InterfaceNameGetMidasEarmarking {
		t.Errorf("InterfaceName: got %q", cgwErr.InterfaceName)
	}
}

func TestGetMidasEarmarking_HTTPNon200(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin")
	_, err := cli.GetMidasEarmarking(context.Background(), &GetMidasEarmarkingRequest{
		OwnerUin:  "1",
		Uin:       "1",
		DealNames: []string{"deal-1"},
	})
	if err == nil {
		t.Fatalf("expected HTTP error")
	}
	if !errors.Is(err, ErrCGWHTTPNon200) {
		t.Errorf("expected ErrCGWHTTPNon200, got %v", err)
	}
}

func TestGetMidasEarmarking_NilRequest(t *testing.T) {
	cli := New("http://unused", "trade-uin")
	_, err := cli.GetMidasEarmarking(context.Background(), nil)
	if err == nil || !strings.Contains(err.Error(), "nil request") {
		t.Errorf("err = %v, want 'nil request'", err)
	}
}

func TestGetMidasEarmarking_MissingOwnerUin(t *testing.T) {
	cli := New("http://unused", "trade-uin")
	_, err := cli.GetMidasEarmarking(context.Background(), &GetMidasEarmarkingRequest{
		Uin:       "1",
		DealNames: []string{"deal-1"},
	})
	if err == nil || !strings.Contains(err.Error(), "OwnerUin") {
		t.Errorf("err = %v, want 'OwnerUin' substring", err)
	}
}

func TestGetMidasEarmarking_EmptyDealNames(t *testing.T) {
	cli := New("http://unused", "trade-uin")
	_, err := cli.GetMidasEarmarking(context.Background(), &GetMidasEarmarkingRequest{
		OwnerUin: "1",
		Uin:      "1",
	})
	if err == nil || !strings.Contains(err.Error(), "DealNames") {
		t.Errorf("err = %v, want 'DealNames' substring", err)
	}
}

func TestGetMidasEarmarking_DealNamesContainsEmpty(t *testing.T) {
	cli := New("http://unused", "trade-uin")
	_, err := cli.GetMidasEarmarking(context.Background(), &GetMidasEarmarkingRequest{
		OwnerUin:  "1",
		Uin:       "1",
		DealNames: []string{"deal-1", "", "deal-3"},
	})
	if err == nil || !strings.Contains(err.Error(), "DealNames[1]") {
		t.Errorf("err = %v, want 'DealNames[1]' substring (empty element)", err)
	}
}

// TestTransactionIDHeader_Injected 验证 v1.7.28 BUG-05 排障引入的 transaction_id 链路追踪 header：
// 每次出向请求注入 X-QCloud-Transaction-ID (32 字符 hex) + X-QCloud-Component-ID = "lightclaw.trade"。
func TestTransactionIDHeader_Injected(t *testing.T) {
	var (
		seenTransactionID string
		seenComponentID   string
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenTransactionID = r.Header.Get(CGWTransactionIDHeader)
		seenComponentID = r.Header.Get(CGWComponentIDHeader)
		_, _ = w.Write(envelopeForSuccess(t, []GetPriceData{}))
	}))
	defer server.Close()

	cli := New(server.URL, "")
	_, err := cli.GetPrice(context.Background(), &GetPriceRequest{
		OwnerUin: "1", Uin: "1",
		ResInfo: []GetPriceItem{{Action: "purchase", GoodsNum: 1, PayMode: 1}},
	})
	if err != nil {
		t.Fatalf("GetPrice: %v", err)
	}
	if len(seenTransactionID) != 32 {
		t.Errorf("v1.7.28 transaction_id header: len = %d, want 32 (hex of 16 bytes)", len(seenTransactionID))
	}
	// 校验 hex 格式（仅 [0-9a-f]）
	for _, c := range seenTransactionID {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			t.Errorf("v1.7.28 transaction_id %q contains non-hex char %q", seenTransactionID, c)
			break
		}
	}
	if seenComponentID != CGWComponentIDValue {
		t.Errorf("v1.7.28 component_id header: got %q, want %q", seenComponentID, CGWComponentIDValue)
	}
}

// TestTransactionIDHeader_UniquePerRequest 验证每次请求生成新 transaction_id (避免静态值导致
// jifei 侧链路追踪误聚合不同请求)。
func TestTransactionIDHeader_UniquePerRequest(t *testing.T) {
	seen := make(map[string]struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen[r.Header.Get(CGWTransactionIDHeader)] = struct{}{}
		_, _ = w.Write(envelopeForSuccess(t, []GetPriceData{}))
	}))
	defer server.Close()

	cli := New(server.URL, "")
	for i := 0; i < 10; i++ {
		_, err := cli.GetPrice(context.Background(), &GetPriceRequest{
			OwnerUin: "1", Uin: "1",
			ResInfo: []GetPriceItem{{Action: "purchase", GoodsNum: 1, PayMode: 1}},
		})
		if err != nil {
			t.Fatalf("GetPrice iteration %d: %v", i, err)
		}
	}
	if len(seen) != 10 {
		t.Errorf("v1.7.28 transaction_id should be unique per request: got %d unique values across 10 requests, want 10", len(seen))
	}
}

// TestCGWErrorIncludesTransactionID 验证 jifei 返 returnCode != 0 时 CGWError.TransactionID
// 被填充, 上层日志能拿到 transaction_id 报给 jifei 同事追查。
func TestCGWErrorIncludesTransactionID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 返业务错误 returnCode=700002 模拟 BUG-05 场景
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":"1.0","returnCode":700002,"returnMessage":"rc check failed"}`))
	}))
	defer server.Close()

	cli := New(server.URL, "")
	_, err := cli.GetPrice(context.Background(), &GetPriceRequest{
		OwnerUin: "1", Uin: "1",
		ResInfo: []GetPriceItem{{Action: "purchase", GoodsNum: 1, PayMode: 1}},
	})
	if err == nil {
		t.Fatalf("expected CGWError returnCode=700002, got nil")
	}
	var cgwErr *CGWError
	if !errors.As(err, &cgwErr) {
		t.Fatalf("expected *CGWError, got %T: %v", err, err)
	}
	if cgwErr.ReturnCode != 700002 {
		t.Errorf("ReturnCode = %d, want 700002", cgwErr.ReturnCode)
	}
	if len(cgwErr.TransactionID) != 32 {
		t.Errorf("v1.7.28 CGWError.TransactionID len = %d, want 32", len(cgwErr.TransactionID))
	}
	// Error() 输出应含 transactionId
	if !strings.Contains(err.Error(), "transactionId="+cgwErr.TransactionID) {
		t.Errorf("Error() should contain transactionId=<value>, got %q", err.Error())
	}
}
