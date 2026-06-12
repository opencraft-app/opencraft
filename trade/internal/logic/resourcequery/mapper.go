package resourcequery

import (
	"time"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/jifei"
	"git.woa.com/wisp/mono/trade/internal/region"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// buildResourceGoodsDetail 构造资源反查侧的 goodsDetail（设计稿 §2.5 / §3.3）。
//
// 与 trade/internal/logic/inquiry/service.go::buildGoodsDetail 同源（同样基于 BundleDefinition），
// 但**去掉订单字段**（timeSpan / timeUnit / goodsNum）—— 资源反查不持有"订单"概念，
// 这些字段是询价 / 下单时的瞬时输入，反查响应里**不应**透传。
//
// 字段集（设计稿 §2.5 反查侧最小集）：
//   - productCode：bundle.product_code
//   - subProductCode：bundle.sub_product_code
//   - pid：bundle.pid（int64，Q71 拍板 2026-05-13；与 inquiry / placeorder 一致）
//   - sv_*：bundle.sv_list 直接透传（key **必须**已带 sv_ 前缀，值是 int64 直接透传，
//     与 jifei 协议层一致 — PDF §4.4 line 30/38 / §4.4.1.1.2 line 23）
//   - productInfo：固定附加 [{name:"地域",value:<region.RegionName>}]（v1.7.x A6.1 起按 site 维度参数化：
//     cn 站 = "广州" / intl 站 = "Singapore"）；若 bundle.product_info 也有数据则合并追加（不去重，
//     以 bundle 录入为准）
//
// **未实现**字段（设计稿 §2.5 / Q5 拍板 2026-05-11）：
//   - bundleId / resourceId：lightpower 注释"用于自动续费、隔离、销毁"，trade 当前不通过 goodsDetail
//     传递这些（已经在 resources[i].resourceId 顶层字段返回）；先不返避免歧义。
//   - billExtendFields / resourceGroupIdList：trade 不接资源组 / 账单扩展字段。
//   - lightpower 自定义字段（ID / Name / Region / RegionName / PublicNetworkIP）：Q5 拍板**不返**。
//
// def 不可为 nil（调用方应在 ctl 反查前过滤 nil；本函数防御 nil 直接返空 map 而非 panic）。
//
// regionTriple 是站点 region 三元组，由调用方从 install.Deps.SiteKind 经 region.Resolve 解析后注入；
// 仅用于 productInfo 中"地域"字段的 value（cn=广州 / intl=Singapore）。
func buildResourceGoodsDetail(def *store.BundleDefinition, regionTriple region.LighthouseRegion) map[string]interface{} {
	if def == nil {
		return map[string]interface{}{}
	}
	gd := map[string]interface{}{
		"productCode":    def.ProductCode,
		"subProductCode": def.SubProductCode,
		"pid":            def.Pid,
	}
	// sv_* 直接透传（与 inquiry / placeorder 一致：2026-05-13 起契约变更，运营录入 key
	// **必须**已带 sv_ 前缀，本函数**不再**自动补前缀；Q71 推翻 Q66：值是 int64 直接透传，
	// 与 jifei 协议层 sv_* int 类型一致 — checkCreate 对账时也按数值比较）。
	for key, value := range def.SVList {
		gd[key] = value
	}

	// productInfo 合并：trade 内部固定追加"地域=<本站点 RegionName>"（设计稿 §2.5 / Q41 修订 +
	// v1.7.x A6.1 国际站接入），若 bundle.product_info 已有内容也保留（运营定义优先级较高 —
	// 例如套餐内含资源说明）。
	productInfo := make([]map[string]interface{}, 0, len(def.ProductInfo)+1)
	productInfo = append(productInfo, map[string]interface{}{
		"name":  "地域",
		"value": regionTriple.RegionName,
	})
	productInfo = append(productInfo, def.ProductInfo...)
	gd["productInfo"] = productInfo

	return gd
}

// passToResourceMap 把单条 ctl PassDetail 映射为 jifei resources[i] 字段集（设计稿 §3.3）。
//
// 字段映射全表（与 §3.3 表格完全对齐）：
//   - uin → 入参 uin 透传（**不**用 pass.Uin —— 设计稿明示"入参 uin 透传"）；
//     函数签名传入 uinStr 由调用方决定（getUserResources 用入参；queryResource 用入参）
//   - appId → 入参 appId 透传（同上）
//   - resourceId → pass.PassID
//   - region → regionTriple.RegionID（v1.7.x A6.1 起按 site 维度：cn=1 / intl=9）
//   - zoneId → regionTriple.ZoneID（v1.7.x A6.1 起按 site 维度：cn=100001 / intl=900001）
//   - status → pass.IsolatedTime != nil → 2，其他 → 1
//   - isolatedTimestamp → pass.IsolatedTime 北京时间格式化；nil → "0000-00-00 00:00:00"
//   - createTime → pass.CreatedTime 北京时间格式化
//   - expireTime → pass.ExpiredTime 北京时间格式化
//   - payMode → 固定 1（trade 全预付费）
//   - instanceType → 固定 0（普通）
//   - allowReturn → 固定 1
//   - renewFlag → MANUAL_RENEW=0 / AUTO_RENEW=1 / 缺省=0
//   - alias → 固定 ""
//   - goodsDetail → buildResourceGoodsDetail(bundleDef, regionTriple)；bundleDef 由调用方提前 batch 反查
//
// def 允许 nil（bundle 在 trade_bundle_definition 中已下架但 pass 仍持有）；nil 时 goodsDetail 返空 map。
//
// regionTriple 是站点 region 三元组，由调用方从 install.Deps.SiteKind 经 region.Resolve 解析后注入。
func passToResourceMap(
	pass *ctlclient.PassDetail,
	uinStr string,
	appID int64,
	def *store.BundleDefinition,
	regionTriple region.LighthouseRegion,
) map[string]interface{} {
	if pass == nil {
		return map[string]interface{}{}
	}

	// status：isolated 优先；销毁直接物理删行不会出现在结果集（Q9 拍板 2026-05-11）。
	status := 1
	if pass.IsolatedTime != nil {
		status = 2
	}

	// 时间字段格式化（jifei 协议层字面值为北京时间 UTC+8，BUG-33/34 同源；
	// 与 checkrenew/placeorder 三处同源依赖 jifei.CurDeadlineLocation，
	// 不可独立重复定义 time.FixedZone。）
	formatTime := func(t time.Time) string {
		if t.IsZero() {
			return timeNullPlaceholder
		}
		return t.In(jifei.CurDeadlineLocation).Format(timeFormat)
	}
	formatTimePtr := func(t *time.Time) string {
		if t == nil || t.IsZero() {
			return timeNullPlaceholder
		}
		return t.In(jifei.CurDeadlineLocation).Format(timeFormat)
	}

	return map[string]interface{}{
		"uin":               uinStr,
		"appId":             appID,
		"resourceId":        pass.PassID,
		"region":            regionTriple.RegionID,
		"zoneId":            regionTriple.ZoneID,
		"status":            status,
		"isolatedTimestamp": formatTimePtr(pass.IsolatedTime),
		"createTime":        formatTime(pass.CreatedTime),
		"expireTime":        formatTime(pass.ExpiredTime),
		"payMode":           fixedPayMode,
		"instanceType":      fixedInstanceType,
		"allowReturn":       fixedAllowReturn,
		"renewFlag":         renewFlagToInt(pass.RenewFlag),
		"alias":             fixedAlias,
		"goodsDetail":       buildResourceGoodsDetail(def, regionTriple),
	}
}

// renewFlagToInt 把 ctl pass.renew_flag 字符串映射为 jifei.renewFlag 整数（设计稿 §3.3）。
//
// 取值表：
//   - "MANUAL_RENEW" → 0
//   - "AUTO_RENEW"   → 1
//   - 其他（含空字符串 / 非法值）→ 0（设计稿明示"缺省 0"）
func renewFlagToInt(renewFlag string) int {
	switch renewFlag {
	case "AUTO_RENEW":
		return renewFlagAuto
	case "MANUAL_RENEW":
		return renewFlagManual
	default:
		return renewFlagManual
	}
}
