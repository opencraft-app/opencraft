// Package modifyresource 实现 jifei `lightvela.pass.modifyResource` 回调的变配发货 handler。
//
// 需求：TAPD 1010132091137784162 §4.1 / §5.2 / §7.1
//
// 与 renewresource 的对偶关系：
//
//	┌─────────────────┬────────────────────────────┬────────────────────────────┐
//	│                 │ renewresource              │ modifyresource             │
//	├─────────────────┼────────────────────────────┼────────────────────────────┤
//	│ flow_type       │ renew_resource             │ modify_resource            │
//	│ ctl 调用        │ RenewPass(passID, req)     │ ModifyPass(passID, req)    │
//	│ 关键 goodsDetail│ timeSpan / timeUnit        │ oldConfig / newConfig      │
//	│ trade_flow_id   │ 0（本期不透传）            │ 必传（ctl 幂等与回调都要） │
//	└─────────────────┴────────────────────────────┴────────────────────────────┘
//
// trade_flow_id 必传是这条链路与续费最实质的差异：CTL 把它写进 pass.modify_flow_id，
// 用来区分"同一笔单重投"和"另一笔单插队"；变配父 task 终态时也用它回调
// POST /internal/trade/flows/{id}/complete 把 trade_flow 推到 completed。
//
// 主链路不依赖 trade_order 反查：与 createresource BUG-22 / renewresource BUG-25 同范式。
// 成功受理只把 flowId、resourceId 和可回放响应记在 in_progress 的 trade_flow 中；只有
// CTL 父任务真正完成实例、套餐和权益收敛后，才由 /internal/trade/flows/{id}/complete
// 推进 trade_flow=completed 与 trade_order=provisioned。
//
// 源 / 目标套餐从 goodsDetail 的 oldConfig / newConfig 用 SV 集合反查
// （bundleresolve.ModifyBundles）。**不能**用 trade 出向时塞的 bundleId /
// newBundleId：计费只回传协议内认识的字段，这两个自定义键实测被丢弃
// （2026-09-02，checkModify 与本 handler 分别以 600801 / 600901 暴露过）。
// 详细依据见 jifei.ResolveModifyBundlesBySV 的包注释。
//
// 退款语义（Q56 A/B 分类）：
//   - A 类（永久不可发货 → returnCode=352014 退款）：pass 不存在、状态不可变配、
//     另一笔变配占用、套餐关系不允许、配置漂移、实例未就绪
//   - B 类（基础设施 transient → 非零业务码让 jifei 重试）：ctl 5xx / 网络错 / 超时 /
//     入参解析失败 / trade_flow 抢占失败
//
// 错误码段 60090x（与 checkmodify 60080x / transfer 60070x 错开）。
package modifyresource

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"git.woa.com/wisp/mono/trade/internal/bundleresolve"
	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	jifeiproto "git.woa.com/wisp/mono/trade/internal/jifei"
	"git.woa.com/wisp/mono/trade/internal/store"
)

const (
	// ReturnCodeInvalidPara jifei 入参 JSON 解析失败 / 必填缺失 / goodsDetail 缺
	// oldConfig 或 newConfig，以及 SV 反查不出唯一套餐。属 B 类：出向链路或协议
	// 异常、运营改了 SV 还没同步接入单，重试期间修好就能正常发货；而且这类情况下
	// 退款的判断依据不足。
	ReturnCodeInvalidPara = 600901

	// ReturnCodeFlowInProgress 抢占失败且现存 trade_flow 仍 in_progress。属 B 类，
	// 让 jifei 按重试节奏退避，等主链路（CTL 变配父 task）跑完。
	ReturnCodeFlowInProgress = 600902

	// ReturnCodeUpstreamUnavailable ctl / DB 上游不可用（5xx / 网络错 / 超时）。属 B 类。
	ReturnCodeUpstreamUnavailable = 600903

	// ReturnCodeFlowReplayCorrupted 命中已有 trade_flow 但 response_body 空或不合不变量。
	// 极罕见（DB 异常状态）；属 B 类。
	ReturnCodeFlowReplayCorrupted = 600904
)

// HandlerTimeout 是总超时。jifei 同步硬约束 5s，留 1s 网络往返 buffer。
//
// 本 handler 只做"受理"：ctl 侧 ModifyPass 是 CAS + 入队，不等实例真的改完
// （那要十几分钟）。真正的收敛由 CTL 变配父 task 推进，终态时回调
// /internal/trade/flows/{id}/complete。
const HandlerTimeout = 4 * time.Second

const flowType = store.FlowTypeModifyResource

// CTLCallTimeout 是 ctl ModifyPass 的子上下文超时，留出 trade_flow 收尾的时间。
const CTLCallTimeout = 3 * time.Second

// Deps 是 handler 的依赖集合。
//
// 不含 OrderStore：主链路不反查 trade_order（见包注释）。
type Deps struct {
	FlowStore store.FlowStore
	CTLClient ctlclient.Client
	Builder   *jifei.FrameworkBuilder

	// BundleStore 用于按 oldConfig / newConfig 的 SV 集合反查源 / 目标套餐。
	// nil 时 handler 一律以 ReturnCodeInvalidPara（B 类，可重试）拒绝受理，
	// 而不是拿空 bundleID 去调 CTL —— 后者会让 CTL 侧以配置不符退款，
	// 把一个装配缺陷变成用户退款。
	BundleStore store.BundleDefinitionStore
}

// acceptedFlowRecorder is intentionally narrower than store.FlowStore so the
// new persistence operation does not force unrelated FlowStore test doubles to
// implement a method they never use.
type acceptedFlowRecorder interface {
	RecordAcceptedByID(ctx context.Context, id int64, resourceID string, responseBody []byte) error
}

// Install 把 modifyResource 真 handler 注册到 dispatcher。
func Install(d *jifei.Dispatcher, deps Deps) {
	d.Register(jifei.InterfaceNameModifyResource, makeHandler(deps))
}

// callbackPara 是 modifyResource 回调的 interface.para 业务字段集。
//
// 字段类型按 jifei PDF 标注（铁律见 jifei/envelope.go 包注释）：
// dealName / uin / resourceId 是 string，appId 是 long（number）。
type callbackPara struct {
	DealName   string `json:"dealName"`   // PDF: string
	AppID      int64  `json:"appId"`      // PDF: long (number)
	Uin        string `json:"uin"`        // PDF: string (quoted)
	ResourceID string `json:"resourceId"` // PDF: string
	TranID     string `json:"tranId"`     // PDF: string，仅留痕

	ProductCode    string `json:"productCode"`
	SubProductCode string `json:"subProductCode"`

	GoodsDetail map[string]interface{} `json:"goodsDetail"` // PDF: object
}

func makeHandler(deps Deps) jifei.Handler {
	return func(ctx context.Context, paraRaw json.RawMessage) (jifei.Framework, error) {
		ctx, cancel := context.WithTimeout(ctx, HandlerTimeout)
		defer cancel()

		var para callbackPara
		if err := json.Unmarshal(paraRaw, &para); err != nil {
			return deps.Builder.NewError(ReturnCodeInvalidPara,
				fmt.Sprintf("invalid para json: %v", err)), nil
		}
		if err := validatePara(&para); err != nil {
			return deps.Builder.NewError(ReturnCodeInvalidPara, err.Error()), nil
		}
		// FlowStore 的 appID 参数是 string（DB 列存 string）；jifei 发的是 number。
		appIDStr := strconv.FormatInt(para.AppID, 10)

		acquired, existing, err := deps.FlowStore.TryAcquireSlot(ctx, para.DealName, flowType, appIDStr, paraRaw)
		if err != nil {
			return deps.Builder.NewError(ReturnCodeUpstreamUnavailable,
				fmt.Sprintf("acquire trade_flow slot: %v", err)), nil
		}
		if !acquired {
			// A crash or transient DB failure may leave the slot created but without
			// an accepted response. Re-run the CTL accept call with the same flow ID;
			// CTL treats that ID idempotently, so this repairs the orphan safely.
			if existing != nil && existing.Status == store.FlowStatusInProgress &&
				len(existing.ResponseBody) == 0 && existing.ID > 0 {
				resp := runMainFlow(ctx, deps, &para, existing.ID)
				return persistAttemptResult(ctx, deps, &para, existing.ID, resp), nil
			}
			return handleLoser(deps, existing), nil
		}

		// flowId 是 modifyResource 出参的唯一 data 字段（异步语义，不能为 0），
		// 同时要透传给 ctl 做幂等键和终态回调地址。
		winnerFlow, getErr := deps.FlowStore.GetFlow(ctx, para.DealName, flowType, appIDStr)
		if getErr != nil || winnerFlow == nil {
			return deps.Builder.NewError(ReturnCodeUpstreamUnavailable,
				fmt.Sprintf("re-select winner trade_flow id failed: %v", getErr)), nil
		}

		resp := runMainFlow(ctx, deps, &para, winnerFlow.ID)
		return persistAttemptResult(ctx, deps, &para, winnerFlow.ID, resp), nil
	}
}

// persistAttemptResult records only the state justified by this synchronous
// callback. A successful response means "accepted", not "provisioned".
func persistAttemptResult(
	ctx context.Context,
	deps Deps,
	para *callbackPara,
	flowID int64,
	resp jifei.Framework,
) jifei.Framework {
	respBytes, marshalErr := json.Marshal(resp)
	if marshalErr != nil {
		// Framework fields are simple JSON values. Keep the flow in progress so a
		// later callback can retry instead of manufacturing a terminal state.
		return deps.Builder.NewError(ReturnCodeUpstreamUnavailable,
			fmt.Sprintf("marshal modifyResource response: %v", marshalErr))
	}

	switch {
	case resp.ReturnCode == 0:
		recorder, ok := deps.FlowStore.(acceptedFlowRecorder)
		if !ok {
			return deps.Builder.NewError(ReturnCodeUpstreamUnavailable,
				"flow store cannot record asynchronous modify acceptance")
		}
		if err := recorder.RecordAcceptedByID(ctx, flowID, para.ResourceID, respBytes); err != nil {
			return deps.Builder.NewError(ReturnCodeUpstreamUnavailable,
				fmt.Sprintf("record accepted modify flow: %v", err))
		}
	case resp.ReturnCode == jifei.RefundReturnCode:
		_ = deps.FlowStore.MarkFailed(ctx, para.DealName, flowType,
			strconv.FormatInt(para.AppID, 10), respBytes)
	default:
		// B 类：保留 in_progress，让相同 flowID 的后续回调重试受理。
	}
	return resp
}

// runMainFlow 是赢家路径：从 jifei 入参解析出变配三元组（pass、源套餐、目标套餐）后
// 反向调 ctl.ModifyPass 受理发货。
//
// 套餐对由 SV 集合反查得到，失败一律 ReturnCodeInvalidPara（B 类可重试），不退款：
// 反查失败的现实原因是运营改了 SV 没同步计费接入单，或计费中间环节改了字段形状，
// 都属于"修好配置后这笔单还能正常发货"，此时退款会白白伤害已付款的用户。
func runMainFlow(ctx context.Context, deps Deps, para *callbackPara, flowID int64) jifei.Framework {
	curDeadline, msg := parseCurDeadline(para.GoodsDetail)
	if msg != "" {
		return deps.Builder.NewError(ReturnCodeInvalidPara, msg)
	}

	sourceBundleID, targetBundleID, code, detail := resolveBundlePair(ctx, deps, para)
	if code != 0 {
		return deps.Builder.NewError(code, detail)
	}

	ctlCtx, cancel := context.WithTimeout(ctx, CTLCallTimeout)
	defer cancel()

	resp, err := deps.CTLClient.ModifyPass(ctlCtx, para.ResourceID, &ctlclient.ModifyPassRequest{
		CheckPassModifyRequest: ctlclient.CheckPassModifyRequest{
			SourceBundleID: sourceBundleID,
			TargetBundleID: targetBundleID,
			Uin:            parseUinOrZero(para.Uin),
			AppID:          para.AppID,
			ProductCode:    para.ProductCode,
			SubProductCode: para.SubProductCode,
			CurDeadline:    curDeadline,
		},
		FlowID:   flowID,
		DealName: para.DealName,
		TranID:   para.TranID,
	})
	if err != nil {
		return classifyModifyPassError(deps.Builder, err)
	}
	if resp == nil || resp.PassID == "" {
		// ctl 返 200 但没回显 pass_id：协议层异常，B 类让 jifei 重试。
		return deps.Builder.NewError(ReturnCodeUpstreamUnavailable, "ctl ModifyPass returned empty passId")
	}

	return deps.Builder.NewSuccess(map[string]any{"flowId": flowID})
}

// resolveBundlePair 用 goodsDetail.oldConfig / newConfig 的 SV 集合反查源与目标套餐 ID。
//
// code != 0 表示失败，detail 可直接进计费 returnMessage。两个失败码都属 B 类（不退款）：
//   - ReturnCodeInvalidPara：协议字段缺失或 SV 反查不出唯一套餐（配置问题，修好可发货）
//   - ReturnCodeUpstreamUnavailable：读 trade_bundle_definition 时 DB 故障
//
// 分开两个码而不是都归 InvalidPara：排障时"配置对不上"和"DB 挂了"要走完全不同的处置，
// 混成一个码会让值班先怀疑运营配置，浪费在真正的基础设施故障上。
//
// 检索域必须由计费带全 productCode + subProductCode：缺任一就只能全表反查，会把跨 SP
// 的套餐纳入候选，违背本期"只做同 SP 变配"的边界。实测计费 modifyResource 回调这两个
// 字段都带（2026-09-02），要求必填不会误伤真实流量。
//
// 这里不重复 checkModify 的业务对账（源 ≠ 目标、同 SP、PID 一致）：那些在下单前的
// checkModify 已 fail-closed 过一轮，且 CTL 的 ModifyPass 会用 modify_policy 的升配
// 边白名单再校一次。本 handler 只负责把协议字段翻译成套餐 ID。
func resolveBundlePair(ctx context.Context, deps Deps, para *callbackPara) (string, string, int, string) {
	if deps.BundleStore == nil {
		return "", "", ReturnCodeInvalidPara,
			"bundle definition store is not configured; cannot resolve modify target"
	}
	if para.ProductCode == "" || para.SubProductCode == "" {
		return "", "", ReturnCodeInvalidPara, fmt.Sprintf(
			"productCode and subProductCode are required to resolve bundle definitions, got productCode=%q subProductCode=%q",
			para.ProductCode, para.SubProductCode)
	}

	oldConfig := jifeiproto.GoodsDetailSVMap(para.GoodsDetail, "oldConfig")
	newConfig := jifeiproto.GoodsDetailSVMap(para.GoodsDetail, "newConfig")

	res, err := bundleresolve.ModifyBundles(
		ctx, deps.BundleStore, para.ProductCode, para.SubProductCode, oldConfig, newConfig)
	if err != nil {
		return "", "", ReturnCodeUpstreamUnavailable,
			fmt.Sprintf("list bundle definitions failed: %v", err)
	}
	if !res.OK() {
		return "", "", ReturnCodeInvalidPara, res.Detail
	}
	return res.Source.BundleID, res.Target.BundleID, 0, ""
}

// classifyModifyPassError 按 Q56 把 ctl 错误分成 A 类退款和 B 类重试。
//
// 分类线就一条：4xx = CTL 认定这笔变配永久发不出去（状态、套餐关系、配置漂移、
// 实例未就绪），退款；5xx / 网络错 = 基础设施抖动，重试。
//
// 不按 ctl 的具体 Code 细分退款与否：CTL 的 modify 4xx 码全都是"永久不可发货"语义
// （PASS_MODIFYING 也是——同一笔 flow 重投在 CTL 侧走幂等成功分支，落到这个码只可能是
// 另一笔单占着 pass，这笔单确实发不出去）。细分只会在 trade 复制一份 CTL 的错误表，
// 然后随 CTL 改动漂移。
func classifyModifyPassError(builder *jifei.FrameworkBuilder, err error) jifei.Framework {
	if err == nil {
		return builder.NewError(ReturnCodeUpstreamUnavailable, "nil error treated as upstream failure")
	}
	if errors.Is(err, ctlclient.ErrNotFound) {
		return builder.NewRefund()
	}
	// 内部 token 不一致是配置错，rotate 后可恢复 → B 类，不能退款。
	if errors.Is(err, ctlclient.ErrUnauthorized) {
		return builder.NewError(ReturnCodeUpstreamUnavailable, fmt.Sprintf("ctl unauthorized: %v", err))
	}

	var ctlErr *ctlclient.Error
	if errors.As(err, &ctlErr) {
		switch {
		case ctlErr.HTTPStatus >= 400 && ctlErr.HTTPStatus < 500:
			return builder.NewRefund()
		case ctlErr.HTTPStatus >= 500:
			return builder.NewError(ReturnCodeUpstreamUnavailable,
				fmt.Sprintf("ctl 5xx: code=%s message=%s request_id=%s",
					ctlErr.Code, ctlErr.Message, ctlErr.RequestID))
		}
	}
	return builder.NewError(ReturnCodeUpstreamUnavailable, fmt.Sprintf("ctl ModifyPass: %v", err))
}

// handleLoser 实现抢占失败的三分支处理（与 renewresource 同型，各包自持避免跨包耦合）。
func handleLoser(deps Deps, existing *store.Flow) jifei.Framework {
	if existing == nil {
		return deps.Builder.NewError(ReturnCodeUpstreamUnavailable,
			"trade_flow exists but re-select returned nil")
	}
	switch existing.Status {
	case store.FlowStatusCompleted, store.FlowStatusFailed:
		return replayResponseBody(deps, existing.ResponseBody)
	case store.FlowStatusInProgress:
		// response_body 非空表示 CTL 已接受这笔异步变配；重复回调应回放首次
		// 成功响应，而不是让计费误以为受理失败。真正终态仍由 status 表达。
		if len(existing.ResponseBody) > 0 {
			return replayResponseBody(deps, existing.ResponseBody)
		}
		return deps.Builder.NewError(ReturnCodeFlowInProgress,
			fmt.Sprintf("trade_flow in progress for dealName=%s; retry later", existing.DealName))
	default:
		return deps.Builder.NewError(ReturnCodeUpstreamUnavailable,
			fmt.Sprintf("trade_flow unknown status=%q dealName=%s", existing.Status, existing.DealName))
	}
}

// replayResponseBody 回放持久化的 framework JSON。
//
// Q58 不变量：returnCode 必须 == returnValue；破坏时按 corrupted 兜底而不是原样回放，
// 否则会把一条坏记录当成成功响应喂给计费。
func replayResponseBody(deps Deps, body []byte) jifei.Framework {
	if len(body) == 0 {
		return deps.Builder.NewError(ReturnCodeFlowReplayCorrupted, "trade_flow.response_body is empty")
	}
	var fw jifei.Framework
	if err := json.Unmarshal(body, &fw); err != nil {
		return deps.Builder.NewError(ReturnCodeFlowReplayCorrupted,
			fmt.Sprintf("trade_flow.response_body unmarshal: %v", err))
	}
	if fw.ReturnCode != fw.ReturnValue {
		return deps.Builder.NewError(ReturnCodeFlowReplayCorrupted,
			fmt.Sprintf("trade_flow.response_body invariant broken: returnCode=%d returnValue=%d",
				fw.ReturnCode, fw.ReturnValue))
	}
	return fw
}

func validatePara(p *callbackPara) error {
	if uin, err := strconv.ParseInt(p.Uin, 10, 64); err != nil || uin <= 0 {
		return errors.New("uin must be a positive int64")
	}
	if p.DealName == "" {
		return errors.New("dealName is required")
	}
	if p.AppID == 0 {
		return errors.New("appId is required")
	}
	if p.ResourceID == "" {
		return errors.New("resourceId is required")
	}
	if p.GoodsDetail == nil {
		return errors.New("goodsDetail is required")
	}
	if _, msg := parseCurDeadline(p.GoodsDetail); msg != "" {
		return errors.New(msg)
	}
	// oldConfig / newConfig 是反查源 / 目标套餐的唯一依据（计费协议一等公民，必然回传）。
	// 空对象说明协议形状变了，此时无从判断"该发什么货"，必须立刻暴露而不是猜一个目标套餐。
	// 注意判空要用 SV 视图而不是 map 是否存在：内层还带 pid / productCode /
	// subProductCode，只看键是否存在会把"只剩元信息、没有任何 sv_*"这种坏形状放过去。
	if len(jifeiproto.GoodsDetailSVMap(p.GoodsDetail, "oldConfig")) == 0 {
		return errors.New("goodsDetail.oldConfig must carry at least one sv_* item")
	}
	if len(jifeiproto.GoodsDetailSVMap(p.GoodsDetail, "newConfig")) == 0 {
		return errors.New("goodsDetail.newConfig must carry at least one sv_* item")
	}
	return nil
}

// parseCurDeadline 解析 goodsDetail.curDeadline 为绝对时刻。
//
// 时区用 jifeiproto.CurDeadlineLocation（CST）：计费传北京时间字面值，
// 用 time.Local 在 UTC 的 pod 里会错 8 小时，把正常请求判成到期时间漂移（BUG-33 同因）。
// 预付费必带；缺失时拒绝，不能把 nil 传给 CTL 跳过到期时间校验。
func parseCurDeadline(goodsDetail map[string]interface{}) (*time.Time, string) {
	raw, ok := goodsDetailStringField(goodsDetail, "curDeadline")
	if !ok || raw == "" {
		return nil, "goodsDetail.curDeadline is required for prepaid modify"
	}
	parsed, err := time.ParseInLocation(jifeiproto.CurDeadlineLayout, raw, jifeiproto.CurDeadlineLocation)
	if err != nil {
		return nil, fmt.Sprintf("goodsDetail.curDeadline invalid format %q (expected %q): %v",
			raw, jifeiproto.CurDeadlineLayout, err)
	}
	return &parsed, ""
}

// parseUinOrZero 只转换 validatePara 已确认合法的正整数 UIN。
// 必须先验证，不能把错误返回值 0 传给 CTL 绕过归属校验。
func parseUinOrZero(uin string) int64 {
	v, err := strconv.ParseInt(uin, 10, 64)
	if err != nil {
		return 0
	}
	return v
}

// goodsDetailStringField 从 goodsDetail 取字符串字段（与 checkmodify 同型实现）。
func goodsDetailStringField(m map[string]interface{}, key string) (string, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return "", false
	}
	switch t := v.(type) {
	case string:
		return t, true
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10), true
		}
		return strconv.FormatFloat(t, 'f', -1, 64), true
	default:
		return fmt.Sprintf("%v", t), true
	}
}
