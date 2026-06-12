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
//
// =============================================================================
// 协议字段类型铁律（v1.7.28 BUG-06 沉淀，2026-05-21 用户拍板）
// =============================================================================
//
// 本包的 CallbackEnvelope，以及下游所有 handler 包（checkcreate/createresource/checkrenew/
// renewresource/isolateresource/destroyresource/queryresource/queryflow/getuserresources）
// 的 `callbackPara` struct，必须遵循以下 4 条铁律，违反者会触发 BUG-06 同模式
// `json: cannot unmarshal number into Go struct field` 错误，jifei 同步把它当作 trade 业务校验失败
// 上抛 returnCode=700002 ERR_BUSINESS_CHECK，导致整个下单链路失败、且表象误导成"jifei 商品配置错"
// 极难排查（参见 .tmp/integration-bugfix-log-2026-05-18.md BUG-06）。
//
// 铁律 1：**协议字段类型必须 100% 与 PDF 一致**
//   - PDF "long" / "int" / "number" → Go `int64` / `int`，禁止用 string
//   - PDF "string" → Go `string`，禁止用 int 即使值看起来像数字
//   - PDF "bool" → Go `bool`
//   - PDF "object" / "array" → Go `map[string]any` / `json.RawMessage`
//
// 铁律 2：**每个字段的 struct tag 后必须用行内注释标注 PDF 类型**
//   格式：`AppID int64 \`json:"appId"\` // PDF: long (number)`
//   原因：让 reviewer 一眼看见就能 diff PDF；下次 PDF 升级时 git grep 可定位所有 PDF 标注点。
//
// 铁律 3：**出向 envelope 与入向 callback 字段类型必须同步改**
//   v1.7.4 commit 34adbbf5 修出向 envelope.eventId string→int64 时漏改入向 CallbackEnvelope.EventID,
//   导致 v1.7.28 联调期 BUG-06 反复踩坑。今后协议层字段类型变更必须 grep 所有 `json:"<field>"` tag
//   命中点统一改，commit msg checklist 必须明示。
//
// 铁律 4：**变更必须配 PDF golden 测试**
//   测试 fixture 用 PDF curl 示例的真实 number/string 类型 payload 做反/序列化 round-trip,
//   绝不能用任意 placeholder 值（如 "evt-1" 替代 number eventId 等）。CI 必跑。
//
// 排障套路（用户 2026-05-21 拍板沉淀）：
//   - jifei 真实回调到 trade 后看到 returnCode=400001 invalid envelope → 看 returnMessage
//     里 "Go struct field X.Y of type Z" 直接定位是哪个字段类型不匹配
//   - 不要盲目去 jifei 侧查 700002 商品配置（高频是 trade 自身 envelope 解析失败的副作用）
//   - 直接捞 trade pod 日志：
//       kubectl -n <ns> logs -l app=trade --since=10m \
//         | grep -E '/trade/jifei/callback|invalid envelope|returnCode'
// =============================================================================
package jifei

import (
	"context"
	"encoding/json"
)

// CallbackEnvelope 是 trade 接 jifei 回调的协议层 PDF framework 双层入参（Q53）。
//
// 字段语义（每个字段都对应 PDF curl 示例的精确层级）：
//   - EventID：jifei 侧每次请求的事件号；trade 侧仅用于日志 trace（不参与业务逻辑）
//     **类型 int64**：PDF §公共参数 eventId 类型 = int；jifei 回调实测发的也是 number。
//     与 v1.7.4 commit 34adbbf5 出向 envelope eventId int64 校准一致（Q-INT-12 完整闭环）。
//     v1.7.28 BUG-06 修复：原入向定义为 string 导致 unmarshal "cannot unmarshal number
//     into Go struct field CallbackEnvelope.eventId of type string" 错误，对应实测错误码
//     400001 invalid envelope。
//   - ComponentName：jifei 标识本次请求路由到哪个业务组件；trade 自家收到的值通常是 "trade"
//     （由 jifei 路由表配置决定，trade 侧不强校验，仅日志记录）
//   - SeqID / SpanID：jifei 侧 tracing 字段；trade 侧仅 ctx 透传 + 出参原样回填
//   - Interface.InterfaceName：dispatcher 路由的核心字段，三段式 `{prefix}.{subProduct}.{action}`
//   - Interface.Para：业务层入参原始 JSON；dispatcher 不解析，直接交给具体 handler 反序列化为业务 DTO
type CallbackEnvelope struct {
	EventID       int64          `json:"eventId"`
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
// 当 ctx 未注入对应字段时返回 zero value（int64 → 0，string → ""）。
//
// EventIDFromContext 返回 int64：与 PDF §公共参数 + 出向 envelope eventId int64
// 一致（v1.7.28 BUG-06 修复 Q-INT-12 完整闭环）。
func EventIDFromContext(ctx context.Context) int64          { return int64FromCtx(ctx, ctxKeyEventID) }
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

func int64FromCtx(ctx context.Context, key ctxKey) int64 {
	if ctx == nil {
		return 0
	}
	if v, ok := ctx.Value(key).(int64); ok {
		return v
	}
	return 0
}
