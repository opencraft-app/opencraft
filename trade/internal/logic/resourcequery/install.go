// Package resourcequery 实现 jifei 资源反查三件套（getAllAppIds / getUserResources / queryResource）
// 的 trade 侧 handler。
//
// 设计稿引用（trade-resource-query-design.md）：
//   - §0 一句话总览：trade 仅做 jifei 协议适配 + 字段拼装层，真值在 ctl pass 表
//   - §3.1 模块定位：本包独立挂载到 dispatcher，与 checkcreate / createresource 并列
//   - §3.2 数据反查链路：trade → ctl 内部 RPC（ctlclient.ListPassAppIDs / ListPassesByAppID /
//     ListPassesByResourceIDs）
//   - §3.3 字段映射：pass → jifei resources[i]
//   - §11 Q41 修订（2026-05-11）：region/zone 完全收敛到 trade 内部固定常量（11C 抽取
//     2026-05-12 起统一引用 trade/internal/region 包）
//
// 三层超时预算（设计稿 §3.x）：
//   - jifei 协议 3s → trade handler 2.5s（HandlerTimeout）→ ctlclient 1.5s（ctx 收紧）
package resourcequery

import (
	"context"
	"time"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// HandlerTimeout 是反查 handler 的总超时（设计稿 §3.x 三层预算的中层）。
//
// 实际链路：dispatch → handler → ctlclient（ctx 进一步收紧到 1.5s）+ store SQL（本机毫秒级），
// 这里再加一层 ctx WithTimeout 兜底防御 ctlclient 客户端配置失误（如未设 Timeout）。
const HandlerTimeout = 2500 * time.Millisecond

// CTLCallTimeout 是 trade → ctl 的子超时（三层预算最内层）。
//
// 设计稿三层预算：jifei 3s → trade handler 2.5s → trade→ctl 1.5s；ctlclient 默认 4s 内置超时
// 在反查链路偏宽，本包通过 ctx WithTimeout 强制收紧到 1.5s。
const CTLCallTimeout = 1500 * time.Millisecond

// 资源反查响应固定常量（设计稿 §3.3 + §3.5）。
//
// 注：region/zone/regionName 已收敛到 trade/internal/region 包（11C 抽取 2026-05-12），
// 本块只保留 jifei 协议层固定字段（payMode / instanceType / allowReturn / alias / 时间格式 /
// renewFlag / payMode 唯一支持值 / pageSize 上限 / resourceIds 上限）。
const (
	// fixedPayMode 是 trade 全预付费下固定回填的 payMode（设计稿 §3.3）。
	// trade 全部 pass 都是预付费，jifei resources[i].payMode 固定 1。
	fixedPayMode = 1

	// fixedInstanceType 是 trade 资源固定回填的 instanceType（设计稿 §3.3 / Q4 修订 2026-05-11）。
	// 0 = 普通；trade 自管生命周期，jifei 仅作账单 / 退款入口，无需 jifei 侧加白名单。
	fixedInstanceType = 0

	// fixedAllowReturn 是 trade 资源固定回填的 allowReturn（设计稿 §3.3）。
	// 1 = 允许退费；trade 期望支持退费。
	fixedAllowReturn = 1

	// fixedAlias 是 trade 资源固定回填的 alias（设计稿 §3.3 / Q11 修订 2026-05-11）。
	// 空字符串；不引入 bundle.name 反查链路。
	fixedAlias = ""

	// timeFormat 是 jifei 协议要求的时间格式（设计稿 §3.3 / PDF §3.2 字段表）。
	// 北京时间 UTC+8，yyyy-MM-dd HH:mm:ss 格式。
	timeFormat = "2006-01-02 15:04:05"

	// timeNullPlaceholder 是时间字段为 NULL 时回填的占位字符串（设计稿 §3.3）。
	// PDF 不允许 isolatedTimestamp 为 null / 空字符串，必须给一个语法合法的占位值。
	timeNullPlaceholder = "0000-00-00 00:00:00"

	// renewFlagManual 是 jifei.renewFlag 的"手动续费"取值（设计稿 §3.3）。
	// trade 内部 pass.renew_flag = "MANUAL_RENEW" → jifei renewFlag = 0。
	renewFlagManual = 0

	// renewFlagAuto 是 jifei.renewFlag 的"自动续费"取值（设计稿 §3.3）。
	// trade 内部 pass.renew_flag = "AUTO_RENEW" → jifei renewFlag = 1。
	renewFlagAuto = 1

	// payModeOnlyPrepay 是 trade 唯一支持的 payMode（设计稿 §3.3 / PDF §1.1）。
	// 入参 payMode != 1 时直接返空数组（PDF 明示"payMode 不合法返回空响应而不报错"）。
	payModeOnlyPrepay = 1

	// pageSizeAppIDsMax 是 getAllAppIds 接口的 pageSize 上限（PDF §1.1 / 设计稿 §2.2）。
	// 至少支持 20000，trade handler 在前置层做兜底校验，超限返 400。
	pageSizeAppIDsMax = 20000

	// pageSizeUserResourcesDefault 是 getUserResources 接口的 pageSize 默认值（PDF §1.1 / 设计稿 §2.3）。
	pageSizeUserResourcesDefault = 1000

	// resourceIDsMax 是 queryResource 接口 resourceIds 列表上限（PDF §2.2 / 设计稿 §2.4）。
	// PDF 要求"至少需要支持 100 个资源"；trade 与 ctlclient 保持一致按 100 兜底。
	resourceIDsMax = 100
)

// 业务层 returnCode（与 checkcreate / createresource 同段：6xxxxx 自定义业务错码）。
//
// 资源反查链路的错误分类相对简单（trade 不写 trade_flow，纯读 ctl + 字段拼装）：
//   - 入参 JSON 解析失败 / 必填字段缺失 → ReturnCodeInvalidPara
//   - ctl 调用失败 / 上游不可用 → ReturnCodeUpstreamUnavailable
//   - PDF 协议层 payMode 不合法 → 不返错码，按 PDF §1.1 返空数组（returnCode = 0）
const (
	// ReturnCodeInvalidPara = jifei 入参解析失败 / 必填字段缺失。
	ReturnCodeInvalidPara = 600201

	// ReturnCodeUpstreamUnavailable = ctl 反查失败（5xx / 网络错 / 超时）。
	// 区分于业务级"找不到"以便排障；jifei 收到非零 returnCode 行为是重试。
	ReturnCodeUpstreamUnavailable = 600202
)

// Deps 是反查 handler 三件套的共享依赖集合，由调用方在 server 装配阶段注入。
//
// v1.7.x 国际站接入（A6.1）新增：
//   - SiteKind：trade 内部站点语义字面量（"cn" / "intl"），由 main.go 从 cfg.SiteKind 透传；
//     空 / 非法值由 region.Resolve 兜底为 cn。在 handler 闭包构造期解析为三元组后传入
//     mapper 的 passToResourceMap / buildResourceGoodsDetail，在反查响应的 region / zoneId /
//     productInfo["地域"].value 三处一次性写入（cn=1/100001/广州 / intl=9/900001/Singapore）。
type Deps struct {
	// CTLClient 反向调用 ctl 内部反查接口（11A 已落地的三个 method）。
	CTLClient ctlclient.Client

	// BundleStore 提供 trade_bundle_definition 表的反查（subProductCode → bundle_ids）。
	// 三个接口中只有 getAllAppIds / getUserResources 用得上（subProductCode 非空时）；
	// queryResource 不用 subProductCode 过滤（PDF §2.2 明示）。
	BundleStore store.BundleDefinitionStore

	// Builder 构造 jifei framework 双层出参（与 checkcreate / createresource 共用）。
	Builder *jifei.FrameworkBuilder

	// SiteKind（v1.7.x A6.1 新增）：当前部署站点语义字面量。只可取 "cn" / "intl"；
	// 其他值（含空字符串）由 region.Resolve 兜底为 cn。
	SiteKind string

	// RegionOverride（北京 2 预发布接入 2026-06-12 新增）：腾讯云 region 字面量 override。
	// 取值例："" / "ap-guangzhou" / "ap-beijing" / "ap-singapore"；非空且命中 region.regionTable
	// 时优先于 SiteKind 兜底。贯穿到 mapper.passToResourceMap / buildResourceGoodsDetail
	// 出参中的 region / zoneId / productInfo[地域].value 三处。
	RegionOverride string
}

// Install 把反查三件套真 handler 注册到 dispatcher。
//
// 调用方约定：在 server 装配阶段调一次本函数，注册顺序与 jifei.InterfaceName* 常量一一对应。
// dispatcher 同名 key 重复注册会 panic，配置错就尽早暴露。
func Install(d *jifei.Dispatcher, deps Deps) {
	if deps.CTLClient == nil {
		panic("resourcequery.Install: Deps.CTLClient must be non-nil")
	}
	if deps.BundleStore == nil {
		panic("resourcequery.Install: Deps.BundleStore must be non-nil")
	}
	if deps.Builder == nil {
		panic("resourcequery.Install: Deps.Builder must be non-nil")
	}
	d.Register(jifei.InterfaceNameGetAllAppIDs, makeGetAllAppIDsHandler(deps))
	d.Register(jifei.InterfaceNameGetUserResources, makeGetUserResourcesHandler(deps))
	d.Register(jifei.InterfaceNameQueryResource, makeQueryResourceHandler(deps))
}

// withCTLTimeout 把 trade handler 的 ctx 进一步收紧到 CTLCallTimeout（1.5s），
// 用于 trade → ctl 的反向调用（设计稿三层超时预算最内层）。
func withCTLTimeout(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, CTLCallTimeout)
}

// resolveBundleIDs 把 jifei 入参 subProductCode 解析为 bundle_ids（设计稿 §3.2 / Q2 拍板 2026-05-11）。
//
// 语义约定：
//   - subProductCode 为空（缺省）→ 返 (nil, nil)；调用方应**不传** ctl 的 bundle_ids 参数，
//     ctl SQL 不加 bundle_id 过滤项（与 lightpower 历史行为一致）
//   - subProductCode 非空 → 调 BundleStore.ListBundleDefsBySubProductCode 取该 sub 下所有 bundle.bundle_id
//   - 解析返空列表 → 视为合法（运营该 sub 暂未配 bundle，jifei 应返空数组），
//     返 ([]string{}, nil)；调用方判 len(bundleIDs) == 0 直接走"返空响应"分支
//
// 错误处理：BundleStore 返非 nil err（DB 异常）→ 透传给调用方包装为 ReturnCodeUpstreamUnavailable。
func resolveBundleIDs(
	ctx context.Context,
	bundleStore store.BundleDefinitionStore,
	productCode, subProductCode string,
) ([]string, error) {
	if subProductCode == "" {
		return nil, nil
	}
	defs, err := bundleStore.ListBundleDefsBySubProductCode(ctx, productCode, subProductCode)
	if err != nil {
		return nil, err
	}
	bundleIDs := make([]string, 0, len(defs))
	for _, def := range defs {
		if def != nil && def.BundleID != "" {
			bundleIDs = append(bundleIDs, def.BundleID)
		}
	}
	return bundleIDs, nil
}
