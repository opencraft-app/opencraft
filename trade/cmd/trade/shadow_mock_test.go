// shadow_mock_test.go 覆盖 v1.7.28 BUG-02 mock shadow client 的单元测试。
package main

import (
	"context"
	"testing"
)

// TestMockShadowClient_AnyExternalUserIDReturnsFixedBinding 验证: 任意 externalUserId
// 入参都返回固定 mock binding {Uin:"700000164995", AppID:"251202221"}。
func TestMockShadowClient_AnyExternalUserIDReturnsFixedBinding(t *testing.T) {
	t.Parallel()

	client := newMockShadowClient()
	cases := []string{
		"uin_test_001",
		"uin_test_002",
		"some-other-user",
		"", // 空字符串也应返回 mock 而非错误 (mock 视为已绑定)
		"非ASCII用户ID",
	}

	for _, externalUserID := range cases {
		t.Run("externalUserID="+externalUserID, func(t *testing.T) {
			binding, err := client.GetBindingByExternalUserID(context.Background(), externalUserID)
			if err != nil {
				t.Fatalf("GetBindingByExternalUserID(%q) returned err: %v", externalUserID, err)
			}
			if binding == nil {
				t.Fatalf("GetBindingByExternalUserID(%q) returned nil binding", externalUserID)
			}
			if binding.UserID != externalUserID {
				t.Errorf("UserID echo mismatch: got %q, want %q", binding.UserID, externalUserID)
			}
			if binding.Uin != mockShadowUin {
				t.Errorf("Uin: got %q, want %q", binding.Uin, mockShadowUin)
			}
			if binding.OwnerUin != mockShadowUin {
				t.Errorf("OwnerUin: got %q, want %q", binding.OwnerUin, mockShadowUin)
			}
			if binding.AppID != mockShadowAppID {
				t.Errorf("AppID: got %q, want %q", binding.AppID, mockShadowAppID)
			}
		})
	}
}

// TestMockShadowClient_FixedConstants 防止误改 mock binding 常量值
// (现网保护: 这两个值是 jifei 测试 uin/appId, 改成现网值会泄漏到测试环境)。
func TestMockShadowClient_FixedConstants(t *testing.T) {
	t.Parallel()

	if mockShadowUin != "700000164995" {
		t.Errorf("mockShadowUin changed: got %q, want %q", mockShadowUin, "700000164995")
	}
	if mockShadowAppID != "251202221" {
		t.Errorf("mockShadowAppID changed: got %q, want %q", mockShadowAppID, "251202221")
	}
}
