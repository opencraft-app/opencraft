package destroyresource

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"time"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/region"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// 业务层 returnCode（设计稿 .tmp/trade-pass-destroy-design.md §3.4 + §11）。
//
// 与 createresource (60020x) / resourcequery (60010x) / isolateresource (60030x) /
// renewresource (60040x 由 renewresource 自身使用) / queryflow (60030x 复用) 错开，
// destroyResource 占用 60040x 段。
//
// 切片范围：
//   - D-1：handler 骨架，仅返 flowId，不调 ctl；触发码 600401 / 600402 / 600404
//   - D-5b：补 CTLClient.DestroyPass 反向调 + 失败 DeleteByID 回滚；600403 业务永久错正式启用
const (
	// ReturnCodeInvalidPara = destroy 入参错（uin/appId/resourceId 缺失，region != 1，JSON 解析失败等）。
	ReturnCodeInvalidPara = 600401

	// ReturnCodeFlowInProgress = ctl 调用失败 / DB 异常（B 类基础设施错）。
	// D-1 阶段仅在 TryAcquireSlotForIsolate DB 异常时触发；D-5b 起 ctl 5xx / 网络错也走这里。
	ReturnCodeFlowInProgress = 600402

	// ReturnCodeDestroyFailed = ctl 业务错（pass 不存在 / status 不可销毁 / 串货等永久失败）。
	// D-5b 切片起正式启用：ctl 4xx 业务错统一走此码（A 类永久不可发货）。
	ReturnCodeDestroyFailed = 600403

	// ReturnCodeInternalError = 通用内部错（trade_flow 输家命中 corrupted state 等）。
	ReturnCodeInternalError = 600404
)

// HandlerTimeout 是 destroyResource handler 的总超时（与 isolateResource 对齐）。
//
// 内部三层预算（与 isolateresource 对齐）：
//   - PDF 同步调用超时 3s（jifei 那一端的硬约束）
//   - trade handler 总预算 4s（与 createResource 一致；给 jifei 1s 收尾 buffer）
//   - trade → ctl 反向调用 1.5s（CTLCallTimeout）
const HandlerTimeout = 4 * time.Second

// CTLCallTimeout 是反向调 ctl DestroyPass 的子上下文超时（与 isolateresource.CTLCallTimeout 对齐）。
const CTLCallTimeout = 1500 * time.Millisecond

// flowType 固定为 destroy 路径的 §3.4 / FlowTypeDestroyResource。
const flowType = store.FlowTypeDestroyResource

// callbackPara 是 jifei `lightvela.pass.destroyResource` 回调的 interface.para 业务字段集
// （设计稿 §2.1 入向 + §11 Q24 source / Q26 productCode 反查决议）。
//
// 字段保真度：
//   - 必填：Uin / AppID / Region / ResourceID
//   - 可选（仅日志透传，不消费）：OperateUin / DealName / ProductCode / SubProductCode
//   - Q24 透传：Source（biz/qn/other/空串），透给 ctl 写 history_pass.destroy_reason 列
//   - 协议要求但本期忽略：Type / OrderType（销毁场景固定 type=2）
//
// jifei 入参 appId / region 都是 int 类型；其它都是 string。
//
// 关于 productCode（§11 Q26 ✅ 决议）：
//   - 入向 productCode 字段不消费，仅日志透传；
//   - 出向 ModifyResourceStatus 的 productCode 取值由 trade 端运行时按 pass.bundle_id 反查
//     BundleDefinition.ProductCode 得到（D-2 切片 trade.DeleteResource handler 落地）；
type callbackPara struct {
	// 必填字段（每个字段都标注 PDF 协议类型，铁律见 jifei/envelope.go 包注释）
	Uin        string `json:"uin"`        // PDF: string (quoted)
	OperateUin string `json:"operateUin"` // PDF: string (quoted)
	AppID      int64  `json:"appId"`      // PDF: int (number)
	Region     int    `json:"region"`     // PDF: int
	ResourceID string `json:"resourceId"` // PDF: string

	// 仅日志透传
	DealName       string `json:"dealName"`       // PDF: string
	ProductCode    string `json:"productCode"`    // PDF: string (optional)
	SubProductCode string `json:"subProductCode"` // PDF: string (optional)

	// Source = jifei 销毁原因（biz/qn/other/空串），透传给 ctl 写 history_pass.destroy_reason 列。
	// Q24 ✅ 拍板（设计稿 §11-A）。空串视为合法 tombstone。
	Source string `json:"source"` // PDF: string (optional)
}

// makeHandler 构造闭包 handler；导出便于单元测试直接构造而无需走 dispatcher。
//
// D-5b 切片完整流程（设计稿 §3.4 D-5b）：
//  1. 解码入参 + 校验必填 + region 校验
//  2. TryAcquireSlotForIsolate（destroy_resource flowType，与 isolate 复用同一个抢占范式）
//  3. 输家分支：回放 existing.ID 作 flowId
//  4. 赢家分支：拿到 flowId 后立即调 ctlClient.DestroyPass(passID, &DestroyPassRequest{FlowID, DestroyReason})
//  5. ctl 调用失败 → DeleteByID 回滚 trade_flow + classifyCTLError 分类（与 isolateresource 同型）
//  6. ctl 调用成功 → 立即返 flowId（trade_flow.status 保持 in_progress；ctl 父 task 收尾步 5c
//     反向调 trade /internal/trade/flows/{flow_id}/complete callback 推进到 completed）
func makeHandler(deps Deps) jifei.Handler {
	// v1.7.x 国际站接入 A6.2 + 2026-06-12 北京 2 预发布接入：在闭包构造期从
	// deps.SiteKind + deps.RegionOverride 解析出本站点期望的 region 三元组。
	// 后续入向 jifei 回调里的 para.region 需与本期望值完全匹配，
	// 否则返回 region mismatch。该 region 与出向链路 envelope.resInfo.regionId
	// （A6.1 placeorder 装配点）同源同值。
	expectedRegion := region.Resolve(deps.SiteKind, deps.RegionOverride)
	return func(ctx context.Context, paraRaw json.RawMessage) (jifei.Framework, error) {
		// (0) 总超时兑底（PDF §1.2 + 与 isolateResource 对齐）。
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
		// (2) §3.4 抢占式幂等 — 复用 TryAcquireSlotForIsolate 范式（destroy 与 isolate 同型）。
		// 入参 appID 转 string（trade_flow.app_id 列是 VARCHAR(32)，与 isolate / createresource 保持一致）。
		appIDStr := fmt.Sprintf("%d", para.AppID)
		acquired, existing, err := deps.FlowStore.TryAcquireSlotForIsolate(
			ctx, para.ResourceID, flowType, appIDStr, para.Uin, paraRaw, nil, // destroy 链路不带 dealName，传 nil 表示生命周期场景
		)
		if err != nil {
			return deps.Builder.NewError(
				ReturnCodeFlowInProgress,
				fmt.Sprintf("acquire destroy slot: %v", err),
			), nil
		}

		// (3) 输家分支：已存在 in_progress 行 → 回放同一 PK id 作 flowId。
		// 设计稿 §3.4：保证 jifei 多次重试拿到同一 flowId，便于其后续 queryFlow 反查。
		if !acquired {
			if existing == nil {
				// 防御：理论不可能（TryAcquireSlotForIsolate 实现保证 acquired==false 时回查整行）
				return deps.Builder.NewError(
					ReturnCodeInternalError,
					"destroy flow exists but re-select returned nil",
				), nil
			}
			return deps.Builder.NewSuccess(map[string]any{"flowId": existing.ID}), nil
		}

		// (4) 赢家分支：拿到 flowId，反向调 ctl 启动异步销毁主链。
		flowID := existing.ID
		destroyCtx, destroyCancel := context.WithTimeout(ctx, CTLCallTimeout)
		defer destroyCancel()

		_, ctlErr := deps.CTLClient.DestroyPass(
			destroyCtx,
			para.ResourceID, // pass_id 走 URL path
			&ctlclient.DestroyPassRequest{
				// 透传 trade_flow.id PK 给 ctl，使 ctl 父 task 收尾步 5c 能反向调
				// trade 的 `/internal/trade/flows/{flow_id}/complete` callback 把 trade_flow.status
				// 从 in_progress 推进到 completed（设计稿 §4.6 + §10 端到端闭环）。
				FlowID: flowID,
				// Q24 ✅ 拍板：透传 jifei `para.source` 原值给 ctl，由 ctl 父 task 收尾步 5b
				// 写入 history_pass.destroy_reason 列。
				DestroyReason: para.Source,
			},
		)
		if ctlErr != nil {
			// (4a) §3.4 + §11 Q1：ctl 调用失败 → DELETE trade_flow 行回滚 + 返 600402/600403。
			// DELETE 自身失败仅日志告警不阻塞返回（残留 in_progress 行依赖 reconcile worker 兜底）。
			if delErr := deps.FlowStore.DeleteByID(context.Background(), flowID); delErr != nil {
				log.Printf("[destroyresource] rollback trade_flow failed: flowID=%d err=%v", flowID, delErr)
			}
			return classifyCTLError(deps.Builder, ctlErr), nil
		}

		// (5) ctl 已接受任务（异步派发），立即返 flowId（= trade_flow.id PK）。
		// trade_flow.status 保持 in_progress；后续：
		//   - 正常路径：ctl 父 task 收尾 → POST /internal/trade/flows/{flow_id}/complete callback 把 status 推进到 completed
		//   - 异常路径：ctl 父 task max_execute_count 极大（永不放弃）+ reconcile worker 兜底
		return deps.Builder.NewSuccess(map[string]any{"flowId": flowID}), nil
	}
}

// validatePara 校验 destroyResource 入参必填字段（§2.1 + §11 Q41 region 校验范式）。
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

// classifyCTLError 把 ctlclient.DestroyPass 错误映射为 jifei.Framework 出参（与 isolateresource.classifyCTLError 同型）。
//
// 分类规则（与 §3.4 + §4.5.2/3 错误码段对齐）：
//   - ctlclient.ErrNotFound（HTTP 404，pass_id 不存在）→ 600403 DestroyFailed
//     （业务永久错；jifei 后续 queryFlow 也找不到 flow_id 走 600404）
//   - *Error.Code == "PASS_TERMINATING"（重入幂等保护）→ 走 600402 让 jifei 自然重试一次
//     （输家路径回放同一 flowId，等价于 idempotent 成功）
//   - *Error.Code == "PASS_NOT_FOUND" / "PASS_INVALID_PARAM"（含 status 不在 {deleting,isolated}）→ 600403 业务永久错
//   - *Error.HTTPStatus 4xx 其他 → 600403 业务永久错
//   - *Error.HTTPStatus 5xx / 网络错 / 超时 / 未识别错 → 600402 让 jifei 重试
func classifyCTLError(builder *jifei.FrameworkBuilder, err error) jifei.Framework {
	if err == nil {
		return builder.NewError(ReturnCodeFlowInProgress, "nil error treated as upstream failure")
	}
	if errors.Is(err, ctlclient.ErrNotFound) {
		return builder.NewError(
			ReturnCodeDestroyFailed,
			fmt.Sprintf("ctl pass not found: %v", err),
		)
	}
	if errors.Is(err, ctlclient.ErrUnauthorized) {
		// trade ↔ ctl 内部 token 不一致 — 配置错，rotate 后可恢复 → B 类
		return builder.NewError(
			ReturnCodeFlowInProgress,
			fmt.Sprintf("ctl unauthorized: %v", err),
		)
	}

	var ctlErr *ctlclient.Error
	if errors.As(err, &ctlErr) {
		switch ctlErr.Code {
		case ctlclient.ErrCodePassTerminating:
			// 重入幂等：ctl 已在销毁主链中。让 jifei 重试一次走输家回放同一 flowId 即可。
			return builder.NewError(
				ReturnCodeFlowInProgress,
				fmt.Sprintf("ctl pass already terminating: %v", err),
			)
		case ctlclient.ErrCodePassNotFound:
			// 双重保护：ctl 走 *Error 而非 ErrNotFound 分支时（如 envelope 解析异常）兜底
			return builder.NewError(
				ReturnCodeDestroyFailed,
				fmt.Sprintf("ctl pass not found: %v", err),
			)
		case ctlclient.ErrCodePassInvalidParam:
			// pass status 不在 {deleting, isolated} 集合 → 永久不可推进 → A 类
			return builder.NewError(
				ReturnCodeDestroyFailed,
				fmt.Sprintf("ctl pass invalid status: %v", err),
			)
		}
		// 其它 4xx 业务错 → 600403 永久错
		if ctlErr.HTTPStatus >= 400 && ctlErr.HTTPStatus < 500 {
			return builder.NewError(
				ReturnCodeDestroyFailed,
				fmt.Sprintf("ctl business error: %v", err),
			)
		}
		// 5xx → 600402 让 jifei 重试
		return builder.NewError(
			ReturnCodeFlowInProgress,
			fmt.Sprintf("ctl 5xx error: %v", err),
		)
	}

	// 网络错 / 超时 / 未识别错 → 600402 让 jifei 重试（保守，避免误退款）
	return builder.NewError(
		ReturnCodeFlowInProgress,
		fmt.Sprintf("ctl call failed: %v", err),
	)
}
