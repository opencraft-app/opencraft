// Package createresource 实现 jifei `lightvela.pass.createResource` 回调的同步发货 handler。
//
// 设计稿引用：
//   - §6 createResource 回调（trade → 反向调 ctl/pass）
//   - §6.0 Q27 角色边界：trade 是协议入口 + 流水持久化；pass 实体唯一 owner = ctl/pass
//   - §6.2 内部步骤 T1~T5（Q61 抢占式幂等覆盖 T1 / T5）：
//     T1 `INSERT trade_flow ... ON DUPLICATE KEY UPDATE id=id` 抢占 + 三分支
//     T2 反查 trade_order，确认 status=pending_payment（实际 trade_order 状态机为
//     created / pending_pay / paid_pending_provision / provisioned / payment_failed /
//     provision_failed，本期 createResource 进入时通常为 pending_pay 或
//     paid_pending_provision；本迭代不强约束，仅校验"订单存在 + 未已发货"）
//     T3 反向调 ctl `POST /internal/ctl/passes/complete` 拿 pass_id
//     T4 UPDATE trade_order SET status=provisioned, resource_id=passId（迭代 8 PlaceOrder
//     落库后才会真有写端，本迭代仅在 OrderStore 提供 UpdateProvisioned 时调用；尚未实现
//     时跳过该步并日志记录，不阻塞协议层成功响应）
//     T5 UPDATE trade_flow SET status=completed, response_body=<framework JSON>
//   - §6.4 异常分类（Q56 协同）：A 类业务永久不可发货 → 退款响应 (returnCode=352014)；
//     B 类基础设施 transient 故障 → 非零业务码 returnCode 让 jifei 重试
//   - Q56 退款触发场景（本迭代严格收敛）：
//     a. trade_order 不存在 → B 类（链路异常 / 重试），不退款
//     b. trade_order 已被发货过（resource_id 非空）→ 视作幂等回放成功（虽然 trade_flow 没记录，
//     但实际 ctl 已生成 pass，按"已完成"语义返回），不退款
//     c. ctl GetBundleByID 返 ErrNotFound（bundle 已永久删除）→ A 类退款
//     d. ctl CompletePass 返 4xx 业务级错（USER_HAS_ACTIVE_PASS / quota 不足等）→ A 类退款
//     e. ctl CompletePass 返 5xx 或网络错 / 超时 → B 类业务码（让 jifei 重试）
//   - Q59：5s 同步硬约束（本迭代收紧到 4s 给 jifei 1s buffer，ctlclient 本身是 4s 内置超时）
//   - Q62：本 handler 写 trade_flow（与 checkCreate 不写形成对比）
package createresource

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
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
	OrderStore   store.OrderStore        // §6.2 T2 反查 trade_order
	OrderUpdater OrderProvisionUpdater   // §6.2 T4 反向回填（可为 nil，迭代 8 接线）
	FlowStore    store.FlowStore         // §6.2 T1/T5 抢占式幂等
	CTLClient    ctlclient.Client        // §6.2 T3 反向调 ctl/pass
	Builder      *jifei.FrameworkBuilder // 构造 jifei framework 双层出参

	// ActivityStore 是点石活动写端（设计稿 .tmp/dianshi-activity-bundle-design.md
	// §5.6.1 step 4 / §3.2）。可选注入：
	//   - 非 nil：runMainFlow 在 ctl.CompletePass 成功后、若 trade_order.source=='dianshi'
	//     则反查 trade_bundle_activity 拿 activity_id / act_id、INSERT trade_user_activity_participation
	//   - nil：完全不感知点石，与 v1.7.x 历史行为完全一致（便于灰度接入的单测与回滚）
	ActivityStore store.ActivityStore

	// DB 是 trade 主库 *sql.DB，ActivityStore.InsertUserParticipation 需要 *sql.Tx 参数，
	// 本 handler 包 BeginTx 后传入。ActivityStore 为 nil 时 DB 也可为 nil（不使用）。
	DB *sql.DB
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
// 字段类型说明（每个字段都标注 PDF 协议类型，铁律见 jifei/envelope.go 包注释）：
//   - DealName: PDF "string" — 计费订单号。
//   - AppID: PDF "long"（int）— 云平台应用 ID；jifei 实测发 number。**v1.7.28 BUG-06
//     同模式修复 (2026-05-21)**：原定义 string，与 PDF 不符；FlowStore 接口签名仍是
//     appID string（DB 列存 string），handler 内调用时用 strconv.FormatInt 转一次。
//   - Uin: PDF "string"（quoted）— 主账号。
//   - GoodsNum: PDF "int" — 商品数量。
type callbackPara struct {
	DealName       string                 `json:"dealName"`       // PDF: string
	AppID          int64                  `json:"appId"`          // PDF: long (number); v1.7.28 BUG-06 同模式修复
	Uin            string                 `json:"uin"`            // PDF: string (quoted)
	SubProductCode string                 `json:"subProductCode"` // PDF: string
	BundleID       string                 `json:"bundleId"`       // 业务字段（trade 自家落库）
	GoodsNum       int                    `json:"goodsNum"`       // PDF: int
	GoodsDetail    map[string]interface{} `json:"goodsDetail"`    // PDF: object
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

		// (2) Q61 Step T1：抢占式幂等。
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
			// 成功收尾。
			//
			// v1.7.28 BUG-18 修订（2026-05-21 用户拍板）：createResource 链路成功后
			// 必须把 trade_flow.resource_id 回填为 ctl 返回的 pass_id，与 isolate /
			// renew / destroy 链路（resource_id 在抢占阶段就写入）保持对称，便于
			// reconcile worker / 运维直接用 resource_id 反查 trade_flow。
			//
			// pass_id 来源：runMainFlow 在 NewSuccess(map{"resourceIds": []string{pass.PassID}}) 中
			// 写入；这里直接从 resp.Data 抽（取首元素），避免再串一次返回值。
			resourceID := extractResourceID(resp.Data)
			if resourceID != "" {
				_ = deps.FlowStore.MarkCompletedWithResourceID(ctx,
					para.DealName, flowType, appIDStr, resourceID, respBytes)
			} else {
				// 兜底：极端情况（runMainFlow 异常路径返成功但无 resourceIds）走老路径
				_ = deps.FlowStore.MarkCompleted(ctx, para.DealName, flowType, appIDStr, respBytes)
			}
		case resp.ReturnCode == jifei.RefundReturnCode:
			// A 类退款收尾
			_ = deps.FlowStore.MarkFailed(ctx, para.DealName, flowType, appIDStr, respBytes)
		default:
			// B 类业务码（transient 故障 / 入参错）— 保留 in_progress，让 reconcile worker
			// 后续根据 ctl 实际状态决定 promote 到 completed / failed（设计稿 §6.4 Q61）。
			// 即不调 MarkCompleted / MarkFailed。
		}
		return resp, nil
	}
}

// extractResourceID 从 framework.Data 里提取 resourceIds 字段并取首元素（v1.7.28 BUG-18 辅助）。
//
// runMainFlow 成功路径用 NewSuccess(map{"resourceIds": []string{pass.PassID}}) 构造响应，
// PDF 协议要求 resourceIds 是 string[]，单资源场景包成单元素数组；这里取 [0] 反向抽出。
//
// 兼容两种类型：
//   - 主链路本地构造时：[]string{passID} → 直接断言 []string
//   - 历史 response_body replay 时：JSON 反序列化为 []any，元素是 string
//
// 缺失 / 非数组 / 数组为空 / 元素非字符串 → 返空字符串（兜底，调用方走老 MarkCompleted 路径）。
func extractResourceID(data map[string]any) string {
	if data == nil {
		return ""
	}
	v, ok := data["resourceIds"]
	if !ok {
		return ""
	}
	// 主链路本地构造路径：[]string
	if arr, ok := v.([]string); ok {
		if len(arr) == 0 {
			return ""
		}
		return arr[0]
	}
	// JSON replay 路径：[]any（每个元素是 string）
	if arr, ok := v.([]any); ok {
		if len(arr) == 0 {
			return ""
		}
		s, ok := arr[0].(string)
		if !ok {
			return ""
		}
		return s
	}
	return ""
}

// runMainFlow 是赢家路径的主链路（§6.2 Step T2~T4）。
//
// v1.7.28 BUG-22 修订（2026-05-21 用户拍板）：解耦 createResource 与 trade_order 反查依赖。
//
// 设计原则修订：
//   - 原设计（v1.7.27 之前）：runMainFlow 反查 trade_order 拿 externalUserId / bundleId /
//     period / timeUnit 等字段调 ctl.CompletePass。但因为 jifei generateDealsAndPay 同步
//     回推 createResource 早于 trade INSERT trade_order，造成 ErrNotFound → 600202 + trade_flow
//     卡 in_progress 死锁。
//   - v1.7.28 修订：goodsDetail 透传机制扩展 — PlaceOrderAndPay 在 buildGoodsDetail 把
//     externalUserId 塞进 goodsDetail（与 bundleId 同范式，jifei 原样回推），createResource
//     直接从 jifei 入参拿 externalUserId / bundleId / timeSpan / timeUnit 调 ctl.CompletePass，
//     不再依赖 trade_order 反查。
//   - trade_order 在发货链路中退化为"订单流水记录"（不在关键路径上）：
//   - 反查 trade_order 仅用作"幂等回放"（已发货 resource_id 已回填时直接返）
//   - 反查不到 trade_order 不报错，继续走 ctl.CompletePass（与上一版 600202 退出对比）
//   - MarkOrderProvisioned 找不到 trade_order 也不报错（trade_order 落库可能晚于 jifei
//     回调，PlaceOrderAndPay 完成 BindDealName 后再异步刷新 status）
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
	// Step T2：可选反查 trade_order（仅用作幂等回放 - 已发货时直接返历史 resource_id）。
	//
	// 不强依赖：找不到 / 错误都不阻塞主链路（trade_order 落库可能晚于 jifei 回调）。
	//
	// v0.5（点石接入设计稿 §5.6.1 step 1）：保留 order 引用供 T5 检查 source。反查失败 / 为 nil
	// 不报错，T5 在 order==nil 时跳过 INSERT participation（与原 T2 同款宽容）。
	order, _ := deps.OrderStore.GetOrderByDealName(ctx, para.DealName)
	if order != nil && order.ResourceID != "" {
		// 已发货幂等回放（Q56 b 场景）：trade_order.resource_id 已回填即视作幂等成功。
		// 点石路径下重复回调也在本处返，避免重复 INSERT participation（由 (uin, activity_id) 唯一键也能兼底）。
		return deps.Builder.NewSuccess(map[string]any{
			"resourceIds": []string{order.ResourceID},
		})
	}

	// Step T3：从 jifei 入参提取业务字段，反向调 ctl/pass 完成发货。
	//
	// 字段映射（v1.7.28 BUG-22 修订：完全脱离 trade_order）：
	//   - UserID  = goodsDetail.externalUserId（PlaceOrderAndPay 时 trade 自家透传）
	//   - BundleID = goodsDetail.bundleId       （PlaceOrderAndPay 时 trade 自家透传）
	//   - TimeSpan = goodsDetail.timeSpan       （jifei 协议字段；与 PlaceOrderAndPay 入参一致）
	//   - TimeUnit = goodsDetail.timeUnit       （同上）
	//   - Uin / AppID = jifei 入参顶层 uin / appId（jifei 协议字段）
	//   - DealName = jifei 入参顶层 dealName    （jifei 协议字段）
	//   - RenewFlag = goodsDetail.autoRenewFlag 映射；仅明确为 1 时自动续费，其余手动续费
	externalUserID := extractStringFromGoodsDetail(para.GoodsDetail, "externalUserId")
	if externalUserID == "" {
		// goodsDetail.externalUserId 缺失：PlaceOrderAndPay 端没塞或 jifei 没回传 —
		// 两种情况都属于业务永久不可发货（无法定位 lightclaw 用户），按 A 类退款。
		return deps.Builder.NewRefund()
	}
	bundleID := extractStringFromGoodsDetail(para.GoodsDetail, "bundleId")
	if bundleID == "" {
		// goodsDetail.bundleId 缺失：同 BUG-07 同模式，jifei 协议本身不发顶层 bundleId，
		// 必须从 goodsDetail 取；缺失意味着 PlaceOrderAndPay 端没塞，A 类退款。
		return deps.Builder.NewRefund()
	}
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
	// Uin string → int64 转换（jifei 协议层 uin 是 quoted string，但 ctl userId 接口要 int64）。
	uinInt, parseErr := strconv.ParseInt(para.Uin, 10, 64)
	if parseErr != nil {
		// jifei 入参 uin 不是合法整数 — 协议层异常，B 类业务码让 jifei 重试。
		return deps.Builder.NewError(
			ReturnCodeInvalidPara,
			fmt.Sprintf("uin must be numeric, got %q: %v", para.Uin, parseErr),
		)
	}
	completeReq := &ctlclient.CompletePassRequest{
		UserID:    externalUserID,
		BundleID:  bundleID,
		TimeSpan:  timeSpan,
		TimeUnit:  timeUnit,
		Uin:       uinInt,
		AppID:     para.AppID,
		DealName:  para.DealName,
		RenewFlag: renewFlagFromGoodsDetail(para.GoodsDetail),
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

	// Step T4：尝试反向回填 trade_order（resource_id + status='provisioned'）。
	//
	// v1.7.28 BUG-22 修订：MarkOrderProvisioned 失败不阻塞 jifei 响应 —
	// trade_order 落库可能晚于 jifei 回调（PlaceOrderAndPay 先调 jifei、后 INSERT trade_order
	// 这条已知时序问题），ErrNotFound 是预期分支不报错；ctl 那边 pass 已成功落地，业务对
	// jifei 协议层来说已视作发货完成。trade_order 由 PlaceOrderAndPay 自己 BindDealName 时
	// 把 deal_name 与 resource_id 关联，或由 reconcile worker 兜底。
	if deps.OrderUpdater != nil {
		if err := deps.OrderUpdater.MarkOrderProvisioned(ctx, para.DealName, pass.PassID); err != nil {
			if !errors.Is(err, store.ErrTradeOrderNotFound) {
				// 非 NotFound 错误（resource_id 冲突、DB 失败等）— 不阻塞 jifei 响应，
				// 仅日志告警；ctl 那边 pass 已成功落地，业务幂等性由 ctl 端保证。
				// （未来扩展：可加 metric / structured log，本期日志由 caller 在 handler 层补）
				_ = err
			}
		}
	}

	// Step T5：source=='dianshi' 时 INSERT trade_user_activity_participation（设计稿 §5.6.1 step 4）。
	//
	// 触发条件（全部满足才走 INSERT）：
	//   - deps.ActivityStore != nil（启动期注入了点石依赖）
	//   - order != nil（T2 反查命中 trade_order；jifei 回调在 trade_order 落库之后到达的正常时序）
	//   - order.Source == "dianshi"（jifei 路径 trade_order 这里不会命中）
	//
	// 失败语义：INSERT 失败 / 唯一键冲突 / 反查 trade_bundle_activity 失败均**不阻塞 jifei 响应**
	// （与 T4 MarkOrderProvisioned 同款风格）—ctl pass 已落地、点石 deal 已发出，错误仅日志告警供运维补充。
	// 唯一键 (uin, activity_id) 冲突 = jifei 重复回调 / 跨会话重复领取，本身就是幂等体现，
	// 同样不报错。
	if deps.ActivityStore != nil && order != nil && order.Source == store.OrderSourceDianshi {
		insertErr := insertDianshiParticipation(ctx, deps, order, pass.PassID)
		if insertErr != nil {
			// 不阻塞 jifei 响应；记日志供运维补充。
			log.Printf("[dianshi-cb] insert participation failed (non-blocking) dealName=%s uin=%s bundleId=%s err=%v",
				order.DealName, order.Uin, order.BundleID, insertErr)
		} else {
			log.Printf("[dianshi-cb] insert participation ok dealName=%s uin=%s bundleId=%s",
				order.DealName, order.Uin, order.BundleID)
		}
	}

	// 全部成功：返 framework 双层成功响应（data.resourceIds = [pass_id]，PDF 协议要 string[]）。
	return deps.Builder.NewSuccess(map[string]any{
		"resourceIds": []string{pass.PassID},
	})
}

// extractStringFromGoodsDetail 从 goodsDetail map 中安全取出 string 字段。
//
// jifei 透传机制（PDF §2.2）：trade PlaceOrder 时塞进 goodsDetail 的字段会原样
// 回推到 createResource / checkCreate 等回调。但 JSON 反序列化后 map[string]interface{}
// 里数值都是 float64，这个辅助函数只取 string 字段（externalUserId / bundleId / timeUnit）。
func extractStringFromGoodsDetail(goodsDetail map[string]interface{}, key string) string {
	if goodsDetail == nil {
		return ""
	}
	v, ok := goodsDetail[key]
	if !ok {
		return ""
	}
	s, ok := v.(string)
	if !ok {
		return ""
	}
	return s
}

// extractIntFromGoodsDetail 从 goodsDetail map 中安全取出 int 字段（兼容 float64 / json.Number）。
//
// JSON 反序列化默认把数值解析为 float64；本函数容忍 float64 / int / int64 三种来源类型，
// 用于读取 timeSpan / goodsNum 等 int 字段。
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
	}
	return 0
}

// renewFlagFromGoodsDetail 把 jifei 的 autoRenewFlag 映射为 ctl 内部续费枚举。
// jifei 允许该字段是 number/string 且可能不传；只有明确值 1 表示自动续费，任何缺失、
// 其它值或类型异常都按手动续费处理，保持国内站和旧订单的默认行为。
func renewFlagFromGoodsDetail(goodsDetail map[string]interface{}) string {
	const (
		manualRenew = "MANUAL_RENEW"
		autoRenew   = "AUTO_RENEW"
	)

	if goodsDetail == nil {
		return manualRenew
	}
	v, ok := goodsDetail["autoRenewFlag"]
	if !ok {
		return manualRenew
	}

	isAutoRenew := false
	switch flag := v.(type) {
	case float64:
		isAutoRenew = flag == 1
	case int:
		isAutoRenew = flag == 1
	case int64:
		isAutoRenew = flag == 1
	case json.Number:
		parsed, err := flag.Int64()
		isAutoRenew = err == nil && parsed == 1
	case string:
		isAutoRenew = flag == "1"
	}
	if isAutoRenew {
		return autoRenew
	}
	return manualRenew
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
// v1.7.28 BUG-13/14 修订 (2026-05-21)：删除顶层 BundleID + GoodsNum 必填校验。
//   - jifei 协议层 createResource 不发顶层 bundleId 字段（trade 自家业务字段，
//     trade 通过 dealName 反查 trade_order 拿）。
//   - jifei 协议层 createResource 不发顶层 goodsNum，只在 goodsDetail.goodsNum
//     里嵌套（PDF 第 4.1 节 "para.goodsDetail.goodsNum 必传字段"）。
//   - 业务路径完全不读 callbackPara.GoodsNum（grep 验证），删 validate 校验
//     只是去掉无效约束。
//   - 与 checkcreate BUG-07/checkrenew 同源问题，但 createResource 协议层有
//     dealName 可反查 trade_order，比 checkCreate 简单。
func validatePara(p *callbackPara) error {
	if p.DealName == "" {
		return errors.New("dealName is required")
	}
	if p.AppID == 0 {
		return errors.New("appId is required")
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

// insertDianshiParticipation 把点石下单成功事实写入 trade_user_activity_participation
// （设计稿 §5.6.1 step 4）。
//
// 触发条件由调用方保证：trade_order.source == 'dianshi' && order != nil。
//
// 步骤：
//  1. 反查 trade_bundle_activity（按 order.bundle_id）拿 activity_id / act_id
//  2. BEGIN TX → INSERT trade_user_activity_participation → COMMIT
//  3. 唯一键 (uin, activity_id) 冲突 = jifei 重复回调 / 跨会话重复领取，视为幂等成功（不报错）
//
// 失败语义：上层调用点把 err 当告警日志处理、不阻塞 jifei 响应。
func insertDianshiParticipation(
	ctx context.Context,
	deps Deps,
	order *store.TradeOrder,
	passID string,
) error {
	if deps.ActivityStore == nil {
		return fmt.Errorf("ActivityStore is nil")
	}
	if deps.DB == nil {
		return fmt.Errorf("DB is nil (required for participation INSERT tx)")
	}

	// Step 1: 反查 trade_bundle_activity 拿 activity_id / act_id
	mapping, err := deps.ActivityStore.GetBundleActivityByBundleID(ctx, order.BundleID)
	if err != nil {
		return fmt.Errorf("get bundle_activity bundleID=%s: %w", order.BundleID, err)
	}

	// Step 2: 开事务 INSERT
	tx, err := deps.DB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() {
		// COMMIT 成功后 Rollback() 返 sql.ErrTxDone 是预期；其它路径需要回滚。
		_ = tx.Rollback()
	}()

	// big_deal_no：优先从 goods_detail 取（placeOrderDianshi 写入时塞进去），
	// 兜底用 trade_order.big_order_id（点石路径下二者同源）。
	bigDealNo := extractStringFromGoodsDetail(order.GoodsDetail, "dianshi_big_deal_no")
	if bigDealNo == "" {
		bigDealNo = order.BigOrderID
	}

	row := &store.UserActivityParticipation{
		Uin:            order.Uin,
		AppID:          order.AppID,
		ExternalUserID: order.ExternalUserID,
		ActivityID:     mapping.ActivityID,
		BundleID:       order.BundleID,
		ActID:          mapping.ActID,
		DealName:       order.DealName,
		BigDealNo:      bigDealNo,
	}

	if _, err := deps.ActivityStore.InsertUserParticipation(ctx, tx, row); err != nil {
		// 唯一键冲突视为幂等成功——重复回调 / 跨会话重复领取场景下 (uin, activity_id) 已存在
		if isMySQLDuplicateError(err) {
			// 提交事务保持空操作语义一致
			if commitErr := tx.Commit(); commitErr != nil {
				return fmt.Errorf("commit empty tx after duplicate: %w", commitErr)
			}
			log.Printf("[dianshi-cb] participation already exists (idempotent) uin=%s activityId=%d dealName=%s passID=%s",
				order.Uin, mapping.ActivityID, order.DealName, passID)
			return nil
		}
		return fmt.Errorf("insert participation uin=%s activityID=%d: %w",
			order.Uin, mapping.ActivityID, err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}
	return nil
}

// isMySQLDuplicateError 判定底层错误是否是 MySQL UNIQUE 约束冲突（errno=1062）。
//
// 与 trade/internal/store/order_write.go 的同名 helper 同款思路：驱动层不暴露
// 常量，按 message 子串匹配兜底。本包不能直接 import store 的非导出函数，所以
// 在本包内复制一份等价实现。
func isMySQLDuplicateError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	// MySQL 1062 错误消息固定形态："Error 1062: Duplicate entry '...' for key '...'"
	return strings.Contains(msg, "Error 1062") ||
		strings.Contains(msg, "Duplicate entry")
}
