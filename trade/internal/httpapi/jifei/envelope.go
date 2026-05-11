// Package jifei 实现 trade ↔ jifei（CGW）协议层的入向回调路由 + 出参 PDF framework 双层封装。
//
// 设计稿真源对照（详见 .tmp/trade-purchase-flow-design.md）：
//   - **Q53**：jifei → trade 回调入参 PDF framework 双层结构 `{eventId, componentName, seqId, spanId,
//     interface: {interfaceName, para: {...}}}` — 网关层展平方案，handler 业务代码看到的 `Para`
//     是展平后的业务字段，framework 字段（eventId / seqId / spanId / componentName / interfaceName）
//     通过 ctx 透传。
//   - **Q58**：trade → jifei 回调出参 PDF framework 双层结构 — 严格 `returnCode == returnValue`
//     (0=成功 / 非 0=失败)，业务字段塞 `data: {...}`；本包 `builder.go` 提供
//     NewSuccessFramework / NewRefundFramework / NewErrorFramework 三类工厂。
//   - **Q56**：退款响应专用魔法值 `returnCode=352014, returnMessage="DeliveryFailRefund", data={}`
//     的 framework 层封装入口。
//   - **Q60**：统一 endpoint `POST /trade/jifei/callback` + 三段式 `interfaceName` 路由
//     `{prefix}.{subProduct}.{action}`（trade 自家 prefix=`lightvela`），dispatcher 把合法 + 已
//     注册的 interfaceName 路由到具体 handler，未知 / 段数错 / prefix 错统一回 framework 失败响应。
//
// 本文件仅承担 DTO + ctx key 定义，不含逻辑；逻辑请见 dispatcher.go / builder.go / callback.go。
package jifei

import (
	"context"
	"encoding/json"
)

// CallbackEnvelope 是 trade 接 jifei 回调的协议层 PDF framework 双层入参（Q53）。
//
// 字段语义（每个字段都对应 PDF curl 示例的精确层级）：
//   - EventID：jifei 侧每次请求的事件号；trade 侧仅用于日志 trace（不参与业务逻辑）
//   - ComponentName：jifei 标识本次请求路由到哪个业务组件；trade 自家收到的值通常是 "trade"
//     （由 jifei 路由表配置决定，trade 侧不强校验，仅日志记录）
//   - SeqID / SpanID：jifei 侧 tracing 字段；trade 侧仅 ctx 透传 + 出参原样回填
//   - Interface.InterfaceName：dispatcher 路由的核心字段，三段式 `{prefix}.{subProduct}.{action}`
//   - Interface.Para：业务层入参原始 JSON；dispatcher 不解析，直接交给具体 handler 反序列化为业务 DTO
type CallbackEnvelope struct {
	EventID       string         `json:"eventId"`
	ComponentName string         `json:"componentName"`
	SeqID         string         `json:"seqId"`
	SpanID        string         `json:"spanId"`
	Interface     InterfaceLayer `json:"interface"`
}

// InterfaceLayer 是 framework 内层 — `interface` 字段对应的子结构。
//
// `Para` 故意用 json.RawMessage：dispatcher 仅按 InterfaceName 路由，不感知具体业务字段；
// 路由命中后由具体 handler（迭代 5/6 的 checkCreate / createResource）按业务 DTO 二次反序列化。
type InterfaceLayer struct {
	InterfaceName string          `json:"interfaceName"`
	Para          json.RawMessage `json:"para"`
}

// Framework 是 trade → jifei 回调出参 PDF 双层结构（Q58）。
//
// 严格约束（PDF 第 7-8 页明示）：
//   - `ReturnCode == ReturnValue`，且二者都是 0 才算成功；jifei 侧严格校验
//   - 业务字段（如 checkCreate 的 status / createResource 的 flowId / resourceIds）一律塞 Data
//   - 退款专用响应：`ReturnCode=ReturnValue=352014, ReturnMessage="DeliveryFailRefund", Data={}`
//
// 字段顺序与 PDF curl 示例对齐，便于联调期 diff 对照。
type Framework struct {
	ReturnCode    int            `json:"returnCode"`
	ReturnValue   int            `json:"returnValue"`
	ComponentName string         `json:"componentName"`
	Version       string         `json:"version"`
	Timestamp     int64          `json:"timestamp"`
	ReturnMessage string         `json:"returnMessage"`
	Data          map[string]any `json:"data"`
}

// ctxKey 是本包私有的 ctx key 类型；使用未导出 struct 防止跨包 key 冲突 / 误用。
type ctxKey int

const (
	ctxKeyEventID ctxKey = iota + 1
	ctxKeySeqID
	ctxKeySpanID
	ctxKeyComponentName
	ctxKeyInterfaceName
)

// WithFrameworkFields 把 framework 层 5 个字段一次性注入到 ctx；
// dispatcher 解包 envelope 后调用，handler 通过对应 GetXxx 取值。
//
// 用 ctx 而非 handler 入参传 framework 字段的原因（Q53 拍板）：
// handler 业务代码理论上只关心展平后的 Para 业务字段，framework 字段在 trace / 日志 / 出参
// 反填这些"基础设施"场景才用得到，放 ctx 减少 handler 签名噪音。
func WithFrameworkFields(ctx context.Context, env *CallbackEnvelope) context.Context {
	if env == nil {
		return ctx
	}
	ctx = context.WithValue(ctx, ctxKeyEventID, env.EventID)
	ctx = context.WithValue(ctx, ctxKeySeqID, env.SeqID)
	ctx = context.WithValue(ctx, ctxKeySpanID, env.SpanID)
	ctx = context.WithValue(ctx, ctxKeyComponentName, env.ComponentName)
	ctx = context.WithValue(ctx, ctxKeyInterfaceName, env.Interface.InterfaceName)
	return ctx
}

// EventIDFromContext / SeqIDFromContext / SpanIDFromContext / ComponentNameFromContext /
// InterfaceNameFromContext 各自取出 dispatcher 注入的 framework 字段；
// 当 ctx 未注入对应字段时返回空字符串（调用方按 zero value 处理即可，不需要 nil check）。
func EventIDFromContext(ctx context.Context) string         { return stringFromCtx(ctx, ctxKeyEventID) }
func SeqIDFromContext(ctx context.Context) string           { return stringFromCtx(ctx, ctxKeySeqID) }
func SpanIDFromContext(ctx context.Context) string          { return stringFromCtx(ctx, ctxKeySpanID) }
func ComponentNameFromContext(ctx context.Context) string   { return stringFromCtx(ctx, ctxKeyComponentName) }
func InterfaceNameFromContext(ctx context.Context) string   { return stringFromCtx(ctx, ctxKeyInterfaceName) }

func stringFromCtx(ctx context.Context, key ctxKey) string {
	if ctx == nil {
		return ""
	}
	if v, ok := ctx.Value(key).(string); ok {
		return v
	}
	return ""
}
