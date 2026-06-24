// trade pass 退款链路 OnlineRefund 单测（trade-pass-refund-design.md v0.7 §8 commit 1）。
//
// 协议依据：/root/project/mono/.tmp/线上退设备退款.doc §4.1 + §4.2 + §5 + §6.1
//
// 复用本包既有 envelopeForSuccess / envelopeForError / fixedEventIDProvider /
// fixedNowProvider helper（见 client_test.go），与 generatedeals_test.go 同款非签名路径范式。
//
// **v0.6 路由切换（2026-06-23）**：撤回 v0.5.1 OwnerUin patch + 切换到
// jifei-test CGW 非签名链路。
//
// **v0.7 修订（2026-06-24）**：协议是唯一真源 — OnlineRefund 同属 qcloud.Deal.* 接口族，
// 与 generateDeals / generateDealsAndPay / getPrice / getmidasearmarking 同款，**para 内平铺
// ownerUin 字段**。本文件反转断言从"para wire MUST NOT contain ownerUin"改为正向
// 断言"para wire MUST contain ownerUin"，HappyPath fixture 加回 OwnerUin，MissingRequired
// 补 missing_OwnerUin case。路由间 v0.6 表面不变（envelope.interface.auth MUST NOT 存在
// + envelope.interface.extraPara MUST NOT 存在）。
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

// TestOnlineRefund_Success 覆盖 happy-path：
//   - HTTP request method / x-qcloud-user-id 正确
//   - envelope 顶层 7 字段正确（version / componentName / caller / eventId / timestamp / interface.interfaceName）
//   - request body para 字段（camelCase JSON tag）按 doc §4.1 完整发出
//   - **request body MUST NOT 含 interface.auth**（v0.6 非签名链路反向断言，与 generateDeals 同款）
//   - **request body MUST NOT 含 interface.extraPara**（v0.6 撤回 v0.5.1 OwnerUin extraPara 中转反向断言）
//   - **request body para MUST contain ownerUin**（v0.7 正向断言，与 generateDeals Deal 接口族同款平铺范式）
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

	// v0.6 路由切换（2026-06-23）：OnlineRefund 走 jifei-test CGW 非签名链路
	// （baseURL=server.URL），与 generateDeals / generateDealsAndPay 同入口；
	// Options 不再注入 Billing* 三件套（撤回 v0.5.1 签名链路装配）。
	cli := New(server.URL, "trade-service-uin", Options{
		EventIDProvider: fixedEventIDProvider,
		NowProvider:     fixedNowProvider,
	})

	resp, err := cli.OnlineRefund(context.Background(), &OnlineRefundRequest{
		OwnerUin:    "100012345678",
		UIN:         "100012345678",
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
	if seenPara.OwnerUin != "100012345678" {
		t.Errorf("para.ownerUin: got %q", seenPara.OwnerUin)
	}
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

	// v0.6 路由切换（2026-06-23） + v0.7 修订（2026-06-24）联合断言：
	// 1. envelope.interface.auth MUST NOT 存在（与 generateDeals 同款非签名链路，v0.6 保留）
	// 2. envelope.interface.extraPara MUST NOT 存在（撤回 v0.5.1 OwnerUin extraPara 中转，v0.6 保留）
	// 3. **para wire MUST 含 ownerUin 字段**（v0.7 正向断言，与 generateDeals Deal 接口族范式同款。
	//    仓库内 generatedeals.go:37 / generatedealsandpay.go:31 / getprice.go:66 / getmidasearmarking.go:33
	//    同款使用。pass-fg77bhed e2e 实测确认 jifei-test 入口对 Deal 接口族 ownerUin 做硬校验。）
	var reqEnv envelope
	if err := json.Unmarshal([]byte(bodyStr), &reqEnv); err != nil {
		t.Fatalf("reparse envelope for v0.6/v0.7 reverse+forward assertions: %v", err)
	}
	if reqEnv.Interface == nil {
		t.Fatalf("envelope.interface missing in non-signing route\n%s", bodyStr)
	}
	if reqEnv.Interface.Auth != nil {
		t.Errorf("v0.6 violated: envelope.interface.auth MUST NOT be present in jifei-test non-signing route; got auth=%+v\n%s",
			reqEnv.Interface.Auth, bodyStr)
	}
	if reqEnv.Interface.ExtraPara != nil {
		t.Errorf("v0.6 violated: envelope.interface.extraPara MUST NOT be present (v0.5.1 OwnerUin extraPara 中转撤回); got extraPara=%+v\n%s",
			reqEnv.Interface.ExtraPara, bodyStr)
	}
	if !strings.Contains(string(reqEnv.Interface.Para), `"ownerUin"`) {
		t.Errorf("v0.7 violated: para wire MUST contain ownerUin (Deal 接口族平铺范式); got para=%s",
			string(reqEnv.Interface.Para))
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
//
// **v0.7 修订（2026-06-24）**：加回 missing_OwnerUin case（OwnerUin 字段随 v0.7 加回，
// 与 generateDeals Deal 接口族同款必填校验）。其余现有 case 同步补上 OwnerUin，避免被
// 补加的 OwnerUin 预检拦掉。
func TestOnlineRefund_MissingRequired(t *testing.T) {
	cli := New("http://unused", "", Options{EventIDProvider: fixedEventIDProvider, NowProvider: fixedNowProvider})
	cases := []struct {
		name string
		req  *OnlineRefundRequest
		want string
	}{
		{
			name: "missing_OwnerUin",
			req: &OnlineRefundRequest{
				UIN: "uin1", AppID: 1, GoodsInfo: map[string]OnlineRefundGoodsEntry{"sp_lighthouse": {PayMode: 1, RegionID: 1, ResourceIDList: []string{"r1"}}},
			},
			want: "empty OwnerUin",
		},
		{
			name: "missing_UIN",
			req: &OnlineRefundRequest{
				OwnerUin: "100012345678",
				AppID:    1, GoodsInfo: map[string]OnlineRefundGoodsEntry{"sp_lighthouse": {PayMode: 1, RegionID: 1, ResourceIDList: []string{"r1"}}},
			},
			want: "empty UIN",
		},
		{
			name: "invalid_AppID",
			req: &OnlineRefundRequest{
				OwnerUin: "uin1", UIN: "uin1", GoodsInfo: map[string]OnlineRefundGoodsEntry{"sp_lighthouse": {PayMode: 1, RegionID: 1, ResourceIDList: []string{"r1"}}},
			},
			want: "AppID must be positive",
		},
		{
			name: "empty_GoodsInfo",
			req:  &OnlineRefundRequest{OwnerUin: "uin1", UIN: "uin1", AppID: 1, GoodsInfo: nil},
			want: "empty GoodsInfo",
		},
		{
			name: "empty_subProductCode_key",
			req: &OnlineRefundRequest{
				OwnerUin: "uin1", UIN: "uin1", AppID: 1, GoodsInfo: map[string]OnlineRefundGoodsEntry{"": {PayMode: 1, RegionID: 1, ResourceIDList: []string{"r1"}}},
			},
			want: "sub_product_code) is empty",
		},
		{
			name: "PayMode_not_prepaid",
			req: &OnlineRefundRequest{
				OwnerUin: "uin1", UIN: "uin1", AppID: 1, GoodsInfo: map[string]OnlineRefundGoodsEntry{"sp_lighthouse": {PayMode: 0, RegionID: 1, ResourceIDList: []string{"r1"}}},
			},
			want: "PayMode must be 1",
		},
		{
			name: "invalid_RegionID",
			req: &OnlineRefundRequest{
				OwnerUin: "uin1", UIN: "uin1", AppID: 1, GoodsInfo: map[string]OnlineRefundGoodsEntry{"sp_lighthouse": {PayMode: 1, RegionID: 0, ResourceIDList: []string{"r1"}}},
			},
			want: "RegionID must be positive",
		},
		{
			name: "empty_ResourceIDList",
			req: &OnlineRefundRequest{
				OwnerUin: "uin1", UIN: "uin1", AppID: 1, GoodsInfo: map[string]OnlineRefundGoodsEntry{"sp_lighthouse": {PayMode: 1, RegionID: 1, ResourceIDList: nil}},
			},
			want: "ResourceIDList is empty",
		},
		{
			name: "empty_ResourceID_entry",
			req: &OnlineRefundRequest{
				OwnerUin: "uin1", UIN: "uin1", AppID: 1, GoodsInfo: map[string]OnlineRefundGoodsEntry{"sp_lighthouse": {PayMode: 1, RegionID: 1, ResourceIDList: []string{""}}},
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

	// v0.6：非签名链路装配，与 happy-path 同款。
	cli := New(server.URL, "", Options{
		EventIDProvider: fixedEventIDProvider,
		NowProvider:     fixedNowProvider,
	})

	resp, err := cli.OnlineRefund(context.Background(), &OnlineRefundRequest{
		OwnerUin: "100012345678",
		UIN:      "100012345678",
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

// TestOnlineRefund_BaseURLRequired 覆盖非签名链路装配点防御（v0.6 新增，取代旧
// TestOnlineRefund_MissingBillingConfig）：
// 调用方未注入 baseURL（New() 第一参数空字符串）时，OnlineRefund 必须 client-side 报错，
// 不出请求（与 GenerateDeals / GetPrice 等其他非签名出向接口同款防御）。
func TestOnlineRefund_BaseURLRequired(t *testing.T) {
	cli := New("", "", Options{
		EventIDProvider: fixedEventIDProvider,
		NowProvider:     fixedNowProvider,
	})
	resp, err := cli.OnlineRefund(context.Background(), &OnlineRefundRequest{
		OwnerUin: "uin1",
		UIN:      "uin1",
		AppID:    1,
		GoodsInfo: map[string]OnlineRefundGoodsEntry{
			"sp_lighthouse": {PayMode: 1, RegionID: 1, ResourceIDList: []string{"r1"}},
		},
	})
	if err == nil {
		t.Fatalf("OnlineRefund without baseURL: err = nil, want non-nil")
	}
	if resp != nil {
		t.Errorf("resp on err: got %+v want nil", resp)
	}
	if !strings.Contains(err.Error(), "baseURL is required") {
		t.Errorf("err message: got %q want substring 'baseURL is required'", err.Error())
	}
}
