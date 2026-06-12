package resourcequery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/region"
)

// queryResourcePara 是 jifei.queryResource 的 interface.para 业务字段集（设计稿 §2.4）。
//
// PDF 协议层关键差异（与 getUserResources 对比）：
//   - resourceIds 必填（数组，至少 1，至多 100；trade 内部按 100 兜底）
//   - subProductCode / productCode 选填（PDF §2.2 明示 queryResource 可不用 subProductCode 过滤）
//   - 不带 pageNo / pageSize（按 ID 反查不分页，所有命中的资源一次性返回）
//   - 不存在的 / 已销毁的资源**不返回**（PDF §1.2，调用方自行差集判断）
type queryResourcePara struct {
	// 必填字段（每个字段都标注 PDF 协议类型，铁律见 jifei/envelope.go 包注释）
	Uin             string   `json:"uin"`             // PDF: string (quoted)
	AppID           int64    `json:"appId"`           // PDF: int (number)
	PayMode         int      `json:"payMode"`         // PDF: int (optional, 默认 1)
	ProductCode     string   `json:"productCode"`     // PDF: string (optional)
	SubProductCode  string   `json:"subProductCode"`  // PDF: string (optional)
	Region          int      `json:"region"`          // PDF: int (区域码表)
	ResourceIDs     []string `json:"resourceIds"`     // PDF: string[] (至少支持 100 个)
	NeedDeviceInfos int      `json:"needDeviceInfos"` // PDF: int (optional, trade 不消费)
}

// makeQueryResourceHandler 构造 lightvela.pass.queryResource 的真 handler。
//
// 处理流程（设计稿 §3.2 反查链路）：
//
//	(0) ctx WithTimeout 总超时 2.5s
//	(1) 解码 para；必填字段校验
//	(2) PDF §2.2：payMode 缺省 = 1（trade 全预付费）；payMode != 1 直接返空
//	(3) **不**走 BundleStore 解析 bundle_ids（PDF §2.2 + 设计稿 §2.4 明示）
//	(4) 调 ctl.ListPassesByResourceIDs（按 ResourceIDs 反查 — ctl 内部用 (app_id, pass_ids) 过滤）
//	(5) batch 反查 trade_bundle_definition（按返回 pass.BundleID 去重）
//	(6) 字段映射：每条 pass → resources[i]，组装 envelope
//
// 与 getUserResources 的关键差异：
//   - 不分页；所以响应里的 total = len(resources)（命中数，不是去重总量）
//   - 不存在的 resourceId 不返回（资源数 < 入参数是合法行为）
func makeQueryResourceHandler(deps Deps) jifei.Handler {
	// v1.7.x 国际站接入 A6.1 + 2026-06-12 北京 2 预发布接入：构造期从
	// deps.SiteKind + deps.RegionOverride 解析出本站点期望的 region 三元组，
	// 与 getUserResources 同范式。
	expectedRegion := region.Resolve(deps.SiteKind, deps.RegionOverride)
	return func(ctx context.Context, paraRaw json.RawMessage) (jifei.Framework, error) {
		// (0) 总超时兜底。
		ctx, cancel := context.WithTimeout(ctx, HandlerTimeout)
		defer cancel()

		// (1) 解码 para
		var para queryResourcePara
		if err := json.Unmarshal(paraRaw, &para); err != nil {
			return deps.Builder.NewError(
				ReturnCodeInvalidPara,
				fmt.Sprintf("invalid para json: %v", err),
			), nil
		}

		// PDF §2.2：payMode 缺省 1；空字段（== 0）按缺省处理。
		if para.PayMode == 0 {
			para.PayMode = payModeOnlyPrepay
		}

		if err := validateQueryResourcePara(&para); err != nil {
			return deps.Builder.NewError(ReturnCodeInvalidPara, err.Error()), nil
		}

		// (2) payMode 不合法 → 返空（与 getAllAppIds / getUserResources 行为一致）。
		if para.PayMode != payModeOnlyPrepay {
			return deps.Builder.NewSuccess(emptyResourcesResponse()), nil
		}

		// (3) 不解析 bundle_ids（PDF §2.2 明示）。

		// (4) 调 ctl 反查。
		ctlCtx, ctlCancel := withCTLTimeout(ctx)
		defer ctlCancel()

		passes, err := deps.CTLClient.ListPassesByResourceIDs(ctlCtx, para.AppID, para.ResourceIDs)
		if err != nil {
			return deps.Builder.NewError(
				ReturnCodeUpstreamUnavailable,
				fmt.Sprintf("ctl ListPassesByResourceIDs failed: %v", err),
			), nil
		}

		// (5) batch 反查 BundleDefinition。
		bundleDefs, err := batchGetBundleDefs(ctx, deps.BundleStore, passes)
		if err != nil {
			return deps.Builder.NewError(
				ReturnCodeUpstreamUnavailable,
				fmt.Sprintf("batch get bundle_definitions failed: %v", err),
			), nil
		}

		// (6) 字段映射。
		uinStr := para.Uin
		resources := make([]map[string]interface{}, 0, len(passes))
		for _, pass := range passes {
			if pass == nil {
				continue
			}
			def := bundleDefs[pass.BundleID]
			resources = append(resources, passToResourceMap(pass, uinStr, para.AppID, def, expectedRegion))
		}

		// queryResource 不分页：total = 命中数（不是入参总量；销毁资源已被 ctl 过滤掉）。
		return deps.Builder.NewSuccess(map[string]any{
			"resources": resources,
			"total":     int64(len(resources)),
		}), nil
	}
}

// validateQueryResourcePara 做必填字段校验（PDF §2.2 / 设计稿 §2.4）。
//
// 关键约束：
//   - appId 必填（PDF §2.2 表"appId 必传"）
//   - resourceIds 必填，1 ≤ len ≤ 100（PDF §2.2 + ctlclient 兜底）
//   - region 协议层必传但 trade 不做匹配判定（Q41 修订）
//
// v1.7.28 BUG-19 修订（2026-05-21）：删除顶层 uin 必填校验。
//   - PDF §2.2 queryResource 入参集只有 `appId + resourceIds[] + region +
//     payMode? + productCode? + subProductCode?`，**不发 uin**（按 (appId,
//     resourceIds[]) 反查就够，uin 是 jifei 协议层冗余信息）。
//   - 与 BUG-13/14 同模式：trade 自家加了 PDF 没有的必填，导致 jifei 真实
//     回调被卡 600201。
//   - mapper 下游 passToResourceMap 仍接 `para.Uin`（空字符串透传），但
//     jifei 协议侧不会读 resources[i].uin（queryResource 是按 ID 反查不需要
//     回写 uin），代价仅是 resources[i].uin = ""，可接受。
func validateQueryResourcePara(p *queryResourcePara) error {
	if p.AppID <= 0 {
		return fmt.Errorf("appId must be > 0, got %d", p.AppID)
	}
	if len(p.ResourceIDs) == 0 {
		return errors.New("resourceIds must not be empty")
	}
	if len(p.ResourceIDs) > resourceIDsMax {
		return fmt.Errorf("resourceIds exceed limit %d, got %d", resourceIDsMax, len(p.ResourceIDs))
	}
	for i, rid := range p.ResourceIDs {
		if rid == "" {
			return fmt.Errorf("resourceIds[%d] is empty", i)
		}
	}
	// uin 选填；如果 jifei 真发了 uin 字段且非空，做格式 sanity check（与历史行为兼容）。
	if p.Uin != "" {
		if _, err := strconv.ParseInt(p.Uin, 10, 64); err != nil {
			return fmt.Errorf("uin must be a numeric string when present, got %q", p.Uin)
		}
	}
	return nil
}
