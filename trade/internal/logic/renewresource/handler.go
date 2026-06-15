// Package renewresource 实现 jifei `lightvela.pass.renewResource` 回调的同步续费 handler。
//
// 设计稿引用（.tmp/trade-pass-renew-design.md）：
//   - §3.6 renewResource 回调主流程（trade → 反向调 ctl/pass.RenewPass）
//   - §4.2 字段维度对照表（order_type='renew' / flow_type='renew_resource'）
//   - §4.5 错误码归并表（60050x，与 createresource 60020x / isolate 60030x / checkrenew 60040x 错开）
//   - §6 Q15=a：dealName 非空铁律（trade store 写端已 panic 兜底，handler 仍 defensive 校验）
//   - §6 Q19=b：timeUnit ∈ {y,m,d} 全链路接受（与 checkrenew Q12=a 一致）
//   - §6 Q56：A 类业务永久不可发货 → 退款响应（returnCode=352014）；
//     B 类基础设施 transient 故障 → 非零业务码 returnCode 让 jifei 重试
//   - §6 Q59：5s 同步硬约束 → handler 收紧到 4s（ctlclient 默认 4s 内置超时）
//   - §6 Q61：抢占式幂等三态状态机（trade_flow.flow_type=renew_resource）
//   - §6 Q62：本 handler 写 trade_flow（与 checkRenew 不写形成对比）
//
// 与 createresource 包的关键差异：
//
//	┌────────────────┬────────────────────────────┬────────────────────────────┐
//	│                │ createresource             │ renewresource              │
//	├────────────────┼────────────────────────────┼────────────────────────────┤
//	│ flow_type      │ create_resource            │ renew_resource             │
//	│ order_type     │ create                     │ renew                      │
//	│ ctl 调用       │ CompletePass(req)          │ RenewPass(passID, req)     │
//	│ 入参 resourceId│ 不传（创建链路无 pass）    │ 必传（续费目标 pass）      │
//	│ 反向回填       │ MarkOrderProvisioned       │ 不需要（续费 expired_time  │
//	│                │ (status / resource_id)     │ 由 ctl 维护，trade_order   │
//	│                │                            │ 仅状态推进，本期不强求）   │
//	│ ctl 错误归并   │ 4xx → 退款 / 5xx → B 类    │ 4xx → 退款 / 5xx → B 类    │
//	│                │                            │ + ErrCodePassRenewing 特例 │
//	│                │                            │ → 退款（pass 已在续费中，  │
//	│                │                            │   重复续费不可发货）       │
//	└────────────────┴────────────────────────────┴────────────────────────────┘
//
// Q56 退款触发场景（renewResource 范式收敛 — v1.7.28 BUG-25 修订 2026-05-21）：
//
//	**v1.7.28 BUG-25 之前**：a~e 是基于 trade_order 反查的 5 类数据漂移退款规则，但实测
//	jifei 同步推 renewResource 早于 PlaceRenewOrderAndPay INSERT trade_order，导致赢家路径
//	反查 600502 + trade_flow 抢占成功 → 后续 retry 600503 死循环（与新购 BUG-22 同模式）。
//
//	**v1.7.28 BUG-25 修订**：runMainFlow 完全脱离 trade_order 反查依赖（与 createresource
//	BUG-22 a63ba845 同范式）。renewResource 协议比 createResource 更简单 — jifei 续费协议
//	callbackPara 顶层就有 resourceId（pass_id），不需从 goodsDetail 透传。trade_order 维度
//	交叉校验（order_type/resource_type/resource_id 一致性）整体下放：trade_order 退化为
//	"订单流水记录"职责，不在发货关键路径上。
//
//	a. trade_order 不存在 → 不阻塞主链路，正常调 ctl.RenewPass（与 createresource BUG-22 同）
//	b. ctl RenewPass 返 ErrCodePassRenewing → A 类退款（pass 已在续费中重复触发）
//	c. ctl RenewPass 返 ErrCodePassNotFound（404）→ A 类退款
//	d. ctl RenewPass 返 ErrCodePassNotRenewable（403）→ A 类退款（pass 已 isolated/deleted）
//	e. ctl RenewPass 返 4xx 业务级错（PASS_INVALID_PARAM 等）→ A 类退款
//	f. ctl RenewPass 返 ErrCodePassRenewNotImplement（501，cvm 异步占位）→ B 类（让 jifei 重试，等 R-D 落地）
//	g. ctl RenewPass 返 5xx / 网络错 / 超时 → B 类（让 jifei 重试）
//
//	**v1.7.32 BUG-XX 修订（2026-06-08）**：原 v1.7.28 BUG-25 引入的 b. "trade_order.resource_id
//	已回填 → 幂等回放" 规则误适配续费场景 — 续费的 trade_order.resource_id 在 PlaceRenewOrder
//	INSERT 时即写入 pass_id（不像新购 BUG-22 是 createResource 后回填），导致首次正常 jifei
//	回调即被误判为"已发货回放"，跳过 ctl.RenewPass 调用，pass.expired_time 永不推后。已删除
//	runMainFlow Step T2；jifei 重投同 dealName 的幂等保护由外层 TryAcquireSlot + handleLoser
//	完整覆盖（loser 路径回放 trade_flow.response_body）。
package renewresource

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// 业务层 returnCode（区间 60050x，与 createresource 60020x / isolate 60030x / checkrenew 60040x 错开）。
//
// 设计稿 §4.5 错误码归并表（renewResource 段）。
const (
	// ReturnCodeInvalidPara = jifei 入参 JSON 解析失败 / 必填字段缺失。
	// 属 Q56 B 类（jifei 重试）。
	ReturnCodeInvalidPara = 600501

	// ReturnCodeOrderNotFound = trade_order 反查无记录。
	// 属 Q56 B 类（链路异常 / trade pod 重启等）。
	//
	// **v1.7.28 BUG-25 修订（2026-05-21）**：runMainFlow 已脱离 trade_order 反查依赖（与
	// createresource BUG-22 a63ba845 同范式），主链路不会再返此码。常量保留用于：
	//   - 向前兼容（外部依赖此符号的代码不需改动）
	//   - 错误码段位（60050x）连续性，便于排障日志识别
	//   - 未来如 reconcile worker 或其它路径需要 jifei 重试语义可复用
	ReturnCodeOrderNotFound = 600502

	// ReturnCodeFlowInProgress = 抢占失败且现存记录处于 in_progress（其他实例 / 上次还在跑）。
	// 属 Q56 B 类（让 jifei 走重试节奏退避，等待主链路完成）。
	ReturnCodeFlowInProgress = 600503

	// ReturnCodeUpstreamUnavailable = ctl / DB 上游基础设施不可用（5xx / 网络错 / 501 占位）。
	// 属 Q56 B 类。
	ReturnCodeUpstreamUnavailable = 600504

	// ReturnCodeFlowReplayCorrupted = 命中已有 trade_flow 但 response_body 为空 / 反序列化失败。
	// 极罕见路径（DB 异常状态）；属 Q56 B 类。
	ReturnCodeFlowReplayCorrupted = 600505
)

// HandlerTimeout 是 renewResource handler 的总超时（Q59：5s 硬约束 - 1s 网络往返 buffer）。
//
// 内部链路：trade_flow 抢占 + trade_order 反查 + ctl RenewPass + trade_flow 收尾，
// 全部在本超时窗口内完成。
const HandlerTimeout = 4 * time.Second

// FlowType 固定为 §4.2 / store.FlowTypeRenewResource。
const flowType = store.FlowTypeRenewResource

// Deps 是 handler 的依赖集合，由调用方在 server 装配阶段注入。
//
// 与 createresource 包对比：
//   - 不需要 OrderUpdater：续费的 expired_time 由 ctl pass 维护（R-B logic.RenewPass 已落地），
//     trade_order 本期不强求状态推进（设计稿 §4.4 trade_order 续费不更新 expire_time，
//     由 ctl pass 真源 + reconcile worker 兜底；TradeOrder 已含 OrderType 字段，
//     续费成功后状态推进可在 R-D 联调阶段补 OrderRenewUpdater 接口）。
//   - 其余 4 字段（OrderStore / FlowStore / CTLClient / Builder）与 createresource 同型。
//
// **v1.7.32 BUG-XX 修订（2026-06-08）**：runMainFlow 已不再调用 OrderStore — 原 v1.7.28 BUG-25
// 引入的"trade_order.resource_id 已回填 → 幂等回放"分支在续费场景下永远命中（续费的 trade_order.resource_id
// 在 PlaceRenewOrder INSERT 时就是 pass_id，非新购的"createResource 后回填"语义），导致每次续费都
// 跳过 ctl.RenewPass 调用。Step T2 已删除；OrderStore 字段保留仅为向后兼容（外部装配代码不需调整），
// 主链路完全不依赖。jifei 重投幂等由外层 TryAcquireSlot + handleLoser 抢占式状态机覆盖。
type Deps struct {
	OrderStore store.OrderStore        // 已废弃（v1.7.32 BUG-XX）；保留仅为向后兼容，runMainFlow 不再调用
	FlowStore  store.FlowStore         // §3.6 抢占式幂等
	CTLClient  ctlclient.Client        // §3.6 反向调 ctl/pass.RenewPass
	Builder    *jifei.FrameworkBuilder // 构造 jifei framework 双层出参
}

// Install 把 renewResource 真 handler 注册到 dispatcher，替代 InstallStubHandlers
// 里的 renewResource stub。
//
// 调用方约定：
//  1. 先 jifei.NewDispatcher(...)
//  2. checkrenew.Install(d, ...) + renewresource.Install(d, ...) 两个真 handler 各自注册
func Install(d *jifei.Dispatcher, deps Deps) {
	d.Register(jifei.InterfaceNameRenewResource, makeHandler(deps))
}

// callbackPara 是 jifei `lightvela.pass.renewResource` 回调的 interface.para 业务字段集。
//
// 字段语义（对齐 PDF §2.3 renewResource 协议 + .tmp/trade-pass-renew-design.md §3.6）：
//   - DealName：jifei 续费订单 dealName，非空铁律（trade 调本接口前 R-C Q15=a panic 兜底）
//   - AppID / Uin：jifei 协议层用户 appId / uin（数据漂移校验依据）
//   - ResourceID：续费目标 pass_id（与 trade_order.resource_id 必须一致）
//   - GoodsDetail：jifei goodsDetail 透传字段（取 timeSpan/timeUnit 用于 ctl 调用）
//
// 字段类型说明（每个字段都标注 PDF 协议类型，铁律见 jifei/envelope.go 包注释）：
//   - DealName: PDF "string"。
//   - AppID: PDF "long"（int）— jifei 实测发 number。**v1.7.28 BUG-06 同模式修复
//     (2026-05-21)**：原定义 string，与 PDF 不符；FlowStore.Mark* 接口签名仍是
//     appID string（DB 列存 string），handler 内调用时用 strconv.FormatInt 转一次。
//   - Uin: PDF "string"（quoted）。
//   - ResourceID: PDF "string"。
//   - GoodsNum: PDF "int"。
type callbackPara struct {
	DealName    string                 `json:"dealName"`    // PDF: string
	AppID       int64                  `json:"appId"`       // PDF: long (number); v1.7.28 BUG-06 同模式修复
	Uin         string                 `json:"uin"`         // PDF: string (quoted)
	ResourceID  string                 `json:"resourceId"`  // PDF: string
	GoodsNum    int                    `json:"goodsNum"`    // PDF: int
	GoodsDetail map[string]interface{} `json:"goodsDetail"` // PDF: object
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
		// FlowStore 接口签名 appID string（DB 列存 string）；para.AppID 是 PDF/jifei 实测的
		// number → 落库前转字符串，与 DB schema 兼容（见 callbackPara.AppID 注释 BUG-06 修复）。
		appIDStr := strconv.FormatInt(para.AppID, 10)

		// (2) Q61 抢占式幂等。
		acquired, existing, err := deps.FlowStore.TryAcquireSlot(
			ctx, para.DealName, flowType, appIDStr, paraRaw,
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
		//
		// **v1.7.28 BUG-28 修订（与 PDF 协议对齐）**：renewResource 出参 PDF 协议仅允许返
		// `data.flowId`（异步语义，不能为 0），完全没有 resourceId / resourceIds 字段。
		// 赢家路径 acquired==true 下多一次 SELECT 拿 trade_flow.id 作为 flowId 返回。
		winnerFlow, getErr := deps.FlowStore.GetFlow(ctx, para.DealName, flowType, appIDStr)
		if getErr != nil || winnerFlow == nil {
			// 意外：刚 INSERT 成功但联合唯一键反查不到，极少见。返 B 类让 jifei 重试 + log 告警。
			return deps.Builder.NewError(
				ReturnCodeUpstreamUnavailable,
				fmt.Sprintf("re-select winner trade_flow id failed: %v", getErr),
			), nil
		}
		flowID := winnerFlow.ID

		resp := runMainFlow(ctx, deps, &para, flowID)

		// (4) Q61 收尾：根据响应分类持久化 trade_flow 状态。
		respBytes, marshalErr := json.Marshal(resp)
		if marshalErr != nil {
			// 几乎不可能（Framework 字段都是简单类型）；保险起见保留 in_progress 由 reconcile 兜底。
			return resp, nil
		}
		switch {
		case resp.ReturnCode == 0:
			// 成功收尾
			_ = deps.FlowStore.MarkCompleted(ctx, para.DealName, flowType, appIDStr, respBytes)
		case resp.ReturnCode == jifei.RefundReturnCode:
			// A 类退款收尾
			_ = deps.FlowStore.MarkFailed(ctx, para.DealName, flowType, appIDStr, respBytes)
		default:
			// B 类业务码（transient 故障 / 入参错）— 保留 in_progress，让 reconcile worker
			// 后续根据 ctl 实际状态决定 promote 到 completed / failed（设计稿 §4.6 reconcile）。
		}
		return resp, nil
	}
}

// runMainFlow 是赢家路径的主链路（§3.6 Step T2~T4）。
//
// 任何步骤失败均直接返对应 jifei.Framework 响应（成功 / 退款 / B 类业务码）；本函数不写
// trade_flow，由 makeHandler 顶层根据返回的 returnCode 类型决定 MarkCompleted / MarkFailed /
// 保留 in_progress。
//
// **v1.7.28 BUG-25 修订（2026-05-21 用户拍板）**：与 createresource BUG-22 a63ba845 同范式，
// 完全脱离 trade_order 反查依赖。
//
//   - 原设计（v1.7.28 BUG-25 之前）：runMainFlow Step T2 反查 trade_order 拿 Period/TimeUnit/
//     ResourceID/DealName，并在 T2.1 做 4 类数据漂移交叉校验（order_type/resource_type/
//     resource_id 一致性）；但 PlaceRenewOrderAndPay 时序问题导致 jifei 同步推 renewResource
//     早于 trade INSERT trade_order，T2 永远 600502 + trade_flow 抢占 in_progress 死锁。
//
//   - v1.7.28 BUG-25 修订：renewResource 协议比 createResource 更简单 — jifei callbackPara
//     顶层就有 resourceId（pass_id），不需要从 goodsDetail 透传。runMainFlow 直接从 jifei
//     入参 + goodsDetail 拿全部字段调 ctl.RenewPass，不依赖 trade_order：
//
//   - ResourceID = para.ResourceID（jifei 协议字段，必填）
//
//   - DealName   = para.DealName（jifei 协议字段，必填）
//
//   - TimeSpan   = goodsDetail.timeSpan（jifei 协议字段；与 PlaceRenewOrder 入参一致）
//
//   - TimeUnit   = goodsDetail.timeUnit（同上）
//
//   - FlowID     = 0（本期由 trade_flow + reconcile 兜底）
//
//     trade_order 维度交叉校验（order_type/resource_type/resource_id 一致性）整体下放：
//     trade_order 退化为 "订单流水记录"职责，不在发货关键路径上。
//
// **v1.7.32 BUG-XX 修订（2026-06-08）**：删除原 v1.7.28 BUG-25 引入的 Step T2 "trade_order
// 幂等回放"分支。该分支误适配续费场景 — 续费的 trade_order.resource_id 在 PlaceRenewOrder
// INSERT 时即写入 pass_id（与新购 BUG-22 "createResource 后回填"语义不同），导致首次正常
// jifei 回调即被误判为"已发货回放"，跳过 ctl.RenewPass 调用，pass.expired_time 永远不推后。
// jifei 重投同 dealName 的幂等保护由外层 TryAcquireSlot + handleLoser 完整覆盖（loser 路径
// 回放 trade_flow.response_body）；ctl.RenewPass 自身亦有 ErrCodePassRenewing 幂等保护。
func runMainFlow(
	ctx context.Context,
	deps Deps,
	para *callbackPara,
	flowID int64,
) jifei.Framework {
	// Step T3：从 jifei 入参 + goodsDetail 提取业务字段，反向调 ctl.RenewPass 派发续费 task。
	//
	// 字段映射（v1.7.28 BUG-25 修订：完全脱离 trade_order）：
	//   - PassID    = para.ResourceID（jifei 协议字段；validatePara 已校验非空）
	//   - DealName  = para.DealName（jifei 协议字段；validatePara 已校验非空）
	//   - TimeSpan  = goodsDetail.timeSpan（jifei 协议字段；PlaceRenewOrder 落库时透传）
	//   - TimeUnit  = goodsDetail.timeUnit（同上）
	//   - FlowID    = 0（本期由 trade_flow + reconcile 兜底）
	timeSpan := extractIntFromGoodsDetail(para.GoodsDetail, "timeSpan")
	if timeSpan <= 0 {
		return deps.Builder.NewError(
			ReturnCodeInvalidPara,
			fmt.Sprintf("goodsDetail.timeSpan must be > 0, got %d", timeSpan),
		)
	}
	timeUnit := extractStringFromGoodsDetail(para.GoodsDetail, "timeUnit")
	if timeUnit == "" {
		return deps.Builder.NewError(
			ReturnCodeInvalidPara,
			"goodsDetail.timeUnit is required",
		)
	}
	renewReq := &ctlclient.RenewPassRequest{
		TimeSpan: timeSpan,
		TimeUnit: timeUnit,
		DealName: para.DealName,
		FlowID:   0, // R-D 落地 ctl callback 后再补；本期由 trade_flow + reconcile 兜底
	}
	pass, err := deps.CTLClient.RenewPass(ctx, para.ResourceID, renewReq)
	if err != nil {
		return classifyRenewPassError(deps.Builder, err)
	}
	if pass == nil || pass.PassID == "" {
		// ctl 返 200 但没带 pass_id — 协议层异常，B 类业务码让 jifei 重试。
		return deps.Builder.NewError(
			ReturnCodeUpstreamUnavailable,
			"ctl RenewPass returned empty passId",
		)
	}

	// Step T4：返 framework 双层成功响应。
	//
	// **v1.7.28 BUG-28 修订 (PDF renewResource.pdf §3.2 返参)**：
	// data 只能返 `flowId` (int, 异步不能为 0)，完全没有 resourceId / resourceIds。
	// 该 flowId == trade_flow.id (BIGINT 自增 PK)，全局递增非 0。
	//
	// 续费成功后 trade_order 不需要反向回填 resource_id（下单时已写入），也不需要状态推进
	// （续费的 expired_time 由 ctl pass 真源维护，trade_order 本期不更新；R-D 联调可补 OrderRenewUpdater
	// 推进 trade_order.status）。ctl 回显的 pass.PassID 与入参 para.ResourceID 应一致，不一致也不
	// 阻塞协议层成功响应（仅在 trade_flow.response_body 留痕便于排障）。
	return deps.Builder.NewSuccess(map[string]any{
		"flowId": flowID,
	})
}

// extractStringFromGoodsDetail 从 jifei goodsDetail map 中安全取出 string 字段。
//
// 与 createresource 包内同名函数语义一致；renewresource 包独立实现避免跨包耦合。
// goodsDetail 是 map[string]interface{}（jifei 协议透传 object），key 不存在 / 类型不匹配
// 时返回空字符串（由调用方判定是否合法）。
func extractStringFromGoodsDetail(goodsDetail map[string]interface{}, key string) string {
	if goodsDetail == nil {
		return ""
	}
	v, ok := goodsDetail[key]
	if !ok {
		return ""
	}
	s, _ := v.(string)
	return s
}

// extractIntFromGoodsDetail 从 jifei goodsDetail map 中安全取出 int 字段（兼容 float64 /
// json.Number — encoding/json 默认把 number 反序列化为 float64，jifei 协议层 number 字段
// 在 trade 端表现为 float64）。
//
// 与 createresource 包内同名函数语义一致；renewresource 包独立实现避免跨包耦合。
// key 不存在 / 类型不匹配 / 转换失败时返回 0（由调用方判定是否合法）。
func extractIntFromGoodsDetail(goodsDetail map[string]interface{}, key string) int {
	if goodsDetail == nil {
		return 0
	}
	v, ok := goodsDetail[key]
	if !ok {
		return 0
	}
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	case json.Number:
		i, err := n.Int64()
		if err != nil {
			return 0
		}
		return int(i)
	default:
		return 0
	}
}

// handleLoser 实现 Q61 抢占失败的三分支处理（status='completed' / 'failed' / 'in_progress'）。
//
// 输入：existing 是 TryAcquireSlot 在 acquired==false 时回查的 trade_flow 记录。
//
// 与 createresource 同型；保留独立实现避免跨包耦合（jifei builder 字段集差异 / 错误码段差异）。
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
		// Q61：返 B 类 returnCode，让 jifei 走重试节奏。
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
// 关键不变量（Q61 + Q58）：回放的 returnCode 必须 == returnValue；不变量破坏时按 corrupted 兜底。
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
	if fw.ReturnCode != fw.ReturnValue {
		return deps.Builder.NewError(
			corruptedCode,
			fmt.Sprintf("trade_flow.response_body invariant broken: returnCode=%d returnValue=%d",
				fw.ReturnCode, fw.ReturnValue),
		)
	}
	return fw
}

// classifyRenewPassError 把 ctlclient.RenewPass 返回的错误按 Q56 分类映射到 jifei 出参。
//
// 分类规则（与设计稿 §4.5 错误码归并表 + Q56 对齐）：
//   - ctlclient.ErrNotFound（HTTP 404，pass 不存在）→ A 类退款
//   - *ctlclient.Error 且 Code == ErrCodePassRenewing（403，pass 已在续费中）→ A 类退款
//     （重复续费视为永久不可发货 — 同一 pass 不应被并发续费两次；jifei 重试无意义）
//   - *ctlclient.Error 且 Code == ErrCodePassNotRenewable（403，pass isolated/deleted）→ A 类退款
//   - *ctlclient.Error 且 Code == ErrCodePassRenewNotImplement（501，cvm 异步占位）→ B 类
//     （让 jifei 重试，等 R-D 落地后即可联调通；本期 sandbox-bj-7 不会触发，但保留兜底）
//   - *ctlclient.Error 且 HTTPStatus == 4xx（其他 4xx 业务级永久错）→ A 类退款
//   - ctlclient.ErrUnauthorized（HTTP 401）→ B 类（配置错，rotate 后重试可恢复）
//   - *ctlclient.Error 且 HTTPStatus >= 500 → B 类
//   - context.DeadlineExceeded / 网络错 → B 类
//   - 其他未识别错 → B 类（保守，避免误退款）
func classifyRenewPassError(builder *jifei.FrameworkBuilder, err error) jifei.Framework {
	if err == nil {
		// 不应到这里
		return builder.NewError(ReturnCodeUpstreamUnavailable, "nil error treated as upstream failure")
	}

	// ErrNotFound：pass 已被销毁 / pass_id 不存在 → 永久不可发货 → 退款
	if errors.Is(err, ctlclient.ErrNotFound) {
		return builder.NewRefund()
	}
	// ErrUnauthorized：trade ↔ ctl 内部 token 不一致 — 配置错，rotate 后可恢复 → B 类
	if errors.Is(err, ctlclient.ErrUnauthorized) {
		return builder.NewError(ReturnCodeUpstreamUnavailable, fmt.Sprintf("ctl unauthorized: %v", err))
	}

	var ctlErr *ctlclient.Error
	if errors.As(err, &ctlErr) {
		// 优先按业务 Code 分类（更精确，与 ctl errcode 常量对齐）
		switch ctlErr.Code {
		case ctlclient.ErrCodePassRenewing:
			// pass 已在续费中（重入幂等保护）— 同一 pass 不应被并发续费 → A 类退款
			return builder.NewRefund()
		case ctlclient.ErrCodePassNotRenewable:
			// pass 已 isolated/deleted/超 12 月续费窗口 → A 类退款
			return builder.NewRefund()
		case ctlclient.ErrCodePassNotFound:
			// 双重保护：ctl 走 *Error 而非 ErrNotFound 分支时（如 ctl envelope 解析异常）兜底
			return builder.NewRefund()
		case ctlclient.ErrCodePassRenewNotImplement:
			// cvm-kind 异步路径 501 占位，本期 sandbox 同步路径不应触发；
			// 让 jifei 重试，等 R-D 落地后即可联调通。
			return builder.NewError(
				ReturnCodeUpstreamUnavailable,
				fmt.Sprintf("ctl RenewPass not implemented yet: code=%s message=%s request_id=%s",
					ctlErr.Code, ctlErr.Message, ctlErr.RequestID),
			)
		}

		// 按 HTTPStatus 兜底分类
		switch {
		case ctlErr.HTTPStatus >= 400 && ctlErr.HTTPStatus < 500:
			// 其他 4xx 业务级错（PASS_INVALID_PARAM 等）→ A 类退款
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
		fmt.Sprintf("ctl RenewPass: %v", err),
	)
}

// validatePara 校验 renewResource 入参必填字段。
//
// 与 createresource 包对应函数对齐；renewResource 阶段强约束 resourceId（创建链路无此字段）。
func validatePara(p *callbackPara) error {
	if p.DealName == "" {
		return errors.New("dealName is required")
	}
	if p.AppID == 0 {
		return errors.New("appId is required")
	}
	if p.ResourceID == "" {
		return errors.New("resourceId is required")
	}
	// v1.7.28 BUG-14 同模式修复 (2026-05-21)：jifei renewResource 顶层不发 goodsNum
	// (PDF §请求参数: 顶层无 para.goodsNum, 只有 para.goodsDetail.goodsNum 嵌套)；
	// 业务路径不读 callbackPara.GoodsNum，删除此校验防误拒 jifei 真实回调。
	return nil
}
