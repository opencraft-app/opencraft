// shadow_mock.go 提供 trade 联调测试期的 shadow client mock 实现。
//
// 背景（v1.7.28 BUG-02）:
//   - sandbox-bj-7 是 trade 联调专属环境，shadow 服务未部署该 ns
//   - 但 trade.inquiry.Service.Quote / placeorder.Service.PlaceOrder 在调用方未传 Uin 时
//     会调 shadowclient.GetBindingByExternalUserID 反查 (uin, app_id), 命中 NXDOMAIN 502 失败
//   - b03226d6 (Q30 alignment) 已经把 shadow 反查职责完全交给 trade, ctl 不再传 Uin
//   - 修复策略: trade 启动期当 cfg.ShadowMockEnabled=true 时改注入本 mock client,
//     shadowclient 包代码不动 (仅在 main.go 切换实现); 任意 externalUserId 都映射到
//     固定 mock binding {Uin:"700000164995", AppID:"251202221"} (jifei 测试 uin/appId)
//
// 安全约束:
//   - 仅联调测试环境启用; 现网部署 ShadowMockEnabled 必须为 false
//   - config.Load() 已强校验 ShadowMockEnabled=false 时 ShadowInternalBaseURL 必填
//
// 与 shadowclient 包关系:
//   - mockShadowClient 实现 shadowclient.Client 接口 (兼容现有 6 处调用站点 inquiry/2 + placeorder/4)
//   - 不修改 shadowclient/client.go (避免在 mono repo 共享包内引入 mock 状态)
package main

import (
	"context"

	"git.woa.com/wisp/mono/trade/internal/shadowclient"
)

// mock binding 固定值 — 与 .tmp/integration-plan-2026-05-18.md §10 Q-INT-10 拍板的 jifei
// 测试 uin / appId 一致 (PDF §国内站测试环境-业务提测 提供的测试凭据)。任何 externalUserId
// 入参都返回这对值, 让任意 user 都能跑通联调 (后续切真实 user 时只需关闭 ShadowMockEnabled)。
const (
	mockShadowUin   = "700000164995"
	mockShadowAppID = "251202221"
)

// mockShadowClient 是 shadowclient.Client 的 in-process mock 实现。
//
// 构造: newMockShadowClient() 即可, 无需任何参数 (mock binding 是包级常量)。
type mockShadowClient struct{}

// newMockShadowClient 构造 mock client 实例 (零开销, 无配置)。
func newMockShadowClient() shadowclient.Client {
	return &mockShadowClient{}
}

// GetBindingByExternalUserID 实现 shadowclient.Client 接口。
// 任意 externalUserID 都返回固定 mock binding (UserID 字段回显入参便于审计)。
// 不返回 ErrBindingNotFound — 测试环境视所有 user 为已绑定。
func (m *mockShadowClient) GetBindingByExternalUserID(_ context.Context, externalUserID string) (*shadowclient.Binding, error) {
	return &shadowclient.Binding{
		UserID:   externalUserID,
		Uin:      mockShadowUin,
		OwnerUin: mockShadowUin, // 测试场景 OwnerUin 与 Uin 同值
		AppID:    mockShadowAppID,
	}, nil
}
