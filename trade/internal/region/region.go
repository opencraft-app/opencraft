// Package region 集中声明 trade 服务内部硬编码的 region / zone / 地域名常量
// （Q41 修订 2026-05-11 起的唯一 source-of-truth；v1.7.x 起按 site 维度暴露两组常量
// 加 Resolve helper）。
//
// 历史：在 11C 抽取之前，这些常量分散在 4 处声明 — trade/internal/jifei/adapter.go
// (`fixedRegionID` / `fixedZoneID`)、trade/internal/logic/inquiry/service.go、
// trade/internal/logic/placeorder/service.go、trade/internal/logic/resourcequery/install.go
// 各自独立常量声明且全部同值，Q41 修订时必须 4 处同步改否则数据 inconsistency。
// 11C 统一收敛到本包后，4 处都 import 引用，编译期保障一致性。
//
// v1.7.x 国际站接入：合规要求国际站资源必须落在海外地域（trade-international-site-design §3.1
// A6），本包从单一国内常量升级为按 site 维度暴露两组常量（国内 = 广州 / 国际 = 新加坡）+
// `LighthouseRegion` 三元组 struct + `Resolve(siteKind)` helper。调用方从 `cfg.SiteKind`
// 沿调用链注入，**不在本包做 site 决策**（避免 region 包被业务语义污染）。
//
// v1.7.x 北京 2 预发布接入（2026-06-12）：新增 region override 路径，Resolve 第二参数
// `regionOverride`（腾讯云 region 字面量，例：ap-shanghai / ap-beijing / ap-guangzhou / ap-singapore）
// 非空且命中 `regionTable` 时优先于 siteKind 兜底，用于"国内站身份 + 北京 region 字段"
// 这种 site/region 解耦的部署场景。命名表唯一来源在本文件 `regionTable`，调用方零感知。
//
// 设计稿引用：
//   - Q41 修订 2026-05-11：region/zone 完全收敛到 trade 内部固定常量；
//     ctl / 前端 / 反查响应都不再透传 / 不再感知 region 字段，统一回填本站点常量。
//   - trade-purchase-flow-design §3.5 / §3.5.5
//   - trade-resource-query-design §2.5 / §3.3 / §11 Q41
//   - trade-international-site-design v1.1 §3.1 A6 / §2.4 B-DEPLOY-3
package region

import "strings"

// LighthouseRegionID 是国内站固定回填的腾讯云 region ID（1 = ap-guangzhou / 广州）。
//
// trade 不持有"本地域 jifei region id"概念，jifei 入参 region 仅作协议必填字段接收，
// 不做匹配判定 / 不裁剪；jifei 出向请求 / 反查响应在国内站统一固定回填 1。
const LighthouseRegionID = 1

// LighthouseZoneID 是国内站固定回填的腾讯云 zone ID（100001 = ap-guangzhou-1 / 广州一区）。
//
// trade 不区分 zone，国内站固定填 100001。
const LighthouseZoneID = 100001

// LighthouseRegionName 是国内站固定回填的地域中文名（与 LighthouseRegionID 对应）。
//
// 用途：trade-resource-query-design §2.5 — jifei 资源反查响应的 goodsDetail.productInfo 至少含
// `[{name:"地域",value:"广州"}]`；本常量是该字段的"value"来源（国内站）。
const LighthouseRegionName = "广州"

// LighthouseIntlRegionID 是国际站固定回填的腾讯云 region ID（9 = ap-singapore / 新加坡）。
//
// v1.7.x 国际站接入新增；合规红线：国际站 jifei envelope.resInfo.regionId 必须为海外地域 ID，
// 不允许混用国内 RegionID=1。具体 region 数值由腾讯云 region 枚举决定（9 = ap-singapore）。
const LighthouseIntlRegionID = 9

// LighthouseIntlZoneID 是国际站固定回填的腾讯云 zone ID（900001 = ap-singapore-1 / 新加坡一区）。
//
// v1.7.x 国际站接入新增；与 LighthouseIntlRegionID 配对使用。
const LighthouseIntlZoneID = 900001

// LighthouseIntlRegionName 是国际站固定回填的地域英文名（与 LighthouseIntlRegionID 对应）。
//
// 用途：jifei 资源反查响应的 goodsDetail.productInfo 在国际站填 `[{name:"地域",value:"Singapore"}]`；
// 本常量是该字段的"value"来源（国际站）。用户拍板 2026-06-02：国际站使用英文名
// "Singapore"（非中文 "新加坡"），与国际站 UI 语言一致。
const LighthouseIntlRegionName = "Singapore"

// LighthouseRegion 是 region / zone / regionName 三元组，由 Resolve 按 site 返回。
//
// 该类型仅作为 Resolve 出参与 trade 出向 jifei 链路（envelope.resInfo / 资源反查响应）的
// region 字段装配载体，不持久化到 DB（DB 列仍是分离的 region_id / zone_id 列）。
type LighthouseRegion struct {
	RegionID   int
	ZoneID     int
	RegionName string
}

// regionTable 是 trade 支持的腾讯云 region 字面量 → 三元组映射表。
//
// key 取腾讯云 region API 字面量（kebab-case 全小写），value 是 jifei 协议出向 / 反查
// 字段三元组。新增 region 时只需在此处加一行，调用方无感。
//
// 注：regionName 在国内 region 用中文（与 jifei 协议反查响应 productInfo[地域].value 历史
// 字面量一致），国际 region 用英文（用户 2026-06-02 拍板国际站统一英文化）。
var regionTable = map[string]LighthouseRegion{
	"ap-guangzhou": {RegionID: LighthouseRegionID, ZoneID: LighthouseZoneID, RegionName: LighthouseRegionName},
	"ap-beijing":   {RegionID: 8, ZoneID: 800001, RegionName: "北京"},
	"ap-shanghai":  {RegionID: 4, ZoneID: 400001, RegionName: "上海"},
	"ap-singapore": {RegionID: LighthouseIntlRegionID, ZoneID: LighthouseIntlZoneID, RegionName: LighthouseIntlRegionName},
}

// LookupByRegion 按腾讯云 region 字面量返回三元组；未注册返回 (zero, false)。
//
// 字面量大小写 / 前后空白由本函数 trim+lower 兜底，调用方无需再做规范化。
//
// 用途：config.Load 在启动期校验 LIGHTVELA_TRADE_REGION env，以及 Resolve 内部在
// regionOverride 非空时查表。
func LookupByRegion(region string) (LighthouseRegion, bool) {
	v, ok := regionTable[strings.ToLower(strings.TrimSpace(region))]
	return v, ok
}

// Resolve 按站点 + 可选 region override 返回 region / zone / regionName 三元组。
//
// 取值优先级（v1.7.x 北京 2 预发布接入新增 override 分支）：
//  1. regionOverride 非空且命中 regionTable → 返回 override 命中的三元组（site/region 解耦
//     的部署场景，例如"国内站身份 + 北京 region 字段"，由 LIGHTVELA_TRADE_REGION env 注入）。
//  2. siteKind == "intl" → 新加坡（9 / 900001 / "Singapore"）
//  3. 其他（含 "cn" / 空字符串 / 非法值）→ 广州（1 / 100001 / "广州"）
//
// 该函数仅做"site + region → 三元组"映射，**不做** site 字面量规范化（兼容性兜底已由
// `config.normalizeSiteKind` 在启动期完成）；regionOverride 的合法性已由 `config.Load`
// 在启动期通过 `LookupByRegion` 校验通过 fail-fast，运行时未命中走 siteKind 兜底（防御性
// 处理，理论不会发生）。
//
// 该函数仅用于 trade 出向 jifei 的 resInfo 装配 / 反向回调入向 region 校验，jifei 后台
// 仍按 uin 注册判定站点身份，region 字段仅作资源合规标识。
func Resolve(siteKind, regionOverride string) LighthouseRegion {
	if regionOverride != "" {
		if v, ok := LookupByRegion(regionOverride); ok {
			return v
		}
		// 防御性兜底：理论上 config.Load 已经 fail-fast；走到这里说明上游绕过了校验，
		// 仍按 siteKind 兜底，避免运行时返回零值导致 jifei 出向 regionId=0 被拒。
	}
	if siteKind == "intl" {
		return regionTable["ap-singapore"]
	}
	return regionTable["ap-guangzhou"]
}
