package resourcequery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/region"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// getUserResourcesPara 是 jifei.getUserResources 的 interface.para 业务字段集（设计稿 §2.3）。
//
// PDF 协议层关键差异（与 getAllAppIds 对比）：
//   - uin 必填（注意 PDF 示例 "uin": "123" 是字符串）
//   - appId 必填（int）
//   - subProductCode 选填（Q2 拍板）
//   - needDeviceInfos / type 字段不读
type getUserResourcesPara struct {
	// 必填字段（每个字段都标注 PDF 协议类型，铁律见 jifei/envelope.go 包注释）
	Uin             string `json:"uin"`             // PDF: string (quoted)
	AppID           int64  `json:"appId"`           // PDF: int (number)
	ProductCode     string `json:"productCode"`     // PDF: string
	SubProductCode  string `json:"subProductCode"`  // PDF: string (optional)
	PayMode         int    `json:"payMode"`         // PDF: int (0/1/2)
	Region          int    `json:"region"`          // PDF: int (区域码表)
	PageNo          int    `json:"pageNo"`          // PDF: int (从 0 开始)
	PageSize        int    `json:"pageSize"`        // PDF: int (默认 1000)
	NeedDeviceInfos int    `json:"needDeviceInfos"` // PDF: int (optional, trade 不消费)
}

// makeGetUserResourcesHandler 构造 lightvela.pass.getUserResources 的真 handler。
//
// 处理流程（设计稿 §3.2 反查链路）：
//
//	(0) ctx WithTimeout 总超时 2.5s
//	(1) 解码 para；必填字段校验
//	(2) PDF §1.1：payMode != 1 直接返空响应
//	(3) subProductCode 解析为 bundle_ids（同 getAllAppIds 逻辑）
//	(4) 调 ctl.ListPassesByAppID（ctx 收紧到 1.5s）
//	(5) batch 反查 trade_bundle_definition（按返回的 pass.BundleID 集合去重 + 单次 in-memory 缓存）
//	(6) 字段映射：每条 pass → resources[i]，组装 envelope
func makeGetUserResourcesHandler(deps Deps) jifei.Handler {
	// v1.7.x 国际站接入 A6.1 + 2026-06-12 北京 2 预发布接入：构造期从
	// deps.SiteKind + deps.RegionOverride 解析出本站点期望的 region 三元组，
	// 下发 mapper 在反查响应里写入 region / zoneId / productInfo[地域].value 三处。
	expectedRegion := region.Resolve(deps.SiteKind, deps.RegionOverride)
	return func(ctx context.Context, paraRaw json.RawMessage) (jifei.Framework, error) {
		// (0) 总超时兜底。
		ctx, cancel := context.WithTimeout(ctx, HandlerTimeout)
		defer cancel()

		// (1) 解码 para
		var para getUserResourcesPara
		if err := json.Unmarshal(paraRaw, &para); err != nil {
			return deps.Builder.NewError(
				ReturnCodeInvalidPara,
				fmt.Sprintf("invalid para json: %v", err),
			), nil
		}
		if err := validateGetUserResourcesPara(&para); err != nil {
			return deps.Builder.NewError(ReturnCodeInvalidPara, err.Error()), nil
		}

		// (2) payMode 不合法 → PDF §1.1 返空。
		if para.PayMode != payModeOnlyPrepay {
			return deps.Builder.NewSuccess(emptyResourcesResponse()), nil
		}

		// (3) subProductCode 解析。
		bundleIDs, err := resolveBundleIDs(ctx, deps.BundleStore, para.ProductCode, para.SubProductCode)
		if err != nil {
			return deps.Builder.NewError(
				ReturnCodeUpstreamUnavailable,
				fmt.Sprintf("resolve bundle_ids failed: %v", err),
			), nil
		}
		if para.SubProductCode != "" && len(bundleIDs) == 0 {
			return deps.Builder.NewSuccess(emptyResourcesResponse()), nil
		}

		// (4) 调 ctl 反查。
		ctlCtx, ctlCancel := withCTLTimeout(ctx)
		defer ctlCancel()

		passes, total, err := deps.CTLClient.ListPassesByAppID(
			ctlCtx, para.AppID, bundleIDs, para.PageNo, para.PageSize,
		)
		if err != nil {
			return deps.Builder.NewError(
				ReturnCodeUpstreamUnavailable,
				fmt.Sprintf("ctl ListPassesByAppID failed: %v", err),
			), nil
		}

		// (5) batch 反查 BundleDefinition（同一 page 内按 bundleID 去重缓存，避免 N+1）。
		bundleDefs, err := batchGetBundleDefs(ctx, deps.BundleStore, passes)
		if err != nil {
			return deps.Builder.NewError(
				ReturnCodeUpstreamUnavailable,
				fmt.Sprintf("batch get bundle_definitions failed: %v", err),
			), nil
		}

		// (6) 字段映射。
		// jifei resources[i].uin 按设计稿 §3.3 是"入参 uin 透传"（string）；
		// jifei resources[i].appId 按设计稿 §3.3 是"入参 appId 透传"（int）。
		uinStr := para.Uin
		resources := make([]map[string]interface{}, 0, len(passes))
		for _, pass := range passes {
			if pass == nil {
				continue
			}
			def := bundleDefs[pass.BundleID] // nil 时 mapper 内部 buildResourceGoodsDetail 返空 map
			resources = append(resources, passToResourceMap(pass, uinStr, para.AppID, def, expectedRegion))
		}

		return deps.Builder.NewSuccess(map[string]any{
			"resources": resources,
			"total":     total,
		}), nil
	}
}

// validateGetUserResourcesPara 做必填字段校验（PDF §2.3 / 设计稿 §2.3）。
//
// v1.7.28 BUG-20 修订（2026-05-21）：删除顶层 productCode 必填校验。
//   - PDF §2.3 getUserResources 入参集为 `uin + appId + payMode + region +
//     pageNo + pageSize + needDeviceInfos? + subProductCode? + productCode?`
//     — **productCode 不是必传**（jifei 真实回调 retry=18 实测也只发 appId/uin/
//     payMode/region/pageNo/pageSize，不发顶层 productCode）。
//   - resolveBundleIDs 在 productCode == "" 且 subProductCode == "" 时已经走
//     全量 bundle_ids 路径（即查 user 在 trade 下所有 active pass），与 PDF
//     反查语义一致。
//   - 与 BUG-13/14/19 同模式：trade 自家加了 PDF 没有的必填，导致 jifei
//     真实回调 600201 卡死。
func validateGetUserResourcesPara(p *getUserResourcesPara) error {
	if p.Uin == "" {
		return errors.New("uin is required")
	}
	// PDF "uin": "123" 是字符串但内部用 int64；解析失败 → 返参数错。
	if _, err := strconv.ParseInt(p.Uin, 10, 64); err != nil {
		return fmt.Errorf("uin must be a numeric string, got %q", p.Uin)
	}
	if p.AppID <= 0 {
		return fmt.Errorf("appId must be > 0, got %d", p.AppID)
	}
	if p.PageSize <= 0 {
		return fmt.Errorf("pageSize must be > 0, got %d", p.PageSize)
	}
	if p.PageNo < 0 {
		return fmt.Errorf("pageNo must be >= 0, got %d", p.PageNo)
	}
	return nil
}

// batchGetBundleDefs 按 passes 中出现的 bundleID 集合去重批量反查 BundleDefinition。
//
// 设计动机：page_size 默认 1000，原先用单条 GetBundleDefinitionByID 循环最坏 1000 次 RPC。
// 11C-3 抽取后改为单次 GetBundleDefinitionsByIDs（一条 SQL `IN (?,...)`），
// 即便 page 内 bundleID 全异也只打一次 SQL。
//
// 行为契约（与 11C 之前等价）：
//   - 入参为空 / 全 nil pass / pass.BundleID 空字符串 → 返空 map
//   - bundle 已下架（map 中 key 缺失）→ result[bundleID] = nil（调用方按 nil 走 graceful-degrade）
//   - DB 硬错 → 整批 wrap error 返回
func batchGetBundleDefs(
	ctx context.Context,
	bundleStore store.BundleDefinitionStore,
	passes []*ctlclient.PassDetail,
) (map[string]*store.BundleDefinition, error) {
	if len(passes) == 0 {
		return map[string]*store.BundleDefinition{}, nil
	}

	// 去重 bundleID 集合（避免 IN(?,?,...) 含重复值）
	seen := make(map[string]struct{}, len(passes))
	dedupedIDs := make([]string, 0, len(passes))
	for _, p := range passes {
		if p == nil || p.BundleID == "" {
			continue
		}
		if _, dup := seen[p.BundleID]; dup {
			continue
		}
		seen[p.BundleID] = struct{}{}
		dedupedIDs = append(dedupedIDs, p.BundleID)
	}
	if len(dedupedIDs) == 0 {
		return map[string]*store.BundleDefinition{}, nil
	}

	defs, err := bundleStore.GetBundleDefinitionsByIDs(ctx, dedupedIDs)
	if err != nil {
		return nil, fmt.Errorf("batch get bundle_definitions: %w", err)
	}

	// map 中缺失的 bundleID（已下架 / 表无记录）→ result[id] = nil
	// 调用方靠 result[bundleID] == nil 触发 goodsDetail 退化（与原单条 ErrNotFound 软错语义等价）。
	result := make(map[string]*store.BundleDefinition, len(dedupedIDs))
	for _, id := range dedupedIDs {
		result[id] = defs[id] // 缺失 key 取出来是 nil，正合本意
	}
	return result, nil
}

// emptyResourcesResponse 返回 getUserResources / queryResource 共用的空响应 data。
func emptyResourcesResponse() map[string]any {
	return map[string]any{
		"resources": []map[string]interface{}{},
		"total":     int64(0),
	}
}
