package jifei

import "time"

// 退款响应专用魔法值（Q56 拍板 + PDF 第 8 页明示）：
//   - `returnCode = returnValue = 352014`，且二者必须严格相等（Q58）
//   - `returnMessage = "DeliveryFailRefund"`
//   - `data = {}`（必须是空对象，不是 null，PDF curl 示例如此）
//
// 触发场景：trade 侧明确判定本订单永远无法发货 / 重试也无意义（Q56 A 类）。
const (
	RefundReturnCode    = 352014
	RefundReturnMessage = "DeliveryFailRefund"
)

// dispatcher 层错误对应的 returnCode（Q60 拍板 + Q56 协同）：
// 协议层错（envelope 解析失败 / interfaceName 缺失 / 段数错 / prefix 错 / 未注册）
// 不是业务层错，因此**不返**退款魔法值 352014（避免误退款）；
// 改为返非零 returnCode，按 Q60 拍板"未知 interfaceName 让 jifei 12 个月后放弃"。
const (
	ReturnCodeInvalidEnvelope          = 400001 // JSON 解析失败 / framework 字段缺失
	ReturnCodeInterfaceNameRequired    = 400002 // interface.interfaceName 为空
	ReturnCodeInvalidInterfaceName     = 400003 // 不是三段式 / prefix 不是 trade 自家
	ReturnCodeUnknownInterface         = 400004 // 三段式合法但 handler 表无注册
	ReturnCodeNotImplemented           = 501001 // handler stub 占位（迭代 5/6 替换为业务码）
)

// nowUnixMillisFn 用于测试 stub 替换；生产路径恒等于 time.Now().UnixMilli。
var nowUnixMillisFn = func() int64 { return time.Now().UnixMilli() }

// FrameworkBuilder 构造 PDF framework 双层出参（Q58）；
// componentName / version 来自 config，由调用方注入避免 builder 隐式依赖全局状态。
type FrameworkBuilder struct {
	ComponentName string
	Version       string
}

// NewFrameworkBuilder 用 component / version 构造 builder。
func NewFrameworkBuilder(componentName, version string) *FrameworkBuilder {
	return &FrameworkBuilder{ComponentName: componentName, Version: version}
}

// NewSuccess 构造业务成功响应（returnCode == returnValue == 0）。
//
// data 是业务字段集合（如 checkCreate 的 `{"status": 0}` / createResource 的
// `{"flowId": "...", "resourceIds": [...]}`）；nil 时填空对象 `{}`（jifei 严格按 PDF
// 解析，data 字段不能是 null）。
func (b *FrameworkBuilder) NewSuccess(data map[string]any) Framework {
	return Framework{
		ReturnCode:    0,
		ReturnValue:   0,
		ComponentName: b.ComponentName,
		Version:       b.Version,
		Timestamp:     nowUnixMillisFn(),
		ReturnMessage: "ok",
		Data:          ensureNonNilData(data),
	}
}

// NewRefund 构造退款响应（returnCode == returnValue == 352014 / DeliveryFailRefund）。
//
// jifei 收到此响应会立刻取消订单 + 退款给用户，不再重试；
// 仅在 Q56 A 类场景（业务侧明确判定本订单永远无法发货）调用。
func (b *FrameworkBuilder) NewRefund() Framework {
	return Framework{
		ReturnCode:    RefundReturnCode,
		ReturnValue:   RefundReturnCode,
		ComponentName: b.ComponentName,
		Version:       b.Version,
		Timestamp:     nowUnixMillisFn(),
		ReturnMessage: RefundReturnMessage,
		Data:          map[string]any{},
	}
}

// NewError 构造业务/协议层失败响应（returnCode == returnValue == code，code != 0 且 != 352014）。
//
// jifei 收到此响应会按 PDF 重试链路（1s 5s 10s 30s 1min 5min 10min 1h 6h 12h 1d × 12 个月）
// 持续重试，直到放弃；适用于 Q56 B 类（短暂故障）+ Q60 协议层错（未知 interfaceName 等）。
//
// 注意：调用方禁止传 0 或 352014（这两个值有专用语义，应改用 NewSuccess / NewRefund）；
// 本函数不做强校验，但要求文档约束 + 调用点 review 把控。
func (b *FrameworkBuilder) NewError(code int, message string) Framework {
	return Framework{
		ReturnCode:    code,
		ReturnValue:   code,
		ComponentName: b.ComponentName,
		Version:       b.Version,
		Timestamp:     nowUnixMillisFn(),
		ReturnMessage: message,
		Data:          map[string]any{},
	}
}

// ensureNonNilData 保证 PDF 双层结构里 data 字段始终是非 nil 的 map。
// jifei 侧严格按 PDF 解析；data: null 会被判定为协议错（PDF curl 示例都是 `data: {}`）。
func ensureNonNilData(data map[string]any) map[string]any {
	if data == nil {
		return map[string]any{}
	}
	return data
}
