package jifei

import (
	"testing"
)

func TestNewSuccess_ReturnCodeEqualsReturnValueZero_AndDataNonNil(t *testing.T) {
	b := NewFrameworkBuilder("trade", "1.0")
	resp := b.NewSuccess(map[string]any{"status": 0})

	if resp.ReturnCode != 0 || resp.ReturnValue != 0 {
		t.Errorf("returnCode/returnValue must both be 0, got %d/%d", resp.ReturnCode, resp.ReturnValue)
	}
	if resp.ReturnCode != resp.ReturnValue {
		t.Errorf("Q58 strict: returnCode == returnValue must hold; got %d != %d", resp.ReturnCode, resp.ReturnValue)
	}
	if resp.ComponentName != "trade" || resp.Version != "1.0" {
		t.Errorf("componentName/version mismatch: %q / %q", resp.ComponentName, resp.Version)
	}
	if resp.ReturnMessage != "ok" {
		t.Errorf("success returnMessage mismatch: %q", resp.ReturnMessage)
	}
	if resp.Data == nil {
		t.Errorf("data must be non-nil map (PDF requires `data: {}` not null)")
	}
	if v, ok := resp.Data["status"]; !ok || v != 0 {
		t.Errorf("data.status mismatch: %+v", resp.Data)
	}
	if resp.Timestamp <= 0 {
		t.Errorf("timestamp must be positive unix millis, got %d", resp.Timestamp)
	}
}

func TestNewSuccess_NilDataYieldsEmptyMapNotNull(t *testing.T) {
	b := NewFrameworkBuilder("trade", "1.0")
	resp := b.NewSuccess(nil)
	if resp.Data == nil {
		t.Fatalf("data must be empty map, not nil (would marshal to `null`)")
	}
	if len(resp.Data) != 0 {
		t.Errorf("expected empty map, got %+v", resp.Data)
	}
}

func TestNewRefund_StrictMagicNumber352014(t *testing.T) {
	b := NewFrameworkBuilder("trade", "1.0")
	resp := b.NewRefund()

	// Q56 拍板 + PDF 第 8 页明示的退款魔法值
	if resp.ReturnCode != 352014 {
		t.Errorf("refund returnCode must be 352014, got %d", resp.ReturnCode)
	}
	if resp.ReturnValue != 352014 {
		t.Errorf("refund returnValue must be 352014, got %d", resp.ReturnValue)
	}
	if resp.ReturnCode != resp.ReturnValue {
		t.Errorf("Q58 strict: returnCode == returnValue must hold for refund too")
	}
	if resp.ReturnMessage != "DeliveryFailRefund" {
		t.Errorf("refund returnMessage must be 'DeliveryFailRefund', got %q", resp.ReturnMessage)
	}
	if resp.Data == nil || len(resp.Data) != 0 {
		t.Errorf("refund data must be empty map, got %+v", resp.Data)
	}
}

func TestNewError_ReturnCodeEqualsReturnValueAndMessageEcho(t *testing.T) {
	b := NewFrameworkBuilder("trade", "1.0")
	resp := b.NewError(400003, "invalid interfaceName")

	if resp.ReturnCode != 400003 || resp.ReturnValue != 400003 {
		t.Errorf("error returnCode/returnValue must both equal input code, got %d/%d", resp.ReturnCode, resp.ReturnValue)
	}
	if resp.ReturnCode != resp.ReturnValue {
		t.Errorf("Q58 strict: returnCode == returnValue for error path")
	}
	if resp.ReturnMessage != "invalid interfaceName" {
		t.Errorf("error returnMessage echo failed: %q", resp.ReturnMessage)
	}
	if resp.Data == nil || len(resp.Data) != 0 {
		t.Errorf("error data must be empty map, got %+v", resp.Data)
	}
}

func TestRefundMagicNumberConstants_AreNotAccidentallyShared(t *testing.T) {
	// 确保 RefundReturnCode 和 dispatcher 错误码常量没有数值碰撞 — 否则 jifei 拿到协议层错
	// 反而会触发退款逻辑（最严重的灾难性 bug，专测一遍）。
	collisions := []int{
		ReturnCodeInvalidEnvelope,
		ReturnCodeInterfaceNameRequired,
		ReturnCodeInvalidInterfaceName,
		ReturnCodeUnknownInterface,
		ReturnCodeNotImplemented,
	}
	for _, c := range collisions {
		if c == RefundReturnCode {
			t.Errorf("error code %d collides with refund magic %d — would trigger unintended refund!", c, RefundReturnCode)
		}
		if c == 0 {
			t.Errorf("error code must be non-zero, got %d", c)
		}
	}
}
