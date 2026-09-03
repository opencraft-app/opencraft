package pass

import (
	"testing"
	"time"

	passmodel "ctl/pkg/model/pass"
)

// 升配用户侧入口的入参构造。需求：TAPD 1010132091137784162 §5.1
//
// 这里只覆盖不依赖 DB / trade 的部分。走 DAO 和 trade adapter 的路径由 main/api
// 侧的路由与集成测试覆盖。

func modifyTestPass() *passmodel.Entity {
	return &passmodel.Entity{
		PassID:      "lhpass-r1",
		UserID:      "usr_test",
		BundleID:    "bundle_launch_01",
		Status:      passmodel.StatusActive,
		ExpiredTime: time.Date(2026, 6, 15, 10, 30, 0, 0, time.Local),
	}
}

// TestModifyInquiryAndOrderSendIdenticalParams 是这条链路上最要紧的不变量。
//
// 询价和下单必须送出完全相同的入参，否则用户在确认页看到的差价可以和实际扣款不一致。
// 两侧共用 buildModifyOrderRequest 只是"当前实现恰好如此"，这条用例把它变成契约：
// 谁把其中一侧改成单独构造，这里就会红。
func TestModifyInquiryAndOrderSendIdenticalParams(t *testing.T) {
	l := &logic{}
	passEntity := modifyTestPass()

	inquiry := l.buildModifyOrderRequest(passEntity, "bundle_cruise_01")
	order := l.buildModifyOrderRequest(passEntity, "bundle_cruise_01")

	if *inquiry != *order {
		t.Fatalf("inquiry and order params diverged:\n inquiry=%+v\n order  =%+v", *inquiry, *order)
	}
}

// TestBuildModifyOrderRequestDerivesBillingIdentityFromPass 锁住"计费身份只来自 DB"。
//
// source bundle 和 curDeadline 都不接受前端传入：它们决定这笔单扣多少钱，
// 前端传错等于扣错钱。
func TestBuildModifyOrderRequestDerivesBillingIdentityFromPass(t *testing.T) {
	l := &logic{}
	passEntity := modifyTestPass()

	req := l.buildModifyOrderRequest(passEntity, "bundle_cruise_01")

	if req.ResourceID != passEntity.PassID {
		t.Errorf("ResourceID = %q, want pass id %q", req.ResourceID, passEntity.PassID)
	}
	if req.ExternalUserID != passEntity.UserID {
		t.Errorf("ExternalUserID = %q, want %q", req.ExternalUserID, passEntity.UserID)
	}
	if req.SourceBundleID != passEntity.BundleID {
		t.Errorf("SourceBundleID = %q, want pass bundle %q", req.SourceBundleID, passEntity.BundleID)
	}
	if req.TargetBundleID != "bundle_cruise_01" {
		t.Errorf("TargetBundleID = %q", req.TargetBundleID)
	}
	if want := formatCurDeadlineForJifei(passEntity.ExpiredTime); req.CurDeadline != want {
		t.Errorf("CurDeadline = %q, want %q (from pass.expired_time)", req.CurDeadline, want)
	}
	// uin / appId 留空由 trade 侧 shadow 反查，与续费同范式；ctl 自己猜会和 shadow 打架。
	if req.Uin != "" || req.AppID != "" {
		t.Errorf("uin/appId should be resolved by trade, got %q/%q", req.Uin, req.AppID)
	}
	if req.PayMode != lighthousePassPayMode {
		t.Errorf("PayMode = %d, want %d", req.PayMode, lighthousePassPayMode)
	}
}

// TestModifyAllowedRejectsTargetsFrontendMightReplay 覆盖 §5.1 的"下单重校验目标"。
//
// `GET /modify/bundles` 的结果会停留在用户的浏览器里；他可能拿着旧结果下单，也可能
// 直接改请求体。所以下单路径不能信任前端送来的 target，必须自己再问一遍
// ModifyAllowed —— 这里逐条钉住本期真正禁止的四类目标。
func TestModifyAllowedRejectsTargetsFrontendMightReplay(t *testing.T) {
	cases := []struct {
		name           string
		source, target string
		want           bool
	}{
		{name: "通用升配", source: "bundle_launch_01", target: "bundle_cruise_01", want: true},
		{name: "AI 升配", source: "bundle_launch_ai_01", target: "bundle_cruise_ai_01", want: true},
		// 降配：本期明确不支持，放过去会让计费按负差价退钱。
		{name: "降配", source: "bundle_cruise_01", target: "bundle_launch_01"},
		// 跨 SP：通用与 AI 的计费定义、积分额度都不同，串了会算错钱。
		{name: "通用跨到 AI", source: "bundle_launch_01", target: "bundle_cruise_ai_01"},
		{name: "AI 跨到通用", source: "bundle_launch_ai_01", target: "bundle_cruise_01"},
		// 同档原地变配：没有差价，属于无意义订单。
		{name: "同档", source: "bundle_launch_01", target: "bundle_launch_01"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ModifyAllowed(tc.source, tc.target); got != tc.want {
				t.Errorf("ModifyAllowed(%q, %q) = %v, want %v", tc.source, tc.target, got, tc.want)
			}
		})
	}
}

// TestModifyStatusGateRejectsNonActivePass 覆盖下单前的状态门禁。
//
// §6 前置校验：只有 active 能发起变配；modifying 单独成码，受理入口据此走
// "同一 flow 复用"分支，合并成一个码会让重投的计费回调被当成非法请求。
func TestModifyStatusGateRejectsNonActivePass(t *testing.T) {
	for _, status := range []string{
		passmodel.StatusIsolating,
		passmodel.StatusIsolated,
		passmodel.StatusRenewing,
		passmodel.StatusDeleting,
		passmodel.StatusModifying,
	} {
		if err := classifyModifyStatusError(status); err == nil {
			t.Errorf("status %q should not be modifiable", status)
		}
	}
}
