package jifei

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// 测试辅助：构造一个最小可用 dispatcher，prefix=lightvela。
func newTestDispatcher() *Dispatcher {
	b := NewFrameworkBuilder("trade", "1.0")
	return NewDispatcher("lightvela", b)
}

// recordingHandler 返回一个 handler + 它的调用记录（用于断言路由命中）。
type handlerRecord struct {
	called        bool
	receivedPara  string
	receivedSeqID string
}

func recordingHandler(rec *handlerRecord) Handler {
	b := NewFrameworkBuilder("trade", "1.0")
	return func(ctx context.Context, para json.RawMessage) (Framework, error) {
		rec.called = true
		rec.receivedPara = string(para)
		rec.receivedSeqID = SeqIDFromContext(ctx)
		return b.NewSuccess(map[string]any{"echoed": true}), nil
	}
}

// --- 路由命中类（合法 interfaceName）---

func TestDispatcher_RouteCheckCreate_HitsRegisteredHandler(t *testing.T) {
	d := newTestDispatcher()
	rec := &handlerRecord{}
	d.Register(InterfaceNameCheckCreate, recordingHandler(rec))

	body := []byte(`{
        "eventId": "evt-1", "componentName": "trade", "seqId": "seq-aaa", "spanId": "span-bbb",
        "interface": {"interfaceName": "lightvela.pass.checkCreate", "para": {"appId": 1}}
    }`)
	resp := d.Dispatch(context.Background(), body)

	if !rec.called {
		t.Fatalf("checkCreate handler was not called")
	}
	if rec.receivedSeqID != "seq-aaa" {
		t.Errorf("ctx framework field not propagated; got seqId=%q", rec.receivedSeqID)
	}
	if !strings.Contains(rec.receivedPara, `"appId": 1`) {
		t.Errorf("para not transparently passed; got %q", rec.receivedPara)
	}
	if resp.ReturnCode != 0 {
		t.Errorf("expected success returnCode 0, got %d", resp.ReturnCode)
	}
}

func TestDispatcher_RouteCreateResource_HitsRegisteredHandler(t *testing.T) {
	d := newTestDispatcher()
	rec := &handlerRecord{}
	d.Register(InterfaceNameCreateResource, recordingHandler(rec))

	body := []byte(`{
        "interface": {"interfaceName": "lightvela.pass.createResource", "para": {"dealName": "deal-x"}}
    }`)
	resp := d.Dispatch(context.Background(), body)

	if !rec.called {
		t.Fatalf("createResource handler was not called")
	}
	if resp.ReturnCode != 0 {
		t.Errorf("expected success returnCode 0, got %d", resp.ReturnCode)
	}
}

// --- 协议层错误类（Q60 五类形态）---

func TestDispatcher_MalformedEnvelope_JSONBroken(t *testing.T) {
	d := newTestDispatcher()
	resp := d.Dispatch(context.Background(), []byte(`{"interface": {INVALID_JSON`))

	if resp.ReturnCode != ReturnCodeInvalidEnvelope {
		t.Errorf("expected ReturnCodeInvalidEnvelope=%d, got %d", ReturnCodeInvalidEnvelope, resp.ReturnCode)
	}
	if resp.ReturnCode != resp.ReturnValue {
		t.Errorf("Q58: returnCode == returnValue must hold; got %d != %d", resp.ReturnCode, resp.ReturnValue)
	}
}

func TestDispatcher_MissingInterfaceName_EmptyString(t *testing.T) {
	d := newTestDispatcher()
	body := []byte(`{"interface": {"interfaceName": "", "para": {}}}`)
	resp := d.Dispatch(context.Background(), body)

	if resp.ReturnCode != ReturnCodeInterfaceNameRequired {
		t.Errorf("expected ReturnCodeInterfaceNameRequired=%d, got %d", ReturnCodeInterfaceNameRequired, resp.ReturnCode)
	}
}

func TestDispatcher_MissingInterfaceName_AbsentField(t *testing.T) {
	d := newTestDispatcher()
	// interface 节存在但完全没有 interfaceName 子字段
	body := []byte(`{"interface": {"para": {}}}`)
	resp := d.Dispatch(context.Background(), body)

	if resp.ReturnCode != ReturnCodeInterfaceNameRequired {
		t.Errorf("expected ReturnCodeInterfaceNameRequired, got %d", resp.ReturnCode)
	}
}

func TestDispatcher_MalformedInterfaceName_TwoSegments(t *testing.T) {
	d := newTestDispatcher()
	body := []byte(`{"interface": {"interfaceName": "lightvela.pass", "para": {}}}`)
	resp := d.Dispatch(context.Background(), body)

	if resp.ReturnCode != ReturnCodeInvalidInterfaceName {
		t.Errorf("expected ReturnCodeInvalidInterfaceName=%d, got %d", ReturnCodeInvalidInterfaceName, resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "3 segments") {
		t.Errorf("error message should mention segment count, got %q", resp.ReturnMessage)
	}
}

func TestDispatcher_MalformedInterfaceName_FourSegments(t *testing.T) {
	d := newTestDispatcher()
	body := []byte(`{"interface": {"interfaceName": "lightvela.pass.checkCreate.extra", "para": {}}}`)
	resp := d.Dispatch(context.Background(), body)

	if resp.ReturnCode != ReturnCodeInvalidInterfaceName {
		t.Errorf("expected ReturnCodeInvalidInterfaceName, got %d", resp.ReturnCode)
	}
}

func TestDispatcher_MalformedInterfaceName_EmptyMiddleSegment(t *testing.T) {
	d := newTestDispatcher()
	body := []byte(`{"interface": {"interfaceName": "lightvela..checkCreate", "para": {}}}`)
	resp := d.Dispatch(context.Background(), body)

	if resp.ReturnCode != ReturnCodeInvalidInterfaceName {
		t.Errorf("expected ReturnCodeInvalidInterfaceName, got %d", resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "empty") {
		t.Errorf("error message should mention empty segment, got %q", resp.ReturnMessage)
	}
}

func TestDispatcher_MalformedInterfaceName_WrongPrefix(t *testing.T) {
	d := newTestDispatcher()
	body := []byte(`{"interface": {"interfaceName": "qcloud.pass.checkCreate", "para": {}}}`)
	resp := d.Dispatch(context.Background(), body)

	if resp.ReturnCode != ReturnCodeInvalidInterfaceName {
		t.Errorf("expected ReturnCodeInvalidInterfaceName, got %d", resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "lightvela") {
		t.Errorf("error message should mention expected prefix, got %q", resp.ReturnMessage)
	}
}

func TestDispatcher_UnknownSubProduct(t *testing.T) {
	d := newTestDispatcher()
	// 注册 pass.checkCreate，但请求 unknown.checkCreate
	d.Register(InterfaceNameCheckCreate, func(ctx context.Context, p json.RawMessage) (Framework, error) {
		t.Fatalf("handler should not be called for unknown subProduct")
		return Framework{}, nil
	})
	body := []byte(`{"interface": {"interfaceName": "lightvela.unknown.checkCreate", "para": {}}}`)
	resp := d.Dispatch(context.Background(), body)

	if resp.ReturnCode != ReturnCodeUnknownInterface {
		t.Errorf("expected ReturnCodeUnknownInterface=%d, got %d", ReturnCodeUnknownInterface, resp.ReturnCode)
	}
}

func TestDispatcher_UnknownAction(t *testing.T) {
	d := newTestDispatcher()
	d.Register(InterfaceNameCheckCreate, func(ctx context.Context, p json.RawMessage) (Framework, error) {
		t.Fatalf("handler should not be called for unknown action")
		return Framework{}, nil
	})
	body := []byte(`{"interface": {"interfaceName": "lightvela.pass.unknownAction", "para": {}}}`)
	resp := d.Dispatch(context.Background(), body)

	if resp.ReturnCode != ReturnCodeUnknownInterface {
		t.Errorf("expected ReturnCodeUnknownInterface=%d, got %d", ReturnCodeUnknownInterface, resp.ReturnCode)
	}
}

// --- handler 异常路径兜底 ---

func TestDispatcher_HandlerReturnsError_FallsBackToNotImplemented(t *testing.T) {
	d := newTestDispatcher()
	d.Register(InterfaceNameCheckCreate, func(ctx context.Context, p json.RawMessage) (Framework, error) {
		return Framework{}, errors.New("simulated handler infra error")
	})
	body := []byte(`{"interface": {"interfaceName": "lightvela.pass.checkCreate", "para": {}}}`)
	resp := d.Dispatch(context.Background(), body)

	if resp.ReturnCode != ReturnCodeNotImplemented {
		t.Errorf("expected ReturnCodeNotImplemented=%d for handler error, got %d", ReturnCodeNotImplemented, resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "simulated handler infra error") {
		t.Errorf("error message should propagate handler error, got %q", resp.ReturnMessage)
	}
}

// --- Register 防御性约束 ---

func TestDispatcher_Register_PanicsOnInvalidInterfaceName(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Errorf("expected panic for invalid interfaceName during Register")
		}
	}()
	d := newTestDispatcher()
	d.Register("not.three", func(ctx context.Context, p json.RawMessage) (Framework, error) {
		return Framework{}, nil
	})
}

func TestDispatcher_Register_PanicsOnNilHandler(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Errorf("expected panic for nil handler during Register")
		}
	}()
	d := newTestDispatcher()
	d.Register(InterfaceNameCheckCreate, nil)
}

func TestDispatcher_Register_PanicsOnDuplicate(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Errorf("expected panic for duplicate Register")
		}
	}()
	d := newTestDispatcher()
	h := func(ctx context.Context, p json.RawMessage) (Framework, error) { return Framework{}, nil }
	d.Register(InterfaceNameCheckCreate, h)
	d.Register(InterfaceNameCheckCreate, h) // 重复 → panic
}

func TestDispatcher_RegisteredInterfaceNames_ListsAllRegistered(t *testing.T) {
	// 迭代 6 起 InstallStubHandlers 已为空（checkCreate / createResource 都有真 handler）；
	// 本测试改为手动注册 2 个 stub，断言 RegisteredInterfaceNames 列表完整 — 仍验证
	// dispatcher 注册表本身的可观测性，独立于 InstallStubHandlers 是否已腾空。
	d := newTestDispatcher()
	d.Register(InterfaceNameCheckCreate, stubHandler(d, InterfaceNameCheckCreate, 5))
	d.Register(InterfaceNameCreateResource, stubHandler(d, InterfaceNameCreateResource, 6))
	names := d.RegisteredInterfaceNames()
	if len(names) != 2 {
		t.Fatalf("expected 2 stub registrations, got %d: %+v", len(names), names)
	}
	have := map[string]bool{}
	for _, n := range names {
		have[n] = true
	}
	if !have[InterfaceNameCheckCreate] {
		t.Errorf("missing %s", InterfaceNameCheckCreate)
	}
	if !have[InterfaceNameCreateResource] {
		t.Errorf("missing %s", InterfaceNameCreateResource)
	}
}

// --- stub 行为测试（保留 stubHandler 工厂的可观测语义，未来扩展回调时复用）---

func TestInstallStubHandlers_CheckCreate_ReturnsNotImplementedWithSeqID(t *testing.T) {
	d := newTestDispatcher()
	d.Register(InterfaceNameCheckCreate, stubHandler(d, InterfaceNameCheckCreate, 5))
	body := []byte(`{
        "seqId": "seq-trace-123",
        "interface": {"interfaceName": "lightvela.pass.checkCreate", "para": {}}
    }`)
	resp := d.Dispatch(context.Background(), body)

	if resp.ReturnCode != ReturnCodeNotImplemented {
		t.Errorf("stub should return ReturnCodeNotImplemented=%d, got %d", ReturnCodeNotImplemented, resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "iteration 5") {
		t.Errorf("checkCreate stub message should mention iteration 5; got %q", resp.ReturnMessage)
	}
	if !strings.Contains(resp.ReturnMessage, "seq-trace-123") {
		t.Errorf("stub should echo seqId for traceability; got %q", resp.ReturnMessage)
	}
}

func TestInstallStubHandlers_CreateResource_ReturnsNotImplementedWithSeqID(t *testing.T) {
	d := newTestDispatcher()
	d.Register(InterfaceNameCreateResource, stubHandler(d, InterfaceNameCreateResource, 6))
	body := []byte(`{
        "seqId": "seq-trace-456",
        "interface": {"interfaceName": "lightvela.pass.createResource", "para": {}}
    }`)
	resp := d.Dispatch(context.Background(), body)

	if resp.ReturnCode != ReturnCodeNotImplemented {
		t.Errorf("stub should return ReturnCodeNotImplemented=%d, got %d", ReturnCodeNotImplemented, resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "iteration 6") {
		t.Errorf("createResource stub message should mention iteration 6; got %q", resp.ReturnMessage)
	}
}
