package jifei

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// Handler 是具体动作 handler 的统一签名（迭代 5/6 落地）。
//
// 入参契约（dispatcher 已保证的前置条件）：
//   - ctx：framework 字段已通过 WithFrameworkFields 注入（EventID/SeqID/SpanID/ComponentName/InterfaceName）
//   - para：framework.interface.para 的原始 JSON（业务层自行反序列化为业务 DTO）
//
// 返回契约：
//   - Framework：业务侧已构造好的 PDF 双层出参（含成功 / 业务错 / 退款三种语义）
//   - error：仅在 handler 自身基础设施异常（如 panic recover 未覆盖）时返回；
//     dispatcher 收到非 nil error 会兜底返 ReturnCodeNotImplemented 让 jifei 重试。
//
// 设计意图：handler 自己负责把业务结果（成功 / Q56 A 类退款 / Q56 B 类业务错）映射为 Framework，
// dispatcher 不在 handler 之外做二次错误码翻译，保持业务/协议错责任单一边界。
type Handler func(ctx context.Context, para json.RawMessage) (Framework, error)

// Dispatcher 按 Q60 三段式 interfaceName 路由 jifei 回调到具体 handler。
//
// 路由规则（Q60 拍板）：
//   - interfaceName 形如 `{ourPrefix}.{subProduct}.{action}`，三段必须非空
//   - 第一段必须等于 ourPrefix（默认 `lightvela`，由 config 注入）；其他 prefix 视为非法
//   - 完整字符串作为 handler 表的 key（精确匹配，不做大小写归一化以严格对齐 jifei 协议）
//
// 错误处理（Q60 + Q56 协同）：
//   - envelope 解析失败 → ReturnCodeInvalidEnvelope（400001）
//   - interfaceName 空 → ReturnCodeInterfaceNameRequired（400002）
//   - 段数错 / prefix 错 → ReturnCodeInvalidInterfaceName（400003）
//   - 三段合法但未注册 → ReturnCodeUnknownInterface（400004）
//   - handler 内部 panic / 返回 error → ReturnCodeNotImplemented（501001）兜底
type Dispatcher struct {
	ourPrefix string
	handlers  map[string]Handler
	builder   *FrameworkBuilder
}

// NewDispatcher 构造 Dispatcher；handlers 表用 Register 增量注册（避免构造时一次性硬编码所有动作）。
func NewDispatcher(ourPrefix string, builder *FrameworkBuilder) *Dispatcher {
	return &Dispatcher{
		ourPrefix: ourPrefix,
		handlers:  make(map[string]Handler),
		builder:   builder,
	}
}

// Register 把一个完整 interfaceName（如 `lightvela.pass.checkCreate`）绑定到 handler。
//
// 调用约束：interfaceName 必须严格三段式 + 第一段等于 ourPrefix；不满足直接 panic（开发期错误，
// 不应该进生产 — 注册表是启动时初始化的常量集合，错就尽早暴露）。
//
// 重复注册同一 key 也 panic（防止迭代 5/6 同事不小心覆盖对方动作）。
func (d *Dispatcher) Register(interfaceName string, handler Handler) {
	if err := d.validateInterfaceName(interfaceName); err != nil {
		panic(fmt.Sprintf("jifei.Dispatcher.Register: invalid interfaceName %q: %v", interfaceName, err))
	}
	if handler == nil {
		panic(fmt.Sprintf("jifei.Dispatcher.Register: handler is nil for %q", interfaceName))
	}
	if _, exists := d.handlers[interfaceName]; exists {
		panic(fmt.Sprintf("jifei.Dispatcher.Register: duplicate registration for %q", interfaceName))
	}
	d.handlers[interfaceName] = handler
}

// Dispatch 路由一条 jifei 回调请求；总是返回一个 Framework 出参（即使是错误响应）+ HTTP 状态码。
//
// 关键边界：HTTP 状态码恒返 200（jifei 按 returnCode 判定成败而非 HTTP status，PDF 第 7-8 页明示）；
// 仅在 dispatcher 自身基础设施异常无法构造任何 Framework 时才会理论上返非 200，本实现不存在该路径。
func (d *Dispatcher) Dispatch(ctx context.Context, body []byte) Framework {
	var env CallbackEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		return d.builder.NewError(ReturnCodeInvalidEnvelope, fmt.Sprintf("invalid envelope: %v", err))
	}

	interfaceName := strings.TrimSpace(env.Interface.InterfaceName)
	if interfaceName == "" {
		return d.builder.NewError(ReturnCodeInterfaceNameRequired, "interface.interfaceName is required")
	}
	if err := d.validateInterfaceName(interfaceName); err != nil {
		return d.builder.NewError(ReturnCodeInvalidInterfaceName, fmt.Sprintf("invalid interfaceName %q: %v", interfaceName, err))
	}

	handler, ok := d.handlers[interfaceName]
	if !ok {
		return d.builder.NewError(ReturnCodeUnknownInterface, fmt.Sprintf("unknown interfaceName %q", interfaceName))
	}

	// framework 字段注入到 ctx，handler 通过 jifei.SeqIDFromContext 等取值。
	ctx = WithFrameworkFields(ctx, &env)

	resp, err := handler(ctx, env.Interface.Para)
	if err != nil {
		// handler 异常路径兜底：返非零 returnCode 让 jifei 重试；不返退款（避免业务侧逻辑错被误退款）。
		return d.builder.NewError(ReturnCodeNotImplemented, fmt.Sprintf("handler %q returned error: %v", interfaceName, err))
	}
	return resp
}

// validateInterfaceName 校验 Q60 三段式格式 + ourPrefix 匹配。
//
// 规则：
//  1. 必须恰好 3 段（点号分隔后 len == 3）
//  2. 每段必须非空（避免 `lightvela..checkCreate` 这种空段）
//  3. 第一段必须严格等于 d.ourPrefix
//
// 不校验段内字符集（字母 / 数字 / 下划线 / 大小写敏感等），按 jifei 协议黑盒透传。
func (d *Dispatcher) validateInterfaceName(name string) error {
	parts := strings.Split(name, ".")
	if len(parts) != 3 {
		return fmt.Errorf("expected 3 segments separated by '.', got %d", len(parts))
	}
	for i, p := range parts {
		if strings.TrimSpace(p) == "" {
			return fmt.Errorf("segment %d is empty", i)
		}
	}
	if parts[0] != d.ourPrefix {
		return fmt.Errorf("expected prefix %q, got %q", d.ourPrefix, parts[0])
	}
	return nil
}

// RegisteredInterfaceNames 仅用于日志 / 健康探针 / 测试断言 — 列出所有已注册的 interfaceName。
// 顺序不稳定（map 遍历），调用方需要排序的自己处理。
func (d *Dispatcher) RegisteredInterfaceNames() []string {
	names := make([]string, 0, len(d.handlers))
	for name := range d.handlers {
		names = append(names, name)
	}
	return names
}
