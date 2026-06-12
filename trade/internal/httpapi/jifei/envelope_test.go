package jifei

import (
	"context"
	"encoding/json"
	"testing"
)

func TestCallbackEnvelope_Unmarshal_PDFCurlExampleShape(t *testing.T) {
	// 模拟 PDF 第 5 页 checkCreate 入参 curl 示例的最小子集：
	//   - 顶层 framework: eventId / componentName / seqId / spanId
	//   - 内层 interface: interfaceName + para（para 内是业务字段）
	// eventId 为 int (PDF §公共参数 + jifei 实测回调)
	raw := []byte(`{
        "eventId": 1102131141,
        "componentName": "trade",
        "seqId": "seq-aaa",
        "spanId": "span-bbb",
        "interface": {
            "interfaceName": "lightvela.pass.checkCreate",
            "para": {"appId": 12345, "uin": "100020003000", "dealName": "deal-xxx"}
        }
    }`)
	var env CallbackEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("unexpected unmarshal err: %v", err)
	}
	if env.EventID != 1102131141 {
		t.Errorf("EventID mismatch: %d", env.EventID)
	}
	if env.ComponentName != "trade" {
		t.Errorf("ComponentName mismatch: %q", env.ComponentName)
	}
	if env.SeqID != "seq-aaa" || env.SpanID != "span-bbb" {
		t.Errorf("SeqID/SpanID mismatch: %q / %q", env.SeqID, env.SpanID)
	}
	if env.Interface.InterfaceName != "lightvela.pass.checkCreate" {
		t.Errorf("InterfaceName mismatch: %q", env.Interface.InterfaceName)
	}
	// Para 是 RawMessage — dispatcher 不解析，只透传给 handler；这里仅验证它不为空。
	if len(env.Interface.Para) == 0 {
		t.Errorf("Para should not be empty")
	}
}

func TestWithFrameworkFields_AllFiveCtxKeysAccessible(t *testing.T) {
	env := &CallbackEnvelope{
		EventID:       1234567,
		ComponentName: "trade",
		SeqID:         "seq-1",
		SpanID:        "span-1",
		Interface:     InterfaceLayer{InterfaceName: "lightvela.pass.checkCreate"},
	}
	ctx := WithFrameworkFields(context.Background(), env)

	if got := EventIDFromContext(ctx); got != 1234567 {
		t.Errorf("EventIDFromContext: %d", got)
	}
	if got := ComponentNameFromContext(ctx); got != "trade" {
		t.Errorf("ComponentNameFromContext: %q", got)
	}
	if got := SeqIDFromContext(ctx); got != "seq-1" {
		t.Errorf("SeqIDFromContext: %q", got)
	}
	if got := SpanIDFromContext(ctx); got != "span-1" {
		t.Errorf("SpanIDFromContext: %q", got)
	}
	if got := InterfaceNameFromContext(ctx); got != "lightvela.pass.checkCreate" {
		t.Errorf("InterfaceNameFromContext: %q", got)
	}
}

func TestWithFrameworkFields_NilEnvIsNoop(t *testing.T) {
	ctx := WithFrameworkFields(context.Background(), nil)
	// 全部 getter 应返 zero value（int64=0 / string=""）— 不应 panic 也不应注入残值。
	if v := EventIDFromContext(ctx); v != 0 {
		t.Errorf("EventID expected 0, got %d", v)
	}
	if v := SeqIDFromContext(ctx); v != "" {
		t.Errorf("SeqID expected empty, got %q", v)
	}
}

func TestStringFromCtx_NilCtxReturnsEmpty(t *testing.T) {
	// 防御性测试：保证调用方传 nil ctx 不 panic，符合 zero-value 契约。
	//nolint:staticcheck // SA1012 故意传 nil 验证防御逻辑
	if v := EventIDFromContext(nil); v != 0 {
		t.Errorf("expected 0 for nil ctx, got %d", v)
	}
}
