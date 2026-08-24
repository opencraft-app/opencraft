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

	client := newMockShadowClient("", "")
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
			if binding.Uin != defaultMockShadowUin {
				t.Errorf("Uin: got %q, want %q", binding.Uin, defaultMockShadowUin)
			}
			if binding.OwnerUin != defaultMockShadowUin {
				t.Errorf("OwnerUin: got %q, want %q", binding.OwnerUin, defaultMockShadowUin)
			}
			if binding.AppID != defaultMockShadowAppID {
				t.Errorf("AppID: got %q, want %q", binding.AppID, defaultMockShadowAppID)
			}
		})
	}
}

func TestMockShadowClient_ConfigurableBinding(t *testing.T) {
	t.Parallel()

	client := newMockShadowClient("800000294207", "251221987")
	binding, err := client.GetBindingByExternalUserID(context.Background(), "usr_29d65f3d3692b2082e6ccbbc")
	if err != nil {
		t.Fatalf("GetBindingByExternalUserID() returned err: %v", err)
	}
	if binding.Uin != "800000294207" || binding.OwnerUin != "800000294207" {
		t.Fatalf("mock uin mismatch: got uin=%q owner=%q", binding.Uin, binding.OwnerUin)
	}
	if binding.AppID != "251221987" {
		t.Fatalf("mock appID mismatch: got %q", binding.AppID)
	}
}

// TestMockShadowClient_FixedConstants 防止误改 mock binding 常量值
// (现网保护: 这两个值是 jifei 测试 uin/appId, 改成现网值会泄漏到测试环境)。
func TestMockShadowClient_FixedConstants(t *testing.T) {
	t.Parallel()

	if defaultMockShadowUin != "700000164995" {
		t.Errorf("defaultMockShadowUin changed: got %q, want %q", defaultMockShadowUin, "700000164995")
	}
	if defaultMockShadowAppID != "251202221" {
		t.Errorf("defaultMockShadowAppID changed: got %q, want %q", defaultMockShadowAppID, "251202221")
	}
}
