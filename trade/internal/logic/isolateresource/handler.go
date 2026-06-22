package isolateresource

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"time"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	jifeiproto "git.woa.com/wisp/mono/trade/internal/jifei"
	"git.woa.com/wisp/mono/trade/internal/region"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// 业务层 returnCode（设计稿 §5 + §11 Q5=c / Q20=a，4 个错误码段）。
//
// 与 createresource (60020x) / resourcequery (60010x / 60030x 已被 isolate 重新定义) 错开。
const (
	// ReturnCodeInvalidPara = isolate 入参错（uin/appId/resourceId 缺失，region != 1，JSON 解析失败等）。
	// region 不匹配复用此码，不为 region 单独留码（§5 注释）。
	ReturnCodeInvalidPara = 600301

	// ReturnCodeFlowInProgress = ctl 调用失败 / DB 异常（B 类基础设施错）。
	// §11 Q5=c & Q7=a + Q21=a1：让 jifei 重试 isolateResource，同时 trade 侧 DELETE trade_flow 行回滚释放 slot。
	ReturnCodeFlowInProgress = 600302

	// ReturnCodeIsolateFailed = ctl 业务错（pass 不存在 / status 不可隔离 / 串货等永久失败）。
	// 注：本期 jifei 永不放弃 isolateResource 重试（PDF §1.2），返 60030x 系列只是让 jifei 走重试节奏；
	// 永久失败语义最终由后续 queryFlow status=3 透出（§11 Q5=c），本 handler 不直接返退款 352014。
	ReturnCodeIsolateFailed = 600303

	// ReturnCodeInternalError = 通用内部错（trade_flow 输家命中 corrupted state 等）。
	// queryFlow handler 也复用此码（§5 注释）。
	ReturnCodeInternalError = 600304

	// ReturnCodeNewDeadlineInvalid = 退费隔离专用业务错（v1.7.30 BUG-35 新增）。
	//
	// 触发场景：
	//   - dealName / newDeadline half-set（只传其一）
	//   - newDeadline 格式不符 PDF §2.2 layout "YYYY-MM-DD HH:MM:SS"
	//   - newDeadline 解析后为零值
	//   - ctl 侧检查 pass.expired_time > newDeadline 不成立（退费不可拉长到期时间）
	// jifei 拿到 600305 后会重试（与 600301/600303 同路）；当业务侧 jifei 修正 newDeadline 后重试会自然走通。
	ReturnCodeNewDeadlineInvalid = 600305
)

// HandlerTimeout 是 isolateResource handler 的总超时（§3.3 表 + §2.4 PDF 协议层 3s 同步约束）。
//
// 内部三层预算：
//   - PDF 同步调用超时 3s（jifei 那一端的硬约束）
//   - trade handler 总预算 4s（与 createResource 一致；给 jifei 1s 收尾 buffer）
//   - trade → ctl 反向调用 1.5s（CTLCallTimeout）
const HandlerTimeout = 4 * time.Second

// CTLCallTimeout 是反向调 ctl IsolatePass 的子上下文超时。
const CTLCallTimeout = 1500 * time.Millisecond

// flowType 固定为 isolate 路径的 §3.2 / FlowTypeIsolateResource。
const flowType = store.FlowTypeIsolateResource

// callbackPara 是 jifei `lightvela.pass.isolateResource` 回调的 interface.para 业务字段集（§2.1 + PDF isolateResource §2.2）。
//
// 字段保真度：
//   - 必填：Uin / AppID / Region / ResourceID
//   - 可选（仅日志透传，不消费）：OperateUin / ProductCode / SubProductCode / BillingIsolateType
//   - **v1.7.30 退费隔离新增业务消费字段**：DealName / NewDeadline
//     · 同时为空       → 生命周期隔离（原身业务语义不变）
//     · 同时非空     → 退费隔离（需存 dealName 到 trade_flow + 透传 newDeadline 给 ctl 后期写入 pass.expired_time）
//     · half-set     → 600305 拒绝（PDF 协议详详实不该出现，防御报错）
//
// 协议要求但本期不消费：RenewFlag（PDF 明示废弃） / BillingExtParam / Source / Type。
//
// jifei 入参 appId / region 都是 int 类型；其它都是 string。
type callbackPara struct {
	// 必填字段（每个字段都标注 PDF 协议类型，铁律见 jifei/envelope.go 包注释）
	Uin        string `json:"uin"`        // PDF: string (quoted)
	OperateUin string `json:"operateUin"` // PDF: string (quoted)
	AppID      int64  `json:"appId"`      // PDF: int (number)
	Region     int    `json:"region"`     // PDF: int
	ResourceID string `json:"resourceId"` // PDF: string

	// 仅日志透传
	ProductCode    string `json:"productCode"`    // PDF: string (optional)
	SubProductCode string `json:"subProductCode"` // PDF: string (optional)

	// 退费隔离业务字段（v1.7.30 BUG-35）— 同时出现/同时缺失
	DealName    string `json:"dealName"`    // PDF: string (optional, 退费场景传)
	NewDeadline string `json:"newDeadline"` // PDF: string (optional, 退费场景传，"YYYY-MM-DD HH:MM:SS" 北京时间字面值)

	// 仅日志透传（退费场景下 jifei 可能带 "refund"，不参与分支判定；DealName/NewDeadline 才是唯一可靠判据）
	BillingIsolateType string `json:"billingIsolateType"`

	// PDF 已废弃 / 本期不消费：RenewFlag / BillingExtParam / Source / Type 不解析
}

// makeHandler 构造闭包 handler；导出便于单元测试直接构造而无需走 dispatcher。
func makeHandler(deps Deps) jifei.Handler {
	// v1.7.x 国际站接入 A6.2 + 2026-06-12 北京 2 预发布接入：构造期从 deps.SiteKind +
	// deps.RegionOverride 解析出本站点期望的 region 三元组，
	// 后续所有入参都要与本期望值完全匹配（与 destroyresource handler 同模式）。
	expectedRegion := region.Resolve(deps.SiteKind, deps.RegionOverride)
	return func(ctx context.Context, paraRaw json.RawMessage) (jifei.Framework, error) {
		// (0) 总超时兑底（§3.3 + PDF §1.2）。
		ctx, cancel := context.WithTimeout(ctx, HandlerTimeout)
		defer cancel()

		// (1) 解码 + 校验入参
		var para callbackPara
		if err := json.Unmarshal(paraRaw, &para); err != nil {
			return deps.Builder.NewError(ReturnCodeInvalidPara, fmt.Sprintf("invalid para json: %v", err)), nil
		}
		if err := validatePara(&para, expectedRegion); err != nil {
			return deps.Builder.NewError(ReturnCodeInvalidPara, err.Error()), nil
		}
		// (1a) 退费隔离分支识别 + half-set 校验 + CST 字面值解析（v1.7.30 BUG-35）
		//
		// PDF isolateResource §2.2 业务契约：
		//   - dealName 与 newDeadline 是一对 "退费隔离语义对"，必须同时出现或同时缺失。
		//   - half-set（只传一个）= 协议层异常 → 600305，让 jifei 重试（业务侧会修正）。
		//   - newDeadline 是北京时间字面值（与 curDeadline 同源），必须用 jifeiproto.CurDeadlineLocation 解析。
		hasDealName := para.DealName != ""
		hasNewDeadline := para.NewDeadline != ""
		if hasDealName != hasNewDeadline {
			return deps.Builder.NewError(
				ReturnCodeNewDeadlineInvalid,
				fmt.Sprintf("refund isolate must carry both dealName and newDeadline (or neither); got dealName=%q newDeadline=%q",
					para.DealName, para.NewDeadline),
			), nil
		}
		var (
			dealNamePtr    *string    // 退费场景非 nil，生命周期场景 nil
			newDeadlinePtr *time.Time // 同上
		)
		if hasDealName {
			nd, parseErr := jifeiproto.ParseCurDeadline(para.NewDeadline)
			if parseErr != nil {
				return deps.Builder.NewError(
					ReturnCodeNewDeadlineInvalid,
					fmt.Sprintf("newDeadline invalid format %q (expected %q): %v",
						para.NewDeadline, jifeiproto.CurDeadlineLayout, parseErr),
				), nil
			}
			if nd.IsZero() {
				return deps.Builder.NewError(
					ReturnCodeNewDeadlineInvalid,
					fmt.Sprintf("newDeadline parsed to zero time (input=%q)", para.NewDeadline),
				), nil
			}
			dealName := para.DealName
			dealNamePtr = &dealName
			newDeadlinePtr = &nd
		}

		// (1b) 前置幂等查 ctl pass 状态（v1.7.31 新增；trade-pass-isolate §3.3 补丁）。
		//
		// 背景：jifei 永不放弃 isolateResource 重试（PDF §1.2），现网观察到对**已隔离**或
		// **已销毁**的 pass 反复触发隔离回调（典型场景：账号到期重启、退费后再到期）。
		// trade 原 §3.3 抢占式幂等仅识别"同一 isolate flow 仍在 in_progress"，对**已终态**
		// 的隔离请求会再次抢锁 + 反向调 ctl IsolatePass — ctl 在 pass 已 isolated 或不存在
		// 时会返 PASS_ISOLATED / 404，被 classifyCTLError 映射为 600302/600303，jifei 据此
		// 持续重试，业务感知为"隔离一直失败"。
		//
		// 修复路径（与生命周期 / 退费两条业务分支一视同仁）：
		//   - 调 ctl ListPassesByResourceIDs(appID, [resourceID]) 单元素反查（复用既有路径，
		//     ctl 侧 SQL 不过滤 status，能拿到 isolated 态记录的 IsolatedTime）
		//   - 命中"已隔离"（IsolatedTime != nil）或"已销毁/不存在"（返空数组）→ 直接幂等
		//     返成功，**不带 flowId**（PDF isolateResource §2.2 data.flowId optional，
		//     业务侧无 flow 反查需求），不抢 trade_flow slot、不调 ctl IsolatePass
		//   - 查询失败（网络 / 超时 / 5xx 等）→ 不阻塞，best-effort 降级到原 §3.3 抢占式
		//     幂等路径；新增的 ctl 查询故障不应让既有可用路径失活
		//   - 此处不区分生命周期 / 退费分支：pass 已隔离意味着 expired_time 已到期，重写
		//     newDeadline 无业务意义（与 §3.3 输家分支语义对齐）
		appIDStr := fmt.Sprintf("%d", para.AppID)
		idemCtx, idemCancel := context.WithTimeout(ctx, CTLCallTimeout)
		passes, queryErr := deps.CTLClient.ListPassesByResourceIDs(idemCtx, para.AppID, []string{para.ResourceID})
		idemCancel()
		if queryErr == nil {
			switch {
			case len(passes) == 0:
				// pass 不存在（已物理销毁 → INSERT history_pass + DELETE pass，或从未存在）
				// 隔离语义已自然达成，幂等返成功不带 flowId
				log.Printf("[isolateresource] idempotent-shortcut: pass not found (assumed destroyed); resourceID=%s appID=%d uin=%s hasDealName=%v",
					para.ResourceID, para.AppID, para.Uin, hasDealName)
				return deps.Builder.NewSuccess(map[string]any{}), nil
			case passes[0].IsolatedTime != nil:
				// pass 已处于 isolated 终态，隔离语义已达成，幂等返成功不带 flowId
				log.Printf("[isolateresource] idempotent-shortcut: pass already isolated; resourceID=%s appID=%d uin=%s isolatedTime=%s hasDealName=%v",
					para.ResourceID, para.AppID, para.Uin, passes[0].IsolatedTime.Format(time.RFC3339), hasDealName)
				return deps.Builder.NewSuccess(map[string]any{}), nil
			}
			// pass 存在且 IsolatedTime == nil（active / isolating / renewing 等非终态）— 继续走原 §3.3 路径
		} else {
			// best-effort：ctl 查询故障不阻塞原路径，仅记日志降级
			log.Printf("[isolateresource] idempotent-shortcut: ctl query failed (degrade to acquire-slot): resourceID=%s appID=%d err=%v",
				para.ResourceID, para.AppID, queryErr)
		}

		// (2) §3.3 抢占式幂等 — TryAcquireSlotForIsolate
		// 入参 appID 转 string（trade_flow.app_id 列是 VARCHAR(32)，与 createresource 保持一致）。
		// dealNamePtr：退费场景会落入 trade_flow.deal_name作为审计 / 反查兑底键；生命周期场景走 NULL。
		acquired, existing, err := deps.FlowStore.TryAcquireSlotForIsolate(
			ctx, para.ResourceID, flowType, appIDStr, para.Uin, paraRaw, dealNamePtr,
		)
		if err != nil {
			return deps.Builder.NewError(
				ReturnCodeFlowInProgress,
				fmt.Sprintf("acquire isolate slot: %v", err),
			), nil
		}

		// (3) 输家分支：已存在 in_progress 行 → 回放同一 PK id 作 flowId。
		// 设计稿 §3.3：保证 jifei 多次重试拿到同一 flowId，便于其后续 queryFlow 反查。
		//
		// 表示业务学中的补充 warning（v1.7.30）：如果输家路径上已有生命周期隔离行但本次是退费请求（反之亦然），
		// 该场景应由 jifei 侧顺序保证不应出现；但为了不阐述 / 不阳错业务语义随意覆盖已有行的 deal_name，
		// 这里仅记 warn 日志不阻塞返回原 flowId（让 ctl 走完原有 task 后走到终态）。
		if !acquired {
			if existing == nil {
				// 防御：理论不可能（TryAcquireSlotForIsolate 实现保证 acquired==false 时回查整行）
				return deps.Builder.NewError(
					ReturnCodeInternalError,
					"isolate flow exists but re-select returned nil",
				), nil
			}
			if hasDealName && existing.DealName == "" {
				log.Printf("[isolateresource] WARN winner-replay mismatch: refund request comes after lifecycle isolate already in_progress; flowID=%d resourceID=%s incomingDealName=%s",
					existing.ID, para.ResourceID, para.DealName)
			}
			if !hasDealName && existing.DealName != "" {
				log.Printf("[isolateresource] WARN winner-replay mismatch: lifecycle request comes after refund isolate already in_progress; flowID=%d resourceID=%s existingDealName=%s",
					existing.ID, para.ResourceID, existing.DealName)
			}
			// 注：本期不区分 existing.Status — 命中 in_progress 行即回放 flowId；
			// 命中 completed/failed 行：理论上不会发生（TryAcquireSlotForIsolate 的 SELECT 仅匹配 status='in_progress'）。
			return deps.Builder.NewSuccess(map[string]any{"flowId": existing.ID}), nil
		}

		// (4) 赢家分支：拿到 flowId，反向调 ctl 启动异步隔离任务。
		flowID := existing.ID
		isolateCtx, isolateCancel := context.WithTimeout(ctx, CTLCallTimeout)
		defer isolateCancel()

		_, ctlErr := deps.CTLClient.IsolatePass(
			isolateCtx,
			para.ResourceID, // pass_id 走 URL path
			&ctlclient.IsolatePassRequest{
				// 透传 trade_flow.id PK 给 ctl，使 ctl 父 task 终态时能反向调
				// trade 的 `/internal/trade/flows/{flow_id}/complete` callback 把 trade_flow.status
				// 从 in_progress 推进到 completed（设计稿 §6 + §10 Q22-I-E 端到端闭环）。
				FlowID: flowID,
				// 退费隔离业务字段（v1.7.30 BUG-35）：
				//   - NewDeadline：退费场景」非 nil time.Time（已从北京时间字面值解析为绝对时刻 UTC），ctl 后期写入 pass.expired_time
				//                 生命周期场景」 nil，ctl 后期不动 pass.expired_time
				//   - DealName：退费场景」非空字符串，仅透传给 ctl 做日志；生命周期场景」空字符串
				NewDeadline: newDeadlinePtr,
				DealName:    para.DealName,
			},
		)
		if ctlErr != nil {
			// (4a) §11 Q7=a + Q21=a1：ctl 调用失败 → DELETE trade_flow 行回滚 + 返 600302/600303 让 jifei 重试。
			// DELETE 自身失败仅日志告警不阻塞返回（残留 in_progress 行依赖 reconcile worker 兜底）。
			if delErr := deps.FlowStore.DeleteByID(context.Background(), flowID); delErr != nil {
				log.Printf("[isolateresource] rollback trade_flow failed: flowID=%d err=%v", flowID, delErr)
			}
			return classifyCTLError(deps.Builder, ctlErr), nil
		}

		// (5) ctl 已接受任务（异步派发），立即返 flowId（= trade_flow.id PK）。
		// trade_flow.status 保持 in_progress；后续：
		//   - 正常路径：ctl 父 task 收尾 → POST /internal/trade/flows/{flow_id}/complete callback 把 status 推进到 completed
		//   - jifei 主动轮询：直接落 queryFlow handler，按 trade_flow.status → jifei status 映射（0/2/3）
		//   - 异常路径：30min stale 后由 reconcile worker 兜底（本期 ResourceProber=nil → 仅日志告警）
		return deps.Builder.NewSuccess(map[string]any{"flowId": flowID}), nil
	}
}

// validatePara 校验 isolateResource 入参必填字段（§2.1 + §11 Q41 修订 region 校验）。
//
// expectedRegion 是本站点期望的 region 三元组（v1.7.x A6.2）：cn 站 = 广州（1/100001），
// intl 站 = 新加坡（9/900001）。para.Region 与 expectedRegion.RegionID 不一致时报错。
func validatePara(p *callbackPara, expectedRegion region.LighthouseRegion) error {
	if p.Uin == "" {
		return errors.New("uin is required")
	}
	if p.AppID <= 0 {
		return errors.New("appId is required")
	}
	if p.Region != expectedRegion.RegionID {
		return fmt.Errorf("region mismatch: expected %d (Lighthouse=%s), got %d",
			expectedRegion.RegionID, expectedRegion.RegionName, p.Region)
	}
	if p.ResourceID == "" {
		return errors.New("resourceId is required")
	}
	return nil
}

// classifyCTLError 把 ctlclient.IsolatePass 错误映射为 jifei.Framework 出参。
//
// 分类规则（与 §5 错误码段 + §3.4 ctl 业务错对齐）：
//   - ctlclient.ErrNotFound（HTTP 404，pass_id 不存在）→ 600303 IsolateFailed（业务永久错；jifei 后续 queryFlow 也找不到 flow_id 走 600304）
//   - *Error.Code == "PASS_ISOLATING" / "PASS_ISOLATED"（重入幂等保护）→ 视作 success：trade_flow 行已在第 (3) 步回放过；
//     仅在赢家路径才能进 (4)，此处真发生说明 ctl 侧并发同一 pass，按 600302 让 jifei 重试一次（自然走输家回放）
//   - *Error.HTTPStatus 4xx 其他 → 600303 业务错
//   - *Error.HTTPStatus 5xx / 网络错 / 超时 / 未识别错 → 600302 让 jifei 重试
func classifyCTLError(builder *jifei.FrameworkBuilder, err error) jifei.Framework {
	if err == nil {
		return builder.NewError(ReturnCodeFlowInProgress, "nil error treated as upstream failure")
	}
	if errors.Is(err, ctlclient.ErrNotFound) {
		return builder.NewError(
			ReturnCodeIsolateFailed,
			fmt.Sprintf("ctl pass not found: %v", err),
		)
	}
	if errors.Is(err, ctlclient.ErrUnauthorized) {
		return builder.NewError(
			ReturnCodeFlowInProgress,
			fmt.Sprintf("ctl unauthorized: %v", err),
		)
	}

	var ctlErr *ctlclient.Error
	if errors.As(err, &ctlErr) {
		// PASS_ISOLATING / PASS_ISOLATED 是 ctl 重入幂等保护；trade 在赢家路径碰到说明并发，让 jifei 重试。
		if ctlErr.Code == ctlclient.ErrCodePassIsolating || ctlErr.Code == ctlclient.ErrCodePassIsolated {
			return builder.NewError(
				ReturnCodeFlowInProgress,
				fmt.Sprintf("ctl already isolating/isolated (concurrent): code=%s message=%s", ctlErr.Code, ctlErr.Message),
			)
		}
		switch {
		case ctlErr.HTTPStatus >= 400 && ctlErr.HTTPStatus < 500:
			// PASS_INVALID_PARAM / 其他 4xx 业务错 → 永久错（但 jifei 协议层永不放弃，本期不退款，让 queryFlow 兜底）
			return builder.NewError(
				ReturnCodeIsolateFailed,
				fmt.Sprintf("ctl business error: code=%s message=%s request_id=%s",
					ctlErr.Code, ctlErr.Message, ctlErr.RequestID),
			)
		case ctlErr.HTTPStatus >= 500:
			return builder.NewError(
				ReturnCodeFlowInProgress,
				fmt.Sprintf("ctl 5xx: code=%s message=%s request_id=%s",
					ctlErr.Code, ctlErr.Message, ctlErr.RequestID),
			)
		}
	}
	// 网络错 / 超时 / 未识别错 → 600302 让 jifei 重试
	return builder.NewError(
		ReturnCodeFlowInProgress,
		fmt.Sprintf("ctl IsolatePass: %v", err),
	)
}
