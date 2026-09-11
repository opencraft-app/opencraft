package jifei

import "sort"

// 同 SP 变配的 goodsDetail 构造（含 oldConfig / newConfig）。
// 需求：TAPD 1010132091137784162 §4.1（Trade 负责构造询价/下单所需的 oldConfig/newConfig）
//
// jifei 用这两个集合算差价：oldConfig 是用户当前持有的计费资源集合，newConfig 是目标集合；
// 剩余时长由 goodsDetail.curDeadline 决定，trade 不参与任何金额计算。
//
// 为什么放在 internal/jifei 而不是 inquiry / placeorder 各写一份：询价和下单必须构造出
// **完全一致**的 goodsDetail，否则用户在确认页看到的差价和实际扣款不一致。这是整条变配链路
// 唯一一处"两个包必须逐字节相同"的约束，用一个函数是保证它最省事的办法。
//
// 入参用裸字段而不是 *store.BundleDefinition：本包是协议层，不该反向依赖持久化层。

// ModifyGoodsDetailInput 是变配 goodsDetail 的构造入参。
//
// 顶层字段（ProductCode / SubProductCode / Pid / SourceSVList）来自**源**套餐，描述
// "现在是什么"；TargetSVList 进 newConfig，描述"要变成什么"。同 SP 变配下
// productCode / subProductCode / pid 源和目标一致，取源侧没有额外含义。
//
// 不含 timeSpan / timeUnit：变配不改到期时间，时长语义完全由 CurDeadline 承载。
type ModifyGoodsDetailInput struct {
	ProductCode    string
	SubProductCode string
	Pid            int64
	// ResourceID 是变配目标 pass_id（jifei goodsDetail.resourceId）。
	ResourceID string
	// CurDeadline 是 pass 当前到期时间的 jifei 字面值（CurDeadlineLayout）。
	CurDeadline string
	// SourceBundleID / TargetBundleID 落进 goodsDetail 的 bundleId / newBundleId。
	//
	// ⚠️ 只是本地留痕，checkModify 不能依赖它们（2026-09-02 联调实测推翻了原设计）：
	// 计费只回传自己协议字段表里认识的键，trade 自塞的 bundleId / newBundleId 在
	// checkModify 回调报文里被整个过滤掉。曾按"必填"校验，导致每笔变配下单固定
	// 600801 → 计费包成 700002 → 下单 502。
	//
	// 原设计类比新购链路的 goodsDetail.externalUserId（v1.7.28 BUG-24 验证过会回传），
	// 但那个字段在计费协议字段表内，自定义键没有同等保证。
	//
	// 保留出向不删：getPrice / createDeal 实测容忍这两个键（询价 200），而
	// trade_order.goods_detail 的报文快照留着源/目标 ID 对排障和对账有价值。
	// checkModify 现改为从协议一等字段 oldConfig / newConfig 的 SV 集合反查套餐，
	// 详见 internal/logic/checkmodify/resolve.go。
	SourceBundleID string
	TargetBundleID string
	SourceSVList   map[string]int64
	TargetSVList   map[string]int64
	ProductInfo    []map[string]interface{}
	// IntlPointOfSale 为 true 时注入国际站 billingParam.pointOfSale。
	IntlPointOfSale bool
}

// BuildModifyGoodsDetail 拼装变配的 jifei goodsDetail。
func BuildModifyGoodsDetail(in ModifyGoodsDetailInput) map[string]interface{} {
	goodsDetail := map[string]interface{}{
		"productCode":    in.ProductCode,
		"subProductCode": in.SubProductCode,
		"pid":            in.Pid,
		"goodsNum":       ModifyGoodsNum,
		"resourceId":     in.ResourceID,
		"curDeadline":    in.CurDeadline,
		"bundleId":       in.SourceBundleID,
		"newBundleId":    in.TargetBundleID,
		"oldConfig":      buildModifyConfig(in.ProductCode, in.SubProductCode, in.Pid, in.SourceSVList),
		"newConfig":      buildModifyConfig(in.ProductCode, in.SubProductCode, in.Pid, in.TargetSVList),
	}
	// 顶层同样展平源套餐的 sv_*：与新购/续费的 goodsDetail 形状保持一致，
	// jifei 侧对"当前配置"有两处可读（顶层 + oldConfig）且必然同值。
	for key, value := range in.SourceSVList {
		goodsDetail[key] = value
	}
	if len(in.ProductInfo) > 0 {
		goodsDetail["productInfo"] = in.ProductInfo
	}
	if in.IntlPointOfSale {
		AddIntlPointOfSale(goodsDetail)
	}
	return goodsDetail
}

// ModifyGoodsNum 是变配的 goodsNum，协议固定 1（§5.3）。
// 变配改的是一份已有资源的规格，"买几份"没有语义。
const ModifyGoodsNum = 1

// SortedSVKeys 返回排序后的 sv_* 键。
//
// map 迭代顺序随机，直接进日志或错误串会让同一笔变配在不同请求里输出不同顺序，
// 排障时无法比对，单测也无法稳定断言。
func SortedSVKeys(svList map[string]int64) []string {
	keys := make([]string, 0, len(svList))
	for k := range svList {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// copySVList 返回 sv_* 集合的副本。
//
// 空集合返回非 nil 空 map：jifei 协议要求 oldConfig / newConfig 是对象，
// nil map 会被 encoding/json 序列化成 null。
func copySVList(svList map[string]int64) map[string]int64 {
	out := make(map[string]int64, len(svList))
	for k, v := range svList {
		out[k] = v
	}
	return out
}

// buildModifyConfig 拼装 goodsDetail.oldConfig / newConfig。
//
// 变配询价协议（iwiki 746616075「变配询价请求参数」）把 oldConfig / newConfig 定义成两份
// **自描述的完整配置**：除 sv_* 用量外，各自都必须带 pid / productCode / subProductCode。
// 这不是冗余——计费按 categoryId 判定报文结构，变配场景直接读 oldConfig.pid / newConfig.pid
// 来定位两侧价格模型，**不会回退到 goodsDetail 顶层的 pid**。
//
// 少了这三个字段的直接后果（已实测）：计费返回
// `returnCode=371008 / "get price error:pid not found"`。同一份报文换成新购 categoryId 反而
// 只抱怨缺 timeSpan，正是因为新购读顶层 pid、变配读内层 pid，两个场景取值位置不同。
//
// 同 SP 变配下源和目标共用同一套 productCode / subProductCode / pid，所以两次调用传同值；
// 未来做跨 SP 变配时，这里换成分别传源侧、目标侧的三元组即可，调用方无须改动其他逻辑。
func buildModifyConfig(productCode, subProductCode string, pid int64, svList map[string]int64) map[string]interface{} {
	config := map[string]interface{}{
		"pid":            pid,
		"productCode":    productCode,
		"subProductCode": subProductCode,
	}
	for key, value := range copySVList(svList) {
		config[key] = value
	}
	return config
}
