// Package createresource 实现 jifei `lightvela.pass.createResource` 回调的同步发货 handler。
//
// 设计稿引用：
//   - §6 createResource 回调（trade → 反向调 ctl/pass）
//   - §6.0 Q27 角色边界：trade 是协议入口 + 流水持久化；pass 实体唯一 owner = ctl/pass
//   - §6.2 内部步骤 T1~T5（Q61 抢占式幂等覆盖 T1 / T5）：
//       T1 `INSERT trade_flow ... ON DUPLICATE KEY UPDATE id=id` 抢占 + 三分支
//       T2 反查 trade_order，确认 status=pending_payment（实际 trade_order 状态机为
//          created / pending_pay / paid_pending_provision / provisioned / payment_failed /
//          provision_failed，本期 createResource 进入时通常为 pending_pay 或
//          paid_pending_provision；本迭代不强约束，仅校验"订单存在 + 未已发货"）
//       T3 反向调 ctl `POST /internal/ctl/passes/complete` 拿 pass_id
//       T4 UPDATE trade_order SET status=provisioned, resource_id=passId（迭代 8 PlaceOrder
//          落库后才会真有写端，本迭代仅在 OrderStore 提供 UpdateProvisioned 时调用；尚未实现
//          时跳过该步并日志记录，不阻塞协议层成功响应）
//       T5 UPDATE trade_flow SET status=completed, response_body=<framework JSON>
//   - §6.4 异常分类（Q56 协同）：A 类业务永久不可发货 → 退款响应 (returnCode=352014)；
//     B 类基础设施 transient 故障 → 非零业务码 returnCode 让 jifei 重试
//   - Q56 退款触发场景（本迭代严格收敛）：
//       a. trade_order 不存在 → B 类（链路异常 / 重试），不退款
//       b. trade_order 已被发货过（resource_id 非空）→ 视作幂等回放成功（虽然 trade_flow 没记录，
//          但实际 ctl 已生成 pass，按"已完成"语义返回），不退款
//       c. ctl GetBundleByID 返 ErrNotFound（bundle 已永久删除）→ A 类退款
//       d. ctl CompletePass 返 4xx 业务级错（USER_HAS_ACTIVE_PASS / quota 不足等）→ A 类退款
//       e. ctl CompletePass 返 5xx 或网络错 / 超时 → B 类业务码（让 jifei 重试）
//   - Q59：5s 同步硬约束（本迭代收紧到 4s 给 jifei 1s buffer，ctlclient 本身是 4s 内置超时）
//   - Q62：本 handler 写 trade_flow（与 checkCreate 不写形成对比）
package createresource

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// 业务层 returnCode（与 checkcreate 包风格一致；区间 6xxxxx 自定义业务错码段，避开协议层
// 4xxxxx + 退款专用 352014）。
const (
	// ReturnCodeInvalidPara = jifei 入参 JSON 解析失败 / 必填字段缺失。
	// 属 Q56 B 类（jifei 重试）。
	ReturnCodeInvalidPara = 600201

	// ReturnCodeOrderNotFound = trade_order 反查无记录。
	// 属 Q56 B 类（链路异常 / trade pod 重启等）。
	ReturnCodeOrderNotFound = 600202

	// ReturnCodeFlowInProgress = 抢占失败且现存记录处于 in_progress（其他实例 / 上次还在跑）。
	// 属 Q56 B 类（让 jifei 走重试节奏退避，等待主链路完成）。
	ReturnCodeFlowInProgress = 600203

	// ReturnCodeUpstreamUnavailable = ctl / DB 上游基础设施不可用（5xx / 网络错）。
	// 属 Q56 B 类。
	ReturnCodeUpstreamUnavailable = 600204

	// ReturnCodeFlowReplayCorrupted = 命中已有 trade_flow 但 response_body 为空 / 反序列化失败。
	// 极罕见路径（DB 异常状态）；属 Q56 B 类。
	ReturnCodeFlowReplayCorrupted = 600205
)

// HandlerTimeout 是 createResource handler 的总超时（Q59：5s 硬约束 - 1s 网络往返 buffer）。
//
// 内部链路：trade_flow 抢占 + trade_order 反查 + ctl GetBundleByID + ctl CompletePass +
// trade_order 反向回填 + trade_flow 收尾，全部在本超时窗口内完成。
const HandlerTimeout = 4 * time.Second

// FlowType 固定为 §7.3.5 / Q62 收敛后的唯一值。
const flowType = store.FlowTypeCreateResource

// Deps 是 handler 的依赖集合，由调用方在 server 装配阶段注入。
//
// 与 checkcreate 包对比：
//   - 多了 FlowStore（Q61 抢占式幂等核心）
//   - 多了 OrderUpdater（迭代 6 仅声明接口，实际实现可在迭代 8 PlaceOrder 落地后接线；
//     本迭代允许传 nil，handler 会跳过 T4 反向回填并日志记录）
//   - 不需要 BundleDefinitionStore（Q54 5 维对账是 checkCreate 阶段做的；createResource 阶段
//     trade 信任 jifei 已经过 checkCreate，不重复对账）
type Deps struct {
	OrderStore   store.OrderStore             // §6.2 T2 反查 trade_order
	OrderUpdater OrderProvisionUpdater        // §6.2 T4 反向回填（可为 nil，迭代 8 接线）
	FlowStore    store.FlowStore              // §6.2 T1/T5 抢占式幂等
	CTLClient    ctlclient.Client             // §6.2 T3 反向调 ctl/pass
	Builder      *jifei.FrameworkBuilder      // 构造 jifei framework 双层出参
}

// OrderProvisionUpdater 是 trade_order 写端反向回填接口（§6.2 Step T4）。
//
// 仅承载 createResource 完成后回填 (status='provisioned', resource_type='pass',
// resource_id=passId) 的最小写端契约；下单 / 失败状态切换由迭代 8 + 后续生命周期需求承接。
//
// 抽象为独立 interface 而不是直接复用 store.OrderStore：
//   - 让 createresource 包的依赖最小化（只声明它真正需要的方法）
//   - 允许 nil 注入 — 迭代 8 之前 trade_order 写端尚未实现时，本字段可为 nil；handler 会
//     跳过 T4 但日志告警，避免阻塞迭代 6 主链路（ctl 那边 pass 已经生成）
type OrderProvisionUpdater interface {
	// MarkOrderProvisioned 把 trade_order 标记为已发货 + 回填 resource_id。
	//
	// 期望 SQL（迭代 8 落地）：
	//   UPDATE trade_order
	//      SET status = 'provisioned', resource_type = 'pass', resource_id = ?, updated_time = NOW()
	//    WHERE deal_name = ? AND status IN ('pending_pay', 'paid_pending_provision')
	//
	// 实际未匹配（如 status 已是 provisioned）不返错，由调用方按业务判定。
	MarkOrderProvisioned(ctx context.Context, dealName, passID string) error
}

// Install 把 createResource 真 handler 注册到 dispatcher，替代 InstallStubHandlersExceptCheckCreate
// 里的 createResource stub。
//
// 调用方约定：
//  1. 先 jifei.NewDispatcher(...)
//  2. 不再调用 InstallStubHandlersExceptCheckCreate（迭代 5 临时入口，迭代 6 起作废）
//  3. checkcreate.Install(d, ...) + createresource.Install(d, ...) 两个真 handler 各自注册
func Install(d *jifei.Dispatcher, deps Deps) {
	d.Register(jifei.InterfaceNameCreateResource, makeHandler(deps))
}

// callbackPara 是 jifei `lightvela.pass.createResource` 回调的 interface.para 业务字段集。
//
// 与 §6.1 协议字段对齐（已被 Q53/Q57/Q58 覆盖到 framework 双层）：
//   - dealName / appId / uin / subProductCode / bundleId / goodsNum / goodsDetail
//
// 字段语义见 callbackPara 注释（与 checkcreate 包同名结构对齐，独立定义避免跨包耦合）。
type callbackPara struct {
	DealName       string                 `json:"dealName"`
	AppID          string                 `json:"appId"`
	Uin            string                 `json:"uin"`
	SubProductCode string                 `json:"subProductCode"`
	BundleID       string                 `json:"bundleId"`
	GoodsNum       int                    `json:"goodsNum"`
	GoodsDetail    map[string]interface{} `json:"goodsDetail"`
}

// makeHandler 构造闭包 handler；导出便于单元测试直接构造而无需走 dispatcher。
func makeHandler(deps Deps) jifei.Handler {
	return func(ctx context.Context, paraRaw json.RawMessage) (jifei.Framework, error) {
		// (0) 总超时兜底（Q59）。
		ctx, cancel := context.WithTimeout(ctx, HandlerTimeout)
		defer cancel()

		// (1) 解码 para
		var para callbackPara
		if err := json.Unmarshal(paraRaw, &para); err != nil {
			return deps.Builder.NewError(ReturnCodeInvalidPara, fmt.Sprintf("invalid para json: %v", err)), nil
		}
		if err := validatePara(&para); err != nil {
			return deps.Builder.NewError(ReturnCodeInvalidPara, err.Error()), nil
		}

		// (2) Q61 Step T1：抢占式幂等。
		acquired, existing, err := deps.FlowStore.TryAcquireSlot(
			ctx, para.DealName, flowType, para.AppID, paraRaw,
		)
		if err != nil {
			return deps.Builder.NewError(
				ReturnCodeUpstreamUnavailable,
				fmt.Sprintf("acquire trade_flow slot: %v", err),
			), nil
		}
		if !acquired {
			// 输家分支（三分支处理）。
			return handleLoser(deps, existing), nil
		}

		// (3) 赢家路径：执行主链路；任何失败都需要在收尾时把 trade_flow 标记为 completed/failed。
		resp := runMainFlow(ctx, deps, &para, paraRaw)

		// (4) Q61 Step T5：根据响应分类持久化 trade_flow 状态。
		respBytes, marshalErr := json.Marshal(resp)
		if marshalErr != nil {
			// 几乎不可能（Framework 字段都是简单类型）；保险起见保留 in_progress 由 reconcile 兜底。
			// 不能改变 resp 内容，jifei 仍能拿到合法响应。
			return resp, nil
		}
		switch {
		case resp.ReturnCode == 0:
			// 成功收尾
			_ = deps.FlowStore.MarkCompleted(ctx, para.DealName, flowType, para.AppID, respBytes)
		case resp.ReturnCode == jifei.RefundReturnCode:
			// A 类退款收尾
			_ = deps.FlowStore.MarkFailed(ctx, para.DealName, flowType, para.AppID, respBytes)
		default:
			// B 类业务码（transient 故障 / 入参错）— 保留 in_progress，让 reconcile worker
			// 后续根据 ctl 实际状态决定 promote 到 completed / failed（设计稿 §6.4 Q61）。
			// 即不调 MarkCompleted / MarkFailed。
		}
		return resp, nil
	}
}

// runMainFlow 是赢家路径的主链路（§6.2 Step T2~T4）。
//
// 任何步骤失败均直接返对应 jifei.Framework 响应（成功 / 退款 / B 类业务码）；本函数不写
// trade_flow，由 makeHandler 顶层根据返回的 returnCode 类型决定 MarkCompleted / MarkFailed /
// 保留 in_progress。
func runMainFlow(
	ctx context.Context,
	deps Deps,
	para *callbackPara,
	_ json.RawMessage,
) jifei.Framework {
	// Step T2：反查 trade_order，并确认未已发货。
	order, err := deps.OrderStore.GetOrderByDealName(ctx, para.DealName)
	if err != nil {
		if errors.Is(err, store.ErrTradeOrderNotFound) {
			// 链路异常（jifei 持有的 dealName 与 trade 不一致）；B 类，让 jifei 重试。
			return deps.Builder.NewError(
				ReturnCodeOrderNotFound,
				fmt.Sprintf("trade_order not found for dealName=%s", para.DealName),
			)
		}
		return deps.Builder.NewError(
			ReturnCodeUpstreamUnavailable,
			fmt.Sprintf("get trade_order: %v", err),
		)
	}

	// 已发货幂等回放（Q56 b 场景）：trade_order.resource_id 已回填即视作幂等成功。
	// 即使 trade_flow 因为 trade pod 重启等原因没记录，本路径也保证响应一致。
	if order.ResourceID != "" {
		return deps.Builder.NewSuccess(map[string]any{
			"resourceId": order.ResourceID,
		})
	}

	// Step T3：反向调 ctl/pass 完成发货。
	//
	// 入参映射（§6.2 Step T3 + ctlclient.CompletePassRequest 字段集）：
	//   - UserID = trade_order.external_user_id（Lightclaw 业务用户 ID）
	//   - BundleID = trade_order.bundle_id（jifei 入参 bundleId 与 trade_order 落库应一致；
	//     handler 这里以 trade_order 为准，因为 jifei 入参 bundleId 已在 checkCreate 阶段对账过）
	//   - TimeSpan = trade_order.period
	//   - TimeUnit = trade_order.time_unit
	//   - Uin / AppID = jifei 入参的 uin / appId（与 trade_order 落库的应一致；本迭代
	//     不重复对账，信任 checkCreate 阶段已校验）
	//   - DealName = trade_order.deal_name
	//   - RenewFlag = "MANUAL_RENEW"（v4 收敛：本期不暴露 auto_renew，写死手动续费）
	uin, appID, parseErr := parseUinAppID(order.Uin, order.AppID)
	if parseErr != nil {
		// 数据不一致（trade_order 落的 uin / app_id 不是合法整数）— 永久不可发货，A 类退款。
		// 实际上下单链路应该早就阻断，能到这里说明 trade_order 写端有 bug，但仍要保护 jifei 不无限重试。
		return deps.Builder.NewRefund()
	}
	completeReq := &ctlclient.CompletePassRequest{
		UserID:    order.ExternalUserID,
		BundleID:  order.BundleID,
		TimeSpan:  order.Period,
		TimeUnit:  order.TimeUnit,
		Uin:       uin,
		AppID:     appID,
		DealName:  order.DealName,
		RenewFlag: "MANUAL_RENEW",
	}
	pass, err := deps.CTLClient.CompletePass(ctx, completeReq)
	if err != nil {
		return classifyCompletePassError(deps.Builder, err)
	}
	if pass == nil || pass.PassID == "" {
		// ctl 返 200 但没带 pass_id — 协议层异常，B 类业务码让 jifei 重试。
		return deps.Builder.NewError(
			ReturnCodeUpstreamUnavailable,
			"ctl CompletePass returned empty passId",
		)
	}

	// Step T4：反向回填 trade_order（resource_id + status）。
	//
	// 迭代 6 允许 OrderUpdater == nil（迭代 8 PlaceOrder 写端落地后才会接线）；
	// 此时 ctl 那边 pass 已经生成，仅 trade 侧 trade_order 没回填，由 reconcile 后续兜底。
	// 不阻塞协议层成功响应（jifei 拿到 pass_id 即视为发货完成）。
	if deps.OrderUpdater != nil {
		if err := deps.OrderUpdater.MarkOrderProvisioned(ctx, order.DealName, pass.PassID); err != nil {
			// 写端基础设施失败 — 不退款（ctl 已成功），只在 trade_flow 收尾时按 B 类处理；
			// jifei 重试时本 handler 会通过 trade_order.resource_id 已回填走幂等回放路径。
			//
			// 但 trade_order 没回填导致下次重试找不到 resource_id，会再次走 ctl CompletePass，
			// ctl 端有 USER_HAS_ACTIVE_PASS 兜底防御；不影响 jifei 协议层最终幂等。
			//
			// 选择返非零 returnCode 让 jifei 重试 — trade_flow 也保持 in_progress 不收尾，
			// reconcile worker 可介入。
			return deps.Builder.NewError(
				ReturnCodeUpstreamUnavailable,
				fmt.Sprintf("mark order provisioned: %v", err),
			)
		}
	}

	// 全部成功：返 framework 双层成功响应（data.resourceId = pass_id）。
	return deps.Builder.NewSuccess(map[string]any{
		"resourceId": pass.PassID,
	})
}

// handleLoser 实现 Q61 抢占失败的三分支处理（status='completed' / 'failed' / 'in_progress'）。
//
// 输入：existing 是 TryAcquireSlot 在 acquired==false 时回查的 trade_flow 记录。
func handleLoser(deps Deps, existing *store.Flow) jifei.Framework {
	// 防御：理论上 existing 不会是 nil（TryAcquireSlot 实现保证），但保留兜底。
	if existing == nil {
		return deps.Builder.NewError(
			ReturnCodeUpstreamUnavailable,
			"trade_flow exists but re-select returned nil",
		)
	}

	switch existing.Status {
	case store.FlowStatusCompleted:
		// Q61：直接回放成功响应（response_body）。
		return replayResponseBody(deps, existing.ResponseBody, ReturnCodeFlowReplayCorrupted)
	case store.FlowStatusFailed:
		// Q61：直接回放失败响应（通常是 Q56 退款响应）。
		return replayResponseBody(deps, existing.ResponseBody, ReturnCodeFlowReplayCorrupted)
	case store.FlowStatusInProgress:
		// Q61：返 B 类 returnCode，让 jifei 走重试节奏（PDF 第 8 页 1s/5s/10s/30s/.../12 个月退避）。
		return deps.Builder.NewError(
			ReturnCodeFlowInProgress,
			fmt.Sprintf("trade_flow in progress for dealName=%s; retry later", existing.DealName),
		)
	default:
		// 未知状态（DB 数据异常）— B 类。
		return deps.Builder.NewError(
			ReturnCodeUpstreamUnavailable,
			fmt.Sprintf("trade_flow unknown status=%q dealName=%s", existing.Status, existing.DealName),
		)
	}
}

// replayResponseBody 把数据库里持久化的 framework JSON 反序列化为 jifei.Framework 回放给 jifei。
//
// 关键不变量（Q61）：回放的字节级内容应与赢家原始响应一致；只回放 returnCode / returnValue /
// returnMessage / data 等业务字段，timestamp / componentName / version 也按 DB 持久化值返回 —
// 即使 timestamp 是历史值，jifei 不据此判定（PDF 没有时间敏感约束）。
//
// 反序列化失败 → 回 corruptedCode 让 jifei 重试（数据状态异常的兜底防御）。
func replayResponseBody(deps Deps, body []byte, corruptedCode int) jifei.Framework {
	if len(body) == 0 {
		return deps.Builder.NewError(corruptedCode, "trade_flow.response_body is empty")
	}
	var fw jifei.Framework
	if err := json.Unmarshal(body, &fw); err != nil {
		return deps.Builder.NewError(
			corruptedCode,
			fmt.Sprintf("trade_flow.response_body unmarshal: %v", err),
		)
	}
	// 关键校验：Q58 严格不变量 — returnCode 必须 == returnValue。
	// 如果 DB 数据破坏了不变量，按 corrupted 处理避免输出破坏 jifei 协议。
	if fw.ReturnCode != fw.ReturnValue {
		return deps.Builder.NewError(
			corruptedCode,
			fmt.Sprintf("trade_flow.response_body invariant broken: returnCode=%d returnValue=%d",
				fw.ReturnCode, fw.ReturnValue),
		)
	}
	return fw
}

// classifyCompletePassError 把 ctlclient 返回的错误按 Q56 分类映射到 jifei 出参。
//
// 分类规则（与 §6.4 + Q56 对齐）：
//   - ctlclient.ErrNotFound（HTTP 404，bundle 不存在等）→ A 类退款
//   - *ctlclient.Error 且 HTTPStatus == 4xx（非 401/404，业务级永久错）→ A 类退款
//   - ctlclient.ErrUnauthorized（HTTP 401）→ B 类（配置错，rotate 后重试可恢复）
//   - *ctlclient.Error 且 HTTPStatus >= 500 → B 类
//   - context.DeadlineExceeded / 网络错 → B 类
//   - 其他未识别错 → B 类（保守，避免误退款）
func classifyCompletePassError(builder *jifei.FrameworkBuilder, err error) jifei.Framework {
	if err == nil {
		// 不应到这里
		return builder.NewError(ReturnCodeUpstreamUnavailable, "nil error treated as upstream failure")
	}

	// ErrNotFound：bundle 已删除 / pass 资源已不存在等 → 永久不可发货 → 退款
	if errors.Is(err, ctlclient.ErrNotFound) {
		return builder.NewRefund()
	}
	// ErrUnauthorized：trade ↔ ctl 内部 token 不一致 — 配置错，rotate 后可恢复 → B 类
	if errors.Is(err, ctlclient.ErrUnauthorized) {
		return builder.NewError(ReturnCodeUpstreamUnavailable, fmt.Sprintf("ctl unauthorized: %v", err))
	}

	var ctlErr *ctlclient.Error
	if errors.As(err, &ctlErr) {
		switch {
		case ctlErr.HTTPStatus >= 400 && ctlErr.HTTPStatus < 500:
			// 4xx 业务级错（USER_HAS_ACTIVE_PASS / quota 不足 / bundle 下架 / 入参错等）
			// 一律按 A 类退款 — 业务永久不可发货，jifei 重试也无意义。
			return builder.NewRefund()
		case ctlErr.HTTPStatus >= 500:
			return builder.NewError(
				ReturnCodeUpstreamUnavailable,
				fmt.Sprintf("ctl 5xx: code=%s message=%s request_id=%s",
					ctlErr.Code, ctlErr.Message, ctlErr.RequestID),
			)
		}
	}

	// 网络错 / 超时 / 未识别错 → B 类
	return builder.NewError(
		ReturnCodeUpstreamUnavailable,
		fmt.Sprintf("ctl CompletePass: %v", err),
	)
}

// validatePara 校验 createResource 入参必填字段。
//
// 与 checkcreate 包对应函数对齐；createResource 阶段对 goodsNum / goodsDetail 也强约束（jifei
// 协议层一定会带）。
func validatePara(p *callbackPara) error {
	if p.DealName == "" {
		return errors.New("dealName is required")
	}
	if p.AppID == "" {
		return errors.New("appId is required")
	}
	if p.BundleID == "" {
		return errors.New("bundleId is required")
	}
	if p.GoodsNum <= 0 {
		return errors.New("goodsNum must be > 0")
	}
	return nil
}

// parseUinAppID 把 trade_order.uin / app_id 字符串字段转 int64（与 ctlclient.CompletePassRequest
// 的字段类型对齐）。
//
// 选取约定：
//   - 空字符串 → 0（对 ctl 来说 0 是非法值，但本期 trade_order 写端始终落非空）
//   - 解析失败 → 返 error，handler 按"数据不一致"决定退款
func parseUinAppID(uinStr, appIDStr string) (int64, int64, error) {
	uin, err := parseInt64(uinStr)
	if err != nil {
		return 0, 0, fmt.Errorf("uin: %w", err)
	}
	appID, err := parseInt64(appIDStr)
	if err != nil {
		return 0, 0, fmt.Errorf("app_id: %w", err)
	}
	return uin, appID, nil
}

// parseInt64 把字符串转 int64；空字符串视为 0（trade_order 写端不应落空字符串）。
func parseInt64(s string) (int64, error) {
	if s == "" {
		return 0, nil
	}
	var n int64
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, fmt.Errorf("invalid digit %q in %q", c, s)
		}
		n = n*10 + int64(c-'0')
	}
	return n, nil
}
