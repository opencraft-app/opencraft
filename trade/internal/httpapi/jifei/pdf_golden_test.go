// Package jifei 的协议层 PDF golden 测试（铁律 4）。
//
// 目的：用 PDF curl 示例的真实 number/string 类型 payload 做反/序列化 round-trip，
// 防止下次 PDF 升级 / 仓库重构时再踩 BUG-06 同模式（CallbackEnvelope.eventId 类型不匹配）。
//
// 铁律来源：jifei/envelope.go 包注释 §"协议字段类型铁律"。
//
// fixture 数据来源：.tmp/新购检查接口+-+checkCreate.pdf §curl 示例（PDF 第 5-6 页）。
// 任何 PDF 升级都必须同步刷新本文件 fixture，并加新的子用例覆盖新字段。
package jifei

import (
	"encoding/json"
	"testing"
)

// TestPDFGolden_CheckCreateCurlExample_FrameworkLayerTypes 验证 framework 顶层的
// 4 个 PDF 字段（eventId number / componentName string / seqId string / spanId string）
// 用 PDF curl 示例的真实类型可以正确反序列化（铁律 1 + 4）。
//
// 反向用例：把 eventId 改成 string "1102131141"（与 PDF 不符的常见漂移） → 验证 Unmarshal
// 必报 cannot unmarshal string into Go struct field eventId of type int64，从而触发 CI 阻断。
func TestPDFGolden_CheckCreateCurlExample_FrameworkLayerTypes(t *testing.T) {
	t.Run("PDF curl example shape PASSES round-trip", func(t *testing.T) {
		// 来源：.tmp/新购检查接口+-+checkCreate.pdf 第 5-6 页 curl 示例（精简到协议字段集合）
		// 注：jifei 实测发的 eventId 是 number（如 1102131141 / 497517132 / 1989177820）
		raw := []byte(`{
            "eventId": 1102131141,
            "componentName": "trade",
            "seqId": "5yzawcm9-p9vy-gk28-klpx-qloj5etb6ulg",
            "spanId": "span-001",
            "interface": {
                "interfaceName": "lightvela.pass.checkCreate",
                "para": {
                    "appId": 1305017296,
                    "uin": "13030030017592",
                    "operateUin": "13030030017592",
                    "productCode": "p_lighthouse",
                    "subProductCode": "sp_lighthouse_lightvela_mc",
                    "region": 1,
                    "zoneId": 100001,
                    "payMode": 1,
                    "goodsNum": 1
                }
            }
        }`)
		var env CallbackEnvelope
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatalf("PDF golden round-trip failed: %v", err)
		}
		// 验证 framework 4 个字段类型 + 值与 PDF curl 示例一致
		if env.EventID != 1102131141 {
			t.Errorf("EventID expected 1102131141 (number from PDF), got %d", env.EventID)
		}
		if env.ComponentName != "trade" {
			t.Errorf("ComponentName expected 'trade', got %q", env.ComponentName)
		}
		if env.SeqID == "" || env.SpanID == "" {
			t.Errorf("SeqID/SpanID should not be empty: %q / %q", env.SeqID, env.SpanID)
		}
		// 业务 para 字段交给具体 handler 测试覆盖；此处仅确认透传非空
		if len(env.Interface.Para) == 0 {
			t.Errorf("Interface.Para should be non-empty raw json")
		}
	})

	t.Run("PDF mismatch (eventId as string) MUST fail unmarshal", func(t *testing.T) {
		// 反向用例：常见 BUG-06 同模式漂移（eventId 写成 string）→ 必须 Unmarshal err
		raw := []byte(`{
            "eventId": "1102131141",
            "componentName": "trade",
            "seqId": "any",
            "spanId": "any",
            "interface": {"interfaceName": "lightvela.pass.checkCreate", "para": {}}
        }`)
		var env CallbackEnvelope
		err := json.Unmarshal(raw, &env)
		if err == nil {
			t.Fatal("expected unmarshal error for eventId=string (PDF demands number); got nil — BUG-06 同模式漂移防御失效！")
		}
		// 错误必含字段类型不匹配的提示，便于排障套路一眼定位
		if !contains(err.Error(), "eventId") || !contains(err.Error(), "int64") {
			t.Errorf("err should mention 'eventId' + 'int64' for clear diagnosis; got %v", err)
		}
	})
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
