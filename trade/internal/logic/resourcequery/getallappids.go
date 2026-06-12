package resourcequery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
)

// getAllAppIDsPara 是 jifei.getAllAppIds 的 interface.para 业务字段集（设计稿 §2.2）。
//
// 字段类型完全按 PDF 协议层定义：
//   - productCode / subProductCode：string
//   - payMode / region / pageNo / pageSize：int（PDF 第 3 页示例 number 类型）
//   - type：已下线（PDF §2.2 明示），不读
type getAllAppIDsPara struct {
	// 必填字段（每个字段都标注 PDF 协议类型，铁律见 jifei/envelope.go 包注释）
	ProductCode    string `json:"productCode"`    // PDF: string
	SubProductCode string `json:"subProductCode"` // PDF: string
	PayMode        int    `json:"payMode"`        // PDF: int (0/1/2)
	Region         int    `json:"region"`         // PDF: int (区域码表)
	PageNo         int    `json:"pageNo"`         // PDF: int (从 0 开始)
	PageSize       int    `json:"pageSize"`       // PDF: int (默认 20000)
}

// makeGetAllAppIDsHandler 构造 lightvela.pass.getAllAppIds 的真 handler。
//
// 处理流程（设计稿 §3.2 反查链路）：
//
//	(0) ctx WithTimeout 总超时 2.5s（HandlerTimeout）兜底
//	(1) 解码 para；必填字段校验
//	(2) PDF §1.1：payMode != 1 直接返空响应（{appIds:[], total:0}），returnCode = 0
//	(3) subProductCode 非空 → BundleStore 解析为 bundle_ids；空 → 不传 bundle_ids（ctl 不加过滤）
//	    解析返空列表 → 直接返空响应（jifei 该 sub 无数据）
//	(4) 调 ctl.ListPassAppIDs（ctx 收紧到 1.5s）
//	(5) 拼装响应 {appIds, total}（int64 → JSON int）
func makeGetAllAppIDsHandler(deps Deps) jifei.Handler {
	return func(ctx context.Context, paraRaw json.RawMessage) (jifei.Framework, error) {
		// (0) 总超时兜底（设计稿三层预算中层）。
		ctx, cancel := context.WithTimeout(ctx, HandlerTimeout)
		defer cancel()

		// (1) 解码 para
		var para getAllAppIDsPara
		if err := json.Unmarshal(paraRaw, &para); err != nil {
			return deps.Builder.NewError(
				ReturnCodeInvalidPara,
				fmt.Sprintf("invalid para json: %v", err),
			), nil
		}
		if err := validateGetAllAppIDsPara(&para); err != nil {
			return deps.Builder.NewError(ReturnCodeInvalidPara, err.Error()), nil
		}

		// (2) payMode 不合法（trade 仅支持预付费 1）→ PDF §1.1 明示"返回空响应而不报错"。
		if para.PayMode != payModeOnlyPrepay {
			return deps.Builder.NewSuccess(emptyAppIDsResponse()), nil
		}

		// (3) subProductCode 解析为 bundle_ids（Q2 拍板）。
		bundleIDs, err := resolveBundleIDs(ctx, deps.BundleStore, para.ProductCode, para.SubProductCode)
		if err != nil {
			return deps.Builder.NewError(
				ReturnCodeUpstreamUnavailable,
				fmt.Sprintf("resolve bundle_ids failed: %v", err),
			), nil
		}
		// subProductCode 非空但解析返空列表 → 该 sub 在 trade_bundle_definition 中无录入，
		// 直接返空响应（不打到 ctl，节省一次 RPC）。
		if para.SubProductCode != "" && len(bundleIDs) == 0 {
			return deps.Builder.NewSuccess(emptyAppIDsResponse()), nil
		}

		// (4) 调 ctl 反查（ctx 收紧到 1.5s）。
		ctlCtx, ctlCancel := withCTLTimeout(ctx)
		defer ctlCancel()

		appIDs, total, err := deps.CTLClient.ListPassAppIDs(ctlCtx, bundleIDs, para.PageNo, para.PageSize)
		if err != nil {
			return deps.Builder.NewError(
				ReturnCodeUpstreamUnavailable,
				fmt.Sprintf("ctl ListPassAppIDs failed: %v", err),
			), nil
		}
		// nil → 空数组（jifei 严格不允许 null）
		if appIDs == nil {
			appIDs = []int64{}
		}

		// (5) 拼装响应。
		return deps.Builder.NewSuccess(map[string]any{
			"appIds": appIDs,
			"total":  total,
		}), nil
	}
}

// validateGetAllAppIDsPara 做必填字段校验。
//
// PDF §2.2 / 设计稿 §2.2：productCode / payMode / region / pageNo / pageSize 必填；
// subProductCode 选填（Q2 拍板 2026-05-11）。pageSize 上限 20000（PDF 默认值，trade 兜底）。
func validateGetAllAppIDsPara(p *getAllAppIDsPara) error {
	if p.ProductCode == "" {
		return errors.New("productCode is required")
	}
	if p.PageSize <= 0 {
		return fmt.Errorf("pageSize must be > 0, got %d", p.PageSize)
	}
	if p.PageSize > pageSizeAppIDsMax {
		return fmt.Errorf("pageSize must be <= %d, got %d", pageSizeAppIDsMax, p.PageSize)
	}
	if p.PageNo < 0 {
		return fmt.Errorf("pageNo must be >= 0, got %d", p.PageNo)
	}
	// payMode / region 允许任意值（payMode 不合法走"空响应"分支，不报错；
	// region 按 Q41 修订 trade 不做匹配判定，只要协议层有此字段即可）。
	return nil
}

// emptyAppIDsResponse 返回 getAllAppIds 的空响应 data（PDF §1.1：jifei 严格不允许 null）。
func emptyAppIDsResponse() map[string]any {
	return map[string]any{
		"appIds": []int64{},
		"total":  int64(0),
	}
}
