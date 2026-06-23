package internalapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// ============================================================================
// refund resource tests (trade-pass-refund-design.md v0.5 §8 commit 2)
//
// 设计稿：.tmp/trade-pass-refund-design.md v0.5 §3 + §4 + §11 拍板项汇总
//
// 与 deleteResource 单测同款范式（fake hook 注入 + env.doJSON 装配），
// 复用 newTestEnv / decodeBody / fakeJifei / fakeBundleStore helper。
//
// 覆盖范围（8 个测试函数 + 子测试）：
//   - TestRefundResource_HappyPath：BundleStore 命中 + jifei 同步成功 → 200 + dealName/bigDealId
//   - TestRefundResource_AuthRequired：缺 Authorization header → 401
//   - TestRefundResource_BundleNotFound：BundleStore 返 NotFound → 404 + 不调 jifei
//   - TestRefundResource_BundleStoreInternalError：BundleStore 其他错 → 500
//   - TestRefundResource_JifeiBusinessError：jifei 业务错（returnCode != 0）→ 502 UpstreamBusinessError
//   - TestRefundResource_JifeiHTTPError：jifei HTTP 非 2xx → 502 UpstreamHTTPError
//   - TestRefundResource_RequiredFieldChecks：必填字段校验（uin/appId/bundleId）
//   - TestRefundResource_EmptyDealNamesDefense：jifei returnCode=0 但 dealNames/bigDealIds 空数组 → 502 UpstreamInvalidResponse
// ============================================================================

// refundResourceBody 是 refundResource 端点的标准入参。
//
// 与 deleteResourceBody 3 字段同款（设计稿 §4.1：UIN/AppID/BundleID），
// SubProductCode 由 trade 反查 BundleDefinition 取值。
func refundResourceBody() map[string]any {
	return map[string]any{
		"uin":      "100012345678",
		"appId":    1300012345,
		"bundleId": "bundle-test-1",
	}
}

// TestRefundResource_HappyPath 验证：BundleStore 命中 + jifei OnlineRefund 同步成功 →
// 200 + dealName/bigDealId 透传 + jifei 入参完整（含 goodsInfo map[sub_product_code] 形态）。
func TestRefundResource_HappyPath(t *testing.T) {
	env := newTestEnv(t)

	// 注入 BundleDefinition：SubProductCode = "sp_lighthouse" 触发 doc §4.1 goodsInfo map key 取值。
	env.bundle.getBundleDefinitionByIDFn = func(_ context.Context, bundleID string) (*store.BundleDefinition, error) {
		return &store.BundleDefinition{
			BundleID:       bundleID,
			ProductCode:    "p_lighthouse",
			SubProductCode: "sp_lighthouse",
		}, nil
	}

	var seenReq *jifeiclient.OnlineRefundRequest
	env.jifei.onlineRefundFn = func(_ context.Context, req *jifeiclient.OnlineRefundRequest) (*jifeiclient.OnlineRefundResponse, error) {
		seenReq = req
		return &jifeiclient.OnlineRefundResponse{
			DealNames:  []string{"deal-refund-001"},
			BigDealIDs: []string{"big-deal-refund-001"},
		}, nil
	}

	rec := env.doJSON(http.MethodPost,
		"/internal/trade/resources/lhins-bj-7-test-001/refund",
		refundResourceBody(), true)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	if resp["dealName"] != "deal-refund-001" {
		t.Errorf("dealName: got %v want deal-refund-001", resp["dealName"])
	}
	if resp["bigDealId"] != "big-deal-refund-001" {
		t.Errorf("bigDealId: got %v want big-deal-refund-001", resp["bigDealId"])
	}

	// 验证 jifei 入参拼装（设计稿 §4 + doc §4.1）。
	if seenReq == nil {
		t.Fatal("OnlineRefund not called")
	}
	if seenReq.UIN != "100012345678" {
		t.Errorf("uin: got %q want 100012345678", seenReq.UIN)
	}
	if seenReq.AppID != 1300012345 {
		t.Errorf("appId: got %d want 1300012345", seenReq.AppID)
	}
	if seenReq.FromConsole != jifeiclient.FromConsoleYes {
		t.Errorf("fromConsole: got %d want %d", seenReq.FromConsole, jifeiclient.FromConsoleYes)
	}

	// 关键断言：goodsInfo 必须以 sub_product_code 作 map key（doc §4.2 形态）
	if len(seenReq.GoodsInfo) != 1 {
		t.Fatalf("goodsInfo len: got %d want 1", len(seenReq.GoodsInfo))
	}
	entry, ok := seenReq.GoodsInfo["sp_lighthouse"]
	if !ok {
		t.Fatalf("goodsInfo missing key 'sp_lighthouse' (must come from BundleDefinition.SubProductCode)")
	}
	if entry.PayMode != jifeiclient.PayModePrepaid {
		t.Errorf("goodsInfo[sp_lighthouse].payMode: got %d want %d", entry.PayMode, jifeiclient.PayModePrepaid)
	}
	if entry.RegionID != 1 {
		// trade 内部固定 region=1 广州（与 deleteResource Q41 同款）
		t.Errorf("goodsInfo[sp_lighthouse].regionId: got %d want 1", entry.RegionID)
	}
	if len(entry.ResourceIDList) != 1 || entry.ResourceIDList[0] != "lhins-bj-7-test-001" {
		t.Errorf("goodsInfo[sp_lighthouse].resourceIdList: got %v want [lhins-bj-7-test-001]", entry.ResourceIDList)
	}

	// Q5=a 拍板：不传 category_ids / goodsCategoryId，确认这些可选字段为零值
	if entry.ActivityID != "" {
		t.Errorf("activityId should be empty (Q5=a; not transmitted by trade); got %q", entry.ActivityID)
	}
	if entry.IgnoreQuota {
		t.Errorf("ignoreQuota should be false (not transmitted by trade)")
	}
	if entry.ProductCode != "" {
		t.Errorf("productCode should be empty (not transmitted by trade by default); got %q", entry.ProductCode)
	}
}

// TestRefundResource_AuthRequired 验证缺 Authorization header → 401（与 deleteResource 同款）。
func TestRefundResource_AuthRequired(t *testing.T) {
	env := newTestEnv(t)
	rec := env.doJSON(http.MethodPost,
		"/internal/trade/resources/lhins-x/refund",
		refundResourceBody(), false)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d body=%s", rec.Code, rec.Body.String())
	}
}

// TestRefundResource_BundleNotFound 验证 BundleStore 返 ErrBundleDefinitionNotFound →
// 404 BundleDefinitionNotFound + 不调 jifei OnlineRefund。
func TestRefundResource_BundleNotFound(t *testing.T) {
	env := newTestEnv(t)
	env.bundle.getBundleDefinitionByIDFn = func(_ context.Context, _ string) (*store.BundleDefinition, error) {
		return nil, store.ErrBundleDefinitionNotFound
	}
	jifeiCalled := false
	env.jifei.onlineRefundFn = func(_ context.Context, _ *jifeiclient.OnlineRefundRequest) (*jifeiclient.OnlineRefundResponse, error) {
		jifeiCalled = true
		return nil, nil
	}

	rec := env.doJSON(http.MethodPost,
		"/internal/trade/resources/lhins-x/refund",
		refundResourceBody(), true)
	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	if resp["code"] != "BundleDefinitionNotFound" {
		t.Errorf("expected code=BundleDefinitionNotFound, got %v", resp["code"])
	}
	if jifeiCalled {
		t.Error("jifei OnlineRefund should not be called when BundleStore returns NotFound")
	}
}

// TestRefundResource_BundleStoreInternalError 验证 BundleStore 返非 NotFound 错 → 500 InternalError。
func TestRefundResource_BundleStoreInternalError(t *testing.T) {
	env := newTestEnv(t)
	env.bundle.getBundleDefinitionByIDFn = func(_ context.Context, _ string) (*store.BundleDefinition, error) {
		return nil, errors.New("db connection lost")
	}
	rec := env.doJSON(http.MethodPost,
		"/internal/trade/resources/lhins-x/refund",
		refundResourceBody(), true)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	if resp["code"] != "InternalError" {
		t.Errorf("expected code=InternalError, got %v", resp["code"])
	}
}

// TestRefundResource_JifeiBusinessError 验证 jifei 业务错（returnCode != 0）→ 502 UpstreamBusinessError。
//
// 覆盖典型业务错码（doc §6.2）：
//   - 101103 订单未发货完成（"deal not yet delivered"）
//   - 200001 allowReturn != 1（业务侧 queryResource 拒绝退款）
func TestRefundResource_JifeiBusinessError(t *testing.T) {
	cases := []struct {
		name string
		code int
		msg  string
	}{
		{name: "order_not_yet_delivered", code: 101103, msg: "deal not yet delivered"},
		{name: "allow_return_not_one", code: 200001, msg: "rule denied refund: contact sp_xxx (allowReturn != 1)"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := newTestEnv(t)
			env.jifei.onlineRefundFn = func(_ context.Context, _ *jifeiclient.OnlineRefundRequest) (*jifeiclient.OnlineRefundResponse, error) {
				return nil, &jifeiclient.CGWError{
					ReturnCode:    tc.code,
					ReturnMessage: tc.msg,
					InterfaceName: jifeiclient.InterfaceNameOnlineRefund,
				}
			}
			rec := env.doJSON(http.MethodPost,
				"/internal/trade/resources/lhins-x/refund",
				refundResourceBody(), true)
			if rec.Code != http.StatusBadGateway {
				t.Errorf("expected 502, got %d body=%s", rec.Code, rec.Body.String())
			}
			resp := decodeBody(t, rec)
			if resp["code"] != "UpstreamBusinessError" {
				t.Errorf("expected code=UpstreamBusinessError, got %v", resp["code"])
			}
			if msg, _ := resp["message"].(string); !strings.Contains(msg, tc.msg) {
				t.Errorf("message should contain jifei returnMessage; got %q want substring %q", msg, tc.msg)
			}
		})
	}
}

// TestRefundResource_JifeiHTTPError 验证 jifei HTTP 非 2xx → 502 UpstreamHTTPError。
func TestRefundResource_JifeiHTTPError(t *testing.T) {
	env := newTestEnv(t)
	env.jifei.onlineRefundFn = func(_ context.Context, _ *jifeiclient.OnlineRefundRequest) (*jifeiclient.OnlineRefundResponse, error) {
		return nil, jifeiclient.ErrCGWHTTPNon200
	}
	rec := env.doJSON(http.MethodPost,
		"/internal/trade/resources/lhins-x/refund",
		refundResourceBody(), true)
	if rec.Code != http.StatusBadGateway {
		t.Errorf("expected 502, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	if resp["code"] != "UpstreamHTTPError" {
		t.Errorf("expected code=UpstreamHTTPError, got %v", resp["code"])
	}
}

// TestRefundResource_RequiredFieldChecks 验证必填字段表驱动校验：
// 缺 uin / appId<=0 / 缺 bundleId 全报 400 InvalidRequest（与 deleteResource 同款）。
func TestRefundResource_RequiredFieldChecks(t *testing.T) {
	cases := []struct {
		name    string
		mutator func(map[string]any)
	}{
		{name: "missing_uin", mutator: func(b map[string]any) { delete(b, "uin") }},
		{name: "empty_uin", mutator: func(b map[string]any) { b["uin"] = "  " }},
		{name: "zero_appId", mutator: func(b map[string]any) { b["appId"] = 0 }},
		{name: "negative_appId", mutator: func(b map[string]any) { b["appId"] = -1 }},
		{name: "missing_bundleId", mutator: func(b map[string]any) { delete(b, "bundleId") }},
		{name: "empty_bundleId", mutator: func(b map[string]any) { b["bundleId"] = "   " }},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := newTestEnv(t)
			body := refundResourceBody()
			tc.mutator(body)
			rec := env.doJSON(http.MethodPost,
				"/internal/trade/resources/lhins-x/refund",
				body, true)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
			}
			resp := decodeBody(t, rec)
			if resp["code"] != "InvalidRequest" {
				t.Errorf("expected code=InvalidRequest, got %v", resp["code"])
			}
		})
	}
}

// TestRefundResource_EmptyDealNamesDefense 验证防御性检查：
// jifei returnCode=0（"成功"）但 dealNames / bigDealIds 为空数组（协议违约）→ 502 UpstreamInvalidResponse，
// 而非把空字符串透传给 ctl 让上游误以为退款成功。
func TestRefundResource_EmptyDealNamesDefense(t *testing.T) {
	cases := []struct {
		name string
		resp *jifeiclient.OnlineRefundResponse
	}{
		{
			name: "both_empty",
			resp: &jifeiclient.OnlineRefundResponse{DealNames: nil, BigDealIDs: nil},
		},
		{
			name: "dealNames_empty",
			resp: &jifeiclient.OnlineRefundResponse{DealNames: nil, BigDealIDs: []string{"big-1"}},
		},
		{
			name: "bigDealIds_empty",
			resp: &jifeiclient.OnlineRefundResponse{DealNames: []string{"deal-1"}, BigDealIDs: nil},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := newTestEnv(t)
			env.jifei.onlineRefundFn = func(_ context.Context, _ *jifeiclient.OnlineRefundRequest) (*jifeiclient.OnlineRefundResponse, error) {
				return tc.resp, nil
			}
			rec := env.doJSON(http.MethodPost,
				"/internal/trade/resources/lhins-x/refund",
				refundResourceBody(), true)
			if rec.Code != http.StatusBadGateway {
				t.Errorf("expected 502, got %d body=%s", rec.Code, rec.Body.String())
			}
			resp := decodeBody(t, rec)
			if resp["code"] != "UpstreamInvalidResponse" {
				t.Errorf("expected code=UpstreamInvalidResponse, got %v", resp["code"])
			}
		})
	}
}
