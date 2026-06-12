package queryflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/region"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// 业务层 returnCode（与 isolateresource 共用 60030x 段；本 handler 用到 600301 / 600304）。
const (
	// ReturnCodeInvalidPara = queryFlow 入参错（uin / appId / flowId 缺失，region != 1，JSON 解析失败等）。
	ReturnCodeInvalidPara = 600301

	// ReturnCodeFlowInProgress = DB 异常等基础设施错。
	ReturnCodeFlowInProgress = 600302

	// ReturnCodeInternalError = flow_id 反查不存在 / 通用内部错（§11 Q5=c）。
	ReturnCodeInternalError = 600304
)

// jifei status 五态枚举（PDF §4.2）；本期实际使用 0 / 2 / 3。
const (
	// StatusSuccess = jifei 行为"更新订单为成功，不再重试"
	// trade 触发条件：trade_flow.status=completed
	StatusSuccess = 0

	// StatusInProgress = jifei 行为"继续 queryFlow（发货中）"
	// trade 触发条件：trade_flow.status=in_progress
	StatusInProgress = 2

	// StatusFailedRefund = jifei 行为"取消订单+退款，不再重试"
	// trade 触发条件：trade_flow.status=failed
	// 注：§11 Q11 修订版下 isolate 链路业务失败永不存在（父 task unbounded 重投至 all-success）；
	// 本码主要为 createResource 链路准备 — queryFlow 接口在 isolate 实操中很少返 3。
	StatusFailedRefund = 3
)

// HandlerTimeout 是 queryFlow handler 的总超时（与 isolate 对齐）。
const HandlerTimeout = 4 * time.Second

// callbackPara 是 jifei `lightvela.pass.queryFlow` 回调的 interface.para 业务字段集（§2.3）。
type callbackPara struct {
	// 必填字段（每个字段都标注 PDF 协议类型，铁律见 jifei/envelope.go 包注释）
	Uin    string `json:"uin"`    // PDF: string (quoted)
	AppID  int64  `json:"appId"`  // PDF: int (number)
	Region int    `json:"region"` // PDF: int
	FlowID int64  `json:"flowId"` // PDF: int (number); 任务 id 为 0 视为失败

	// 仅日志校验
	ProductCode    string `json:"productCode"`    // PDF: string (optional)
	SubProductCode string `json:"subProductCode"` // PDF: string (optional)
	Type           string `json:"type"`           // PDF: string (optional)
}

// makeHandler 构造闭包 handler。
func makeHandler(deps Deps) jifei.Handler {
	// v1.7.x 国际站接入 A6.2 + 2026-06-12 北京 2 预发布接入：构造期从
	// deps.SiteKind + deps.RegionOverride 解析出本站点期望的 region 三元组，
	// 与 destroyresource / isolateresource handler 同模式。
	expectedRegion := region.Resolve(deps.SiteKind, deps.RegionOverride)
	return func(ctx context.Context, paraRaw json.RawMessage) (jifei.Framework, error) {
		ctx, cancel := context.WithTimeout(ctx, HandlerTimeout)
		defer cancel()

		var para callbackPara
		if err := json.Unmarshal(paraRaw, &para); err != nil {
			return deps.Builder.NewError(ReturnCodeInvalidPara, fmt.Sprintf("invalid para json: %v", err)), nil
		}
		if err := validatePara(&para, expectedRegion); err != nil {
			return deps.Builder.NewError(ReturnCodeInvalidPara, err.Error()), nil
		}

		// 反查 trade_flow（按 PK id）
		flow, err := deps.FlowStore.GetByID(ctx, para.FlowID)
		if errors.Is(err, store.ErrFlowNotFound) {
			// §11 Q5=c：jifei 拿到不存在的 flowId（理论上不应发生）→ 返 600304
			return deps.Builder.NewError(
				ReturnCodeInternalError,
				fmt.Sprintf("flow not found: flowId=%d", para.FlowID),
			), nil
		}
		if err != nil {
			return deps.Builder.NewError(
				ReturnCodeFlowInProgress,
				fmt.Sprintf("get trade_flow: %v", err),
			), nil
		}

		// trade_flow.status → jifei status 映射
		switch flow.Status {
		case store.FlowStatusCompleted:
			return deps.Builder.NewSuccess(map[string]any{"status": StatusSuccess}), nil
		case store.FlowStatusInProgress:
			return deps.Builder.NewSuccess(map[string]any{"status": StatusInProgress}), nil
		case store.FlowStatusFailed:
			return deps.Builder.NewSuccess(map[string]any{"status": StatusFailedRefund}), nil
		default:
			// 未知状态（DB 数据异常）— 兜底返 600304 让 jifei 重试 / 报错
			return deps.Builder.NewError(
				ReturnCodeInternalError,
				fmt.Sprintf("trade_flow unknown status=%q flowId=%d", flow.Status, para.FlowID),
			), nil
		}
	}
}

// validatePara 校验 queryFlow 入参必填字段。
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
	if p.FlowID <= 0 {
		return errors.New("flowId is required")
	}
	return nil
}
