// trade pass 退款链路 OnlineRefund 单测（trade-pass-refund-design.md v0.5 §8 commit 1）。
//
// 协议依据：/root/project/mono/.tmp/线上退设备退款.doc §4.1 + §4.2 + §5 + §6.1
//
// 复用本包既有 envelopeForSuccess / envelopeForError / fixedEventIDProvider /
// fixedNowProvider helper（见 client_test.go），与 modifyresourcestatus_test.go 同款范式。
package jifeiclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// TestOnlineRefund_Success 覆盖 happy-path：
//   - HTTP request method / x-qcloud-user-id 正确
//   - envelope 顶层 7 字段正确（version / componentName / caller / eventId / timestamp / interface.interfaceName）
//   - request body para 字段（camelCase JSON tag）按 doc §4.1 完整发出
//   - request body 含 interface.auth 4 字段（与 ModifyResourceStatus 同款 Q-D-SIG-1~6 签名链路）
//   - signature 本地重算与客户端一致（验证算法对齐）
//   - **goodsInfo wire 形态**：map key 是 sub_product_code 字符串（"sp_lighthouse"）
//   - 响应 data.dealNames / data.bigDealIds 反序列化正确
func TestOnlineRefund_Success(t *testing.T) {
	var (
		seenMethod    string
		seenUserID    string
		seenInterface string
		seenComponent string
		seenCaller    string
		seenPara      OnlineRefundRequest
		bodyStr       string
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenMethod = r.Method
		seenUserID = r.Header.Get(CGWUserIDHeader)

		body, _ := io.ReadAll(r.Body)
		bodyStr = string(body)

		var env envelope
		if err := json.Unmarshal(body, &env); err != nil {
			t.Fatalf("unmarshal request envelope: %v", err)
		}
		seenComponent = env.ComponentName
		seenCaller = env.Caller
		if env.Interface != nil {
			seenInterface = env.Interface.InterfaceName
			if err := json.Unmarshal(env.Interface.Para, &seenPara); err != nil {
				t.Fatalf("unmarshal para: %v", err)
			}
		}

		_, _ = w.Write(envelopeForSuccess(t, OnlineRefundResponse{
			DealNames:  []string{"deal-refund-001"},
			BigDealIDs: []string{"big-deal-refund-001"},
		}))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-service-uin", Options{
		EventIDProvider:      fixedEventIDProvider,
		NowProvider:          fixedNowProvider,
		BillingAPIGWBaseURL:  server.URL,
		BillingAppID:         "test_v0",
		BillingAppSecret:     "66666666666666666666",
		BillingNonceProvider: func() string { return "test-nonce-001" },
	})

	resp, err := cli.OnlineRefund(context.Background(), &OnlineRefundRequest{
		UIN:         "100012345678",
		OwnerUin:    "100012345678",
		AppID:       1300012345,
		FromConsole: FromConsoleYes,
		GoodsInfo: map[string]OnlineRefundGoodsEntry{
			"sp_lighthouse": {
				PayMode:        PayModePrepaid,
				RegionID:       1,
				ResourceIDList: []string{"lhpass-abc"},
			},
		},
	})
	if err != nil {
		t.Fatalf("OnlineRefund: %v", err)
	}

	// 出参字段断言
	if got := len(resp.DealNames); got != 1 || resp.DealNames[0] != "deal-refund-001" {
		t.Errorf("resp.DealNames: got %v want [deal-refund-001]", resp.DealNames)
	}
	if got := len(resp.BigDealIDs); got != 1 || resp.BigDealIDs[0] != "big-deal-refund-001" {
		t.Errorf("resp.BigDealIDs: got %v want [big-deal-refund-001]", resp.BigDealIDs)
	}

	// 请求级断言
	if seenMethod != http.MethodPost {
		t.Errorf("HTTP method: got %s want POST", seenMethod)
	}
	if seenUserID != "trade-service-uin" {
		t.Errorf("x-qcloud-user-id: got %q", seenUserID)
	}
	if seenInterface != InterfaceNameOnlineRefund {
		t.Errorf("interfaceName: got %q want %q", seenInterface, InterfaceNameOnlineRefund)
	}
	if seenComponent != CGWComponentNameLightvela {
		t.Errorf("componentName: got %q want %q", seenComponent, CGWComponentNameLightvela)
	}
	if seenCaller != CGWComponentNameLightvela {
		t.Errorf("caller: got %q want %q", seenCaller, CGWComponentNameLightvela)
	}

	// para 字段全量断言（doc §4.1）
	if seenPara.UIN != "100012345678" {
		t.Errorf("para.uin: got %q", seenPara.UIN)
	}
	if seenPara.AppID != 1300012345 {
		t.Errorf("para.appId: got %d", seenPara.AppID)
	}
	if seenPara.FromConsole != FromConsoleYes {
		t.Errorf("para.fromConsole: got %d want %d", seenPara.FromConsole, FromConsoleYes)
	}
	if got := len(seenPara.GoodsInfo); got != 1 {
		t.Fatalf("para.goodsInfo len: got %d want 1", got)
	}
	entry, ok := seenPara.GoodsInfo["sp_lighthouse"]
	if !ok {
		t.Fatalf("para.goodsInfo missing key 'sp_lighthouse'; got keys=%v",
			func() []string {
				keys := make([]string, 0, len(seenPara.GoodsInfo))
				for k := range seenPara.GoodsInfo {
					keys = append(keys, k)
				}
				return keys
			}())
	}
	if entry.PayMode != PayModePrepaid {
		t.Errorf("para.goodsInfo[sp_lighthouse].payMode: got %d", entry.PayMode)
	}
	if entry.RegionID != 1 {
		t.Errorf("para.goodsInfo[sp_lighthouse].regionId: got %d", entry.RegionID)
	}
	if got := entry.ResourceIDList; len(got) != 1 || got[0] != "lhpass-abc" {
		t.Errorf("para.goodsInfo[sp_lighthouse].resourceIdList: got %v", got)
	}

	// **关键断言**：wire 上 goodsInfo 必须是 `{"sp_lighthouse":{...}}` 动态 key 形态
	// （doc §4.2 请求示例），而不是 `{"goodsInfo":[{"key":"sp_lighthouse",...}]}` 数组形态。
	// 这是 OnlineRefund 与 ModifyResourceStatus 的关键协议差异。
	if !strings.Contains(bodyStr, `"goodsInfo":{"sp_lighthouse":{`) {
		t.Errorf("wire goodsInfo must be map-with-string-key form per doc §4.2; got body=%s", bodyStr)
	}

	// Q-D-SIG-1~6 销毁链路签名严格要求（与 ModifyResourceStatus 同款）：
	//   1. envelope.interface.auth 必须存在，4 字段都非空
	//   2. signature 为 HMAC-SHA256 hex 大写 (64 字符、全部 [0-9A-F])
	//   3. 本地重算 signature 与客户端发出的完全一致（验证算法实现与 PDF §签名算法对齐）
	var reqEnv envelope
	if err := json.Unmarshal([]byte(bodyStr), &reqEnv); err != nil {
		t.Fatalf("reparse envelope for auth assertion: %v", err)
	}
	if reqEnv.Interface == nil || reqEnv.Interface.Auth == nil {
		t.Fatalf("Q-D-SIG-1~6 violated: envelope.interface.auth missing\n%s", bodyStr)
	}
	auth := reqEnv.Interface.Auth
	if auth.AppID != "test_v0" {
		t.Errorf("auth.appid: got %q want %q", auth.AppID, "test_v0")
	}
	if auth.Nonce != "test-nonce-001" {
		t.Errorf("auth.nonce: got %q want %q", auth.Nonce, "test-nonce-001")
	}
	if auth.Timestamp == "" {
		t.Errorf("auth.timestamp: empty")
	}
	if len(auth.Signature) != 64 {
		t.Errorf("auth.signature length: got %d want 64 (HMAC-SHA256 hex)", len(auth.Signature))
	}
	for _, ch := range auth.Signature {
		if !((ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'F')) {
			t.Errorf("auth.signature contains non-uppercase-hex char %q in %s", ch, auth.Signature)
			break
		}
	}
	tsParsed, _ := strconv.ParseInt(auth.Timestamp, 10, 64)
	recalcIface := &interfaceBlock{
		InterfaceName: reqEnv.Interface.InterfaceName,
		ExtraPara:     reqEnv.Interface.ExtraPara,
		Para:          reqEnv.Interface.Para,
	}
	recalcAuth, err := signBillingEnvelope("test_v0", "66666666666666666666", tsParsed, "test-nonce-001", recalcIface)
	if err != nil {
		t.Fatalf("recompute signBillingEnvelope: %v", err)
	}
	if recalcAuth.Signature != auth.Signature {
		t.Errorf("auth.signature mismatch: client=%s recalc=%s", auth.Signature, recalcAuth.Signature)
	}

	// **反向断言**：OwnerUin 字段 `json:"-"` 跳过 para wire 序列化，不应出现在 para 子对象里。
	if strings.Contains(string(reqEnv.Interface.Para), `"ownerUin"`) {
		t.Errorf("para wire MUST NOT contain ownerUin (json:\"-\" expected); got para=%s", string(reqEnv.Interface.Para))
	}

	// **正向断言**（2026-06-23 v0.5.1 联调修复添加）：OnlineRefund **必须** 携带
	// envelope.interface.extraPara.ownerUin，jifei 网关硬校验该字段与 .site 二选一非空，
	// 缺则返 returnCode=100000 "param error,need ownerUin or site"（与 ModifyResourceStatus
	// v1.7.29 同款踩坑）。本断言取代原 "OnlineRefund MUST NOT carry extraPara" 反向断言——
	// 后者是设计稿 v0.5 初版的协议理解错误，sandbox-bj-7 现网实测后修正。
	if reqEnv.Interface.ExtraPara == nil {
		t.Fatalf("OnlineRefund MUST carry envelope.interface.extraPara.ownerUin (jifei gateway hard check)\n%s", bodyStr)
	}
	if got := reqEnv.Interface.ExtraPara.OwnerUin; got != "100012345678" {
		t.Errorf("extraPara.ownerUin: got %q want %q", got, "100012345678")
	}
}

// TestOnlineRefund_NilRequest 覆盖 nil 入参校验。
func TestOnlineRefund_NilRequest(t *testing.T) {
	cli := New("http://unused", "", Options{EventIDProvider: fixedEventIDProvider, NowProvider: fixedNowProvider})
	resp, err := cli.OnlineRefund(context.Background(), nil)
	if err == nil {
		t.Fatalf("OnlineRefund(nil): err = nil, want non-nil")
	}
	if resp != nil {
		t.Errorf("resp on err: got %+v want nil", resp)
	}
	if !strings.Contains(err.Error(), "nil request") {
		t.Errorf("err message: got %q want substring 'nil request'", err.Error())
	}
}

// TestOnlineRefund_MissingRequired 覆盖必填字段校验。
func TestOnlineRefund_MissingRequired(t *testing.T) {
	cli := New("http://unused", "", Options{EventIDProvider: fixedEventIDProvider, NowProvider: fixedNowProvider})
	cases := []struct {
		name string
		req  *OnlineRefundRequest
		want string
	}{
		{
			name: "missing_UIN",
			req: &OnlineRefundRequest{
				AppID: 1, OwnerUin: "100012345678", GoodsInfo: map[string]OnlineRefundGoodsEntry{"sp_lighthouse": {PayMode: 1, RegionID: 1, ResourceIDList: []string{"r1"}}},
			},
			want: "empty UIN",
		},
		{
			name: "invalid_AppID",
			req: &OnlineRefundRequest{
				UIN: "uin1", OwnerUin: "100012345678", GoodsInfo: map[string]OnlineRefundGoodsEntry{"sp_lighthouse": {PayMode: 1, RegionID: 1, ResourceIDList: []string{"r1"}}},
			},
			want: "AppID must be positive",
		},
		{
			// 2026-06-23 v0.5.1 新增用例：OwnerUin 必填校验
			name: "missing_OwnerUin",
			req: &OnlineRefundRequest{
				UIN: "uin1", AppID: 1, GoodsInfo: map[string]OnlineRefundGoodsEntry{"sp_lighthouse": {PayMode: 1, RegionID: 1, ResourceIDList: []string{"r1"}}},
			},
			want: "empty OwnerUin",
		},
		{
			name: "empty_GoodsInfo",
			req:  &OnlineRefundRequest{UIN: "uin1", OwnerUin: "100012345678", AppID: 1, GoodsInfo: nil},
			want: "empty GoodsInfo",
		},
		{
			name: "empty_subProductCode_key",
			req: &OnlineRefundRequest{
				UIN: "uin1", OwnerUin: "100012345678", AppID: 1, GoodsInfo: map[string]OnlineRefundGoodsEntry{"": {PayMode: 1, RegionID: 1, ResourceIDList: []string{"r1"}}},
			},
			want: "sub_product_code) is empty",
		},
		{
			name: "PayMode_not_prepaid",
			req: &OnlineRefundRequest{
				UIN: "uin1", OwnerUin: "100012345678", AppID: 1, GoodsInfo: map[string]OnlineRefundGoodsEntry{"sp_lighthouse": {PayMode: 0, RegionID: 1, ResourceIDList: []string{"r1"}}},
			},
			want: "PayMode must be 1",
		},
		{
			name: "invalid_RegionID",
			req: &OnlineRefundRequest{
				UIN: "uin1", OwnerUin: "100012345678", AppID: 1, GoodsInfo: map[string]OnlineRefundGoodsEntry{"sp_lighthouse": {PayMode: 1, RegionID: 0, ResourceIDList: []string{"r1"}}},
			},
			want: "RegionID must be positive",
		},
		{
			name: "empty_ResourceIDList",
			req: &OnlineRefundRequest{
				UIN: "uin1", OwnerUin: "100012345678", AppID: 1, GoodsInfo: map[string]OnlineRefundGoodsEntry{"sp_lighthouse": {PayMode: 1, RegionID: 1, ResourceIDList: nil}},
			},
			want: "ResourceIDList is empty",
		},
		{
			name: "empty_ResourceID_entry",
			req: &OnlineRefundRequest{
				UIN: "uin1", OwnerUin: "100012345678", AppID: 1, GoodsInfo: map[string]OnlineRefundGoodsEntry{"sp_lighthouse": {PayMode: 1, RegionID: 1, ResourceIDList: []string{""}}},
			},
			want: "ResourceIDList[0] is empty",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp, err := cli.OnlineRefund(context.Background(), tc.req)
			if err == nil {
				t.Fatalf("OnlineRefund: err = nil, want %q", tc.want)
			}
			if resp != nil {
				t.Errorf("resp on err: got %+v want nil", resp)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("err message: got %q want substring %q", err.Error(), tc.want)
			}
		})
	}
}

// TestOnlineRefund_CGWBusinessError 覆盖业务错误码 returnCode=101103
// （doc §6.2"订单没有更新完成就进行退费"）→ trade 收 *CGWError 透传给上层。
func TestOnlineRefund_CGWBusinessError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(envelopeForError(t, 101103, "deal not yet delivered"))
	}))
	defer server.Close()

	cli := New(server.URL, "", Options{
		EventIDProvider:      fixedEventIDProvider,
		NowProvider:          fixedNowProvider,
		BillingAPIGWBaseURL:  server.URL,
		BillingAppID:         "test_v0",
		BillingAppSecret:     "66666666666666666666",
		BillingNonceProvider: func() string { return "test-nonce-001" },
	})

	resp, err := cli.OnlineRefund(context.Background(), &OnlineRefundRequest{
		UIN:      "100012345678",
		OwnerUin: "100012345678",
		AppID:    1300012345,
		GoodsInfo: map[string]OnlineRefundGoodsEntry{
			"sp_lighthouse": {PayMode: 1, RegionID: 1, ResourceIDList: []string{"lhpass-abc"}},
		},
	})
	if err == nil {
		t.Fatalf("OnlineRefund: err = nil, want *CGWError")
	}
	if resp != nil {
		t.Errorf("resp on business error: got %+v want nil", resp)
	}
	var cgwErr *CGWError
	if !errors.As(err, &cgwErr) {
		t.Fatalf("err type: got %T want *CGWError; err=%v", err, err)
	}
	if cgwErr.ReturnCode != 101103 {
		t.Errorf("CGWError.ReturnCode: got %d want 101103", cgwErr.ReturnCode)
	}
	if !strings.Contains(cgwErr.ReturnMessage, "deal not yet delivered") {
		t.Errorf("CGWError.ReturnMessage: got %q", cgwErr.ReturnMessage)
	}
	if cgwErr.InterfaceName != InterfaceNameOnlineRefund {
		t.Errorf("CGWError.InterfaceName: got %q want %q", cgwErr.InterfaceName, InterfaceNameOnlineRefund)
	}
}

// TestOnlineRefund_MissingBillingConfig 覆盖签名链路装配点防御：
// 调用方未在 Options 注入 BillingAPIGWBaseURL / BillingAppID / BillingAppSecret 时，
// OnlineRefund 必须 client-side 报错，不出请求（避免给 jifei 发未签名请求被网关拒）。
func TestOnlineRefund_MissingBillingConfig(t *testing.T) {
	// BillingAPIGWBaseURL 空字符串场景
	cli := New("http://unused", "", Options{
		EventIDProvider: fixedEventIDProvider,
		NowProvider:     fixedNowProvider,
		// 不传 BillingAPIGWBaseURL / BillingAppID / BillingAppSecret
	})
	resp, err := cli.OnlineRefund(context.Background(), &OnlineRefundRequest{
		UIN:      "uin1",
		OwnerUin: "uin1",
		AppID:    1,
		GoodsInfo: map[string]OnlineRefundGoodsEntry{
			"sp_lighthouse": {PayMode: 1, RegionID: 1, ResourceIDList: []string{"r1"}},
		},
	})
	if err == nil {
		t.Fatalf("OnlineRefund without BillingAPIGWBaseURL: err = nil, want non-nil")
	}
	if resp != nil {
		t.Errorf("resp on err: got %+v want nil", resp)
	}
	if !strings.Contains(err.Error(), "BillingAPIGWBaseURL is required") {
		t.Errorf("err message: got %q want substring 'BillingAPIGWBaseURL is required'", err.Error())
	}
}
