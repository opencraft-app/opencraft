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
)

// TestGetDealsByKeyIndex_Success 覆盖 happy-path（v1.7.32 引入）：
//   - HTTP 请求方法 / framework interfaceName / componentName 正确
//   - request body 内 para.cond.dealName 字段正确
//   - 响应反序列化到 GetDealsByKeyIndexResponse 后 totalNum / deals[0].status 正确
//   - status=5 (finished) 走 int 数值兼容路径
func TestGetDealsByKeyIndex_Success(t *testing.T) {
	var (
		seenMethod    string
		seenInterface string
		seenComponent string
		seenDealName  string
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenMethod = r.Method

		body, _ := io.ReadAll(r.Body)
		var env envelope
		if err := json.Unmarshal(body, &env); err != nil {
			t.Fatalf("unmarshal request envelope: %v", err)
		}
		seenComponent = env.ComponentName
		if env.Interface != nil {
			seenInterface = env.Interface.InterfaceName
			var para GetDealsByKeyIndexRequest
			if err := json.Unmarshal(env.Interface.Para, &para); err != nil {
				t.Fatalf("unmarshal para: %v", err)
			}
			seenDealName = para.Cond.DealName
		}

		// 响应：status=5 finished，int 数值形态
		resp := GetDealsByKeyIndexResponse{
			TotalNum: 1,
			Deals: []DealQueryItem{{
				DealName:       "20260528112233000001",
				BigDealID:      "BIG20260528001",
				ProductCode:    "p_lighthouse",
				SubProductCode: "sp_pass_subscription",
				Status:         flexInt(JifeiDealStatusFinished),
			}},
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(envelopeForSuccess(t, resp))
	}))
	defer server.Close()

	c := New(server.URL, "700000164995", Options{
		EventIDProvider: fixedEventIDProvider,
		NowProvider:     fixedNowProvider,
	})

	got, err := c.GetDealsByKeyIndex(context.Background(), &GetDealsByKeyIndexRequest{
		Cond: GetDealsByKeyIndexCond{DealName: "20260528112233000001"},
	})
	if err != nil {
		t.Fatalf("GetDealsByKeyIndex: %v", err)
	}

	// HTTP / framework 断言
	if seenMethod != http.MethodPost {
		t.Errorf("method = %q, want POST", seenMethod)
	}
	if seenInterface != InterfaceNameGetDealsByKeyIndex {
		t.Errorf("interfaceName = %q, want %q", seenInterface, InterfaceNameGetDealsByKeyIndex)
	}
	if seenComponent != ComponentNameDeal {
		t.Errorf("componentName = %q, want %q", seenComponent, ComponentNameDeal)
	}
	if seenDealName != "20260528112233000001" {
		t.Errorf("para.cond.dealName = %q, want 20260528112233000001", seenDealName)
	}

	// 响应断言
	if got.TotalNum != 1 {
		t.Errorf("totalNum = %d, want 1", got.TotalNum)
	}
	if len(got.Deals) != 1 {
		t.Fatalf("deals len = %d, want 1", len(got.Deals))
	}
	if int(got.Deals[0].Status) != JifeiDealStatusFinished {
		t.Errorf("deals[0].status = %d, want %d (finished)", got.Deals[0].Status, JifeiDealStatusFinished)
	}
	if got.Deals[0].DealName != "20260528112233000001" {
		t.Errorf("deals[0].dealName = %q", got.Deals[0].DealName)
	}
}

// TestGetDealsByKeyIndex_FlexIntStringForm 覆盖 jifei 协议字段类型不稳定 (B12 范式)：
//   - jifei 实测有时回 `"status": "6"` 字符串形态
//   - flexInt 必须能正确解析为 int(6) (canceled)
func TestGetDealsByKeyIndex_FlexIntStringForm(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 直接手工构造 deals[].status 为字符串 "6" 的回包（不走 envelopeForSuccess + struct
		// 路径，因为 flexInt.MarshalJSON 总是输出 number；这里用 RawMessage 模拟 jifei 真实
		// string-encoded int 回包形态）。
		raw := `{"version":"1.0","eventId":12345,"returnCode":0,"returnMessage":"success","data":{"totalNum":1,"deals":[{"dealName":"D1","bigDealId":"B1","productCode":"p","subProductCode":"sp","status":"6"}]}}`
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(raw))
	}))
	defer server.Close()

	c := New(server.URL, "", Options{EventIDProvider: fixedEventIDProvider, NowProvider: fixedNowProvider})

	got, err := c.GetDealsByKeyIndex(context.Background(), &GetDealsByKeyIndexRequest{
		Cond: GetDealsByKeyIndexCond{DealName: "D1"},
	})
	if err != nil {
		t.Fatalf("GetDealsByKeyIndex: %v", err)
	}
	if int(got.Deals[0].Status) != JifeiDealStatusCanceled {
		t.Errorf("string-encoded status: got %d, want %d (canceled)", got.Deals[0].Status, JifeiDealStatusCanceled)
	}
}

// TestGetDealsByKeyIndex_FlexIntNullAndEmpty 覆盖 jifei 偶发回 null / 空字符串 status：
//   - 必须解析为 0（业务层按"未知中态"处理）
//   - 不应返 unmarshal 错误
func TestGetDealsByKeyIndex_FlexIntNullAndEmpty(t *testing.T) {
	cases := []struct {
		name      string
		statusRaw string
	}{
		{"null", `null`},
		{"empty-string", `""`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				raw := `{"version":"1.0","eventId":12345,"returnCode":0,"returnMessage":"success","data":{"totalNum":1,"deals":[{"dealName":"D1","bigDealId":"B1","status":` + tc.statusRaw + `}]}}`
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(raw))
			}))
			defer server.Close()

			c := New(server.URL, "", Options{EventIDProvider: fixedEventIDProvider, NowProvider: fixedNowProvider})

			got, err := c.GetDealsByKeyIndex(context.Background(), &GetDealsByKeyIndexRequest{
				Cond: GetDealsByKeyIndexCond{DealName: "D1"},
			})
			if err != nil {
				t.Fatalf("GetDealsByKeyIndex: %v", err)
			}
			if int(got.Deals[0].Status) != 0 {
				t.Errorf("status = %d, want 0", got.Deals[0].Status)
			}
		})
	}
}

// TestGetDealsByKeyIndex_BusinessError 验证 returnCode != 0 时返回 *CGWError，
// 调用方可以 errors.As 提取（与 GetPrice / GenerateDeals 错误模型一致）。
func TestGetDealsByKeyIndex_BusinessError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(envelopeForError(t, 100207, "余额不足"))
	}))
	defer server.Close()

	c := New(server.URL, "", Options{EventIDProvider: fixedEventIDProvider, NowProvider: fixedNowProvider})

	_, err := c.GetDealsByKeyIndex(context.Background(), &GetDealsByKeyIndexRequest{
		Cond: GetDealsByKeyIndexCond{DealName: "D1"},
	})
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	var cgwErr *CGWError
	if !errors.As(err, &cgwErr) {
		t.Fatalf("err is not *CGWError: %T %v", err, err)
	}
	if cgwErr.ReturnCode != 100207 {
		t.Errorf("ReturnCode = %d, want 100207", cgwErr.ReturnCode)
	}
	if cgwErr.InterfaceName != InterfaceNameGetDealsByKeyIndex {
		t.Errorf("InterfaceName = %q", cgwErr.InterfaceName)
	}
}

// TestGetDealsByKeyIndex_HTTPNon200 验证 HTTP 502 → ErrCGWHTTPNon200。
func TestGetDealsByKeyIndex_HTTPNon200(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("upstream down"))
	}))
	defer server.Close()

	c := New(server.URL, "", Options{EventIDProvider: fixedEventIDProvider, NowProvider: fixedNowProvider})

	_, err := c.GetDealsByKeyIndex(context.Background(), &GetDealsByKeyIndexRequest{
		Cond: GetDealsByKeyIndexCond{DealName: "D1"},
	})
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !errors.Is(err, ErrCGWHTTPNon200) {
		t.Fatalf("err not wrap ErrCGWHTTPNon200: %v", err)
	}
}

// TestGetDealsByKeyIndex_InvalidArg 覆盖 client-side 校验：
//   - nil request
//   - cond 三字段全空
func TestGetDealsByKeyIndex_InvalidArg(t *testing.T) {
	c := New("http://unused", "", Options{EventIDProvider: fixedEventIDProvider, NowProvider: fixedNowProvider})

	t.Run("nil-request", func(t *testing.T) {
		_, err := c.GetDealsByKeyIndex(context.Background(), nil)
		if err == nil || !strings.Contains(err.Error(), "nil request") {
			t.Fatalf("want nil-request err, got %v", err)
		}
	})

	t.Run("empty-cond", func(t *testing.T) {
		_, err := c.GetDealsByKeyIndex(context.Background(), &GetDealsByKeyIndexRequest{})
		if err == nil || !strings.Contains(err.Error(), "all empty") {
			t.Fatalf("want empty-cond err, got %v", err)
		}
	})
}

// TestFlexInt_UnmarshalJSON 是 flexInt 类型的纯单元测试，覆盖 4 种输入形态：
//   - JSON int (`6`) → 6
//   - JSON string-encoded int (`"6"`) → 6
//   - JSON null (`null`) → 0
//   - JSON empty string (`""`) → 0
//   - JSON 非法 string (`"foo"`) → error
func TestFlexInt_UnmarshalJSON(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		want    int
		wantErr bool
	}{
		{"int-bare", `6`, 6, false},
		{"int-zero", `0`, 0, false},
		{"int-100", `100`, 100, false},
		{"string-encoded", `"6"`, 6, false},
		{"string-zero", `"0"`, 0, false},
		{"null", `null`, 0, false},
		{"empty-string", `""`, 0, false},
		{"bogus-string", `"foo"`, 0, true},
		{"bogus-bool", `true`, 0, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var f flexInt
			err := json.Unmarshal([]byte(tc.input), &f)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("input %q: want error, got nil (f=%d)", tc.input, f)
				}
				return
			}
			if err != nil {
				t.Fatalf("input %q: unexpected err %v", tc.input, err)
			}
			if int(f) != tc.want {
				t.Errorf("input %q: got %d, want %d", tc.input, f, tc.want)
			}
		})
	}
}

// TestFlexInt_MarshalJSON 验证 flexInt 总是序列化为 JSON number（不带引号），
// 这样测试 helper envelopeForSuccess + DealQueryItem{Status: flexInt(5)} 能正确工作。
func TestFlexInt_MarshalJSON(t *testing.T) {
	cases := []struct {
		val  flexInt
		want string
	}{
		{flexInt(0), `0`},
		{flexInt(5), `5`},
		{flexInt(100), `100`},
	}
	for _, tc := range cases {
		got, err := json.Marshal(tc.val)
		if err != nil {
			t.Fatalf("marshal flexInt(%d): %v", tc.val, err)
		}
		if string(got) != tc.want {
			t.Errorf("flexInt(%d): got %s, want %s", tc.val, got, tc.want)
		}
	}
}

// TestGetDealsByKeyIndex_TotalNumStringForm 是 v1.7.33 BUG-25 回归测试：
//
// **背景**：v1.7.32 联调（2026-06-01 sandbox-bj-7）实测发现 jifei CGW 实际回包里 `totalNum`
// 字段是 string-encoded int (`"totalNum": "1"`) 而非 PDF 协议规定的 int。修复前 TotalNum 字段
// 类型是 `int`，遇到 string 值会触发 `json: cannot unmarshal string into Go struct field
// GetDealsByKeyIndexResponse.totalNum of type int`，B7 fallback 兜底但前端拿不到 jifei 真实
// 状态。
//
// **修复**：TotalNum 改为 flexInt（同 Status 字段范式）。本测试用 jifei 真实沙箱实测回包形态
// 验证修复有效。
func TestGetDealsByKeyIndex_TotalNumStringForm(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// jifei 实测回包形态：totalNum="1" 字符串、status="1" 字符串。
		raw := `{"version":"1.0","eventId":12345,"returnCode":0,"returnMessage":"success","data":{"totalNum":"1","deals":[{"dealName":"D1","bigDealId":"B1","productCode":"p","subProductCode":"sp","status":"1"}]}}`
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(raw))
	}))
	defer server.Close()

	c := New(server.URL, "", Options{EventIDProvider: fixedEventIDProvider, NowProvider: fixedNowProvider})

	got, err := c.GetDealsByKeyIndex(context.Background(), &GetDealsByKeyIndexRequest{
		Cond: GetDealsByKeyIndexCond{DealName: "D1"},
	})
	if err != nil {
		t.Fatalf("BUG-25 not fixed: TotalNum string form should be tolerated, got err: %v", err)
	}
	if int(got.TotalNum) != 1 {
		t.Errorf("totalNum (string form) = %d, want 1", got.TotalNum)
	}
	if len(got.Deals) != 1 || int(got.Deals[0].Status) != JifeiDealStatusInit {
		t.Errorf("deals[0].status (string form) = %d, want %d (init)", got.Deals[0].Status, JifeiDealStatusInit)
	}
}

// TestGetDealsByKeyIndex_RealJifeiSandboxResponse 用 sandbox-bj-7 联调实测抓到的
// 完整 jifei 回包做端到端解码验证（2026-06-01 06:39:47 抓自 trade pod log）：
//
// 关键点：除了 totalNum / status 是 string-encoded int 外，goodsNum / regionId / appId /
// platform / dealType / payMode 等数值字段也都是 string（jifei CGW 历史协议偏好）。
// 业务层只关心 dealName / bigDealId / status，这些 string 字段透传不读，保留原样兼容。
func TestGetDealsByKeyIndex_RealJifeiSandboxResponse(t *testing.T) {
	// 真实 jifei 沙箱回包（2026-06-01 sandbox-bj-7 trade pod log 抓取，敏感字段已脱敏保留结构）。
	realResp := `{"version":1,"componentName":"trade","timestamp":1780295987,"eventId":1971394077,` +
		`"returnValue":0,"returnCode":0,"returnMessage":"ok","data":{"totalNum":"1","deals":[{` +
		`"dealId":"1174149306","dealName":"20260526995022902730171","bigDealId":"20260526995022902730161",` +
		`"goodsCategoryId":"2025046","ownerUin":"700000164995","platform":"1","regionId":"1",` +
		`"appId":"251202221","goodsNum":"1","status":"1","payMode":"1","dealType":"8","totalCost":"4900",` +
		`"realTotalCost":"4900","price":"4900"}]},"seqId":"ldsp461l-368u-xqtf-zusz-od74zyj1qkpd"}`

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(realResp))
	}))
	defer server.Close()

	c := New(server.URL, "", Options{EventIDProvider: fixedEventIDProvider, NowProvider: fixedNowProvider})

	got, err := c.GetDealsByKeyIndex(context.Background(), &GetDealsByKeyIndexRequest{
		Cond: GetDealsByKeyIndexCond{DealName: "20260526995022902730171"},
	})
	if err != nil {
		t.Fatalf("BUG-25 regression: real jifei sandbox response should decode, got err: %v", err)
	}
	if int(got.TotalNum) != 1 {
		t.Errorf("totalNum = %d, want 1", got.TotalNum)
	}
	if len(got.Deals) != 1 {
		t.Fatalf("deals len = %d, want 1", len(got.Deals))
	}
	if got.Deals[0].DealName != "20260526995022902730171" {
		t.Errorf("dealName = %q", got.Deals[0].DealName)
	}
	if got.Deals[0].BigDealID != "20260526995022902730161" {
		t.Errorf("bigDealId = %q", got.Deals[0].BigDealID)
	}
	if int(got.Deals[0].Status) != JifeiDealStatusInit {
		t.Errorf("status = %d, want %d (init=1)", got.Deals[0].Status, JifeiDealStatusInit)
	}
}
