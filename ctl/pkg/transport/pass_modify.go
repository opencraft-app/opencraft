package transport

// 同 SP 升配的用户侧 transport DTO。需求：TAPD 1010132091137784162 §5.1
//
// 入口：
//
//	GET  /v1/passes/{pass_id}/modify/bundles      可变配套餐 + 实时差价
//	POST /v1/passes/{pass_id}/modify/order        建单，返订单号
//	POST /v1/passes/{pass_id}/modify/order-url    建单 + 拉支付页 URL
//	POST /v1/passes/{pass_id}/modify/order-and-pay 建单 + 代扣（仅联调 / e2e）
//
// 鉴权 X-User-Id，与续费三兄弟同范式。order / order-url 的分工沿用新购链路：
// 前者只落单，后者一次拿到可直接跳转的支付页。

// ModifyBundleSetResult 是 GET /modify/bundles 的响应。
//
// 查询接口刻意**不接收** target_bundle_id：合法目标由服务端按当前 pass 的 bundle
// 从升配策略推导，前端只能从响应里取 target_bundle_id 回传，不得拼接或硬编码。
// 否则前端会把"当前有哪些升配路径"这条业务规则复制一份到自己代码里，运营调整时两边打架。
type ModifyBundleSetResult struct {
	SourceBundleID string `json:"source_bundle_id"`
	// ModifyBundleSet 无可升配目标时是空数组而不是 null：前端可以直接 length 判断，
	// 不必先做 null 检查。
	ModifyBundleSet []ModifyBundleOption `json:"modify_bundle_set"`
}

// ModifyBundleOption 单个可升配目标：套餐规格 + 实时变配差价。
type ModifyBundleOption struct {
	TargetBundleID string             `json:"target_bundle_id"`
	Bundle         ModifyBundleDetail `json:"bundle"`
	// ModifyPrice 复用与新购/续费完全一致的六字段价格 DTO：前端价格展示组件是同一个，
	// 换一套字段名只会逼前端多写一份映射。国际站在这里返 USD 并带 tax_price。
	ModifyPrice BundlePrice `json:"modify_price"`
}

// ModifyBundleDetail 目标套餐的展示规格。
//
// 精简到确认页真正要展示的五项 + ID：升配确认页要回答的只有"我花这笔钱换到什么"。
// features / tagline / promotion 属于售卖页范畴，不在这条链路里下发。
type ModifyBundleDetail struct {
	BundleID       string `json:"bundle_id"`
	BundleName     string `json:"bundle_name"`
	CPU            int    `json:"cpu"`
	Memory         int    `json:"memory"`           // 单位 GB
	SystemDiskSize int    `json:"system_disk_size"` // 单位 GB
	Credit         int64  `json:"credit"`           // 目标套餐的完整积分额度
}

// ModifyPassOrderRequest 是 /modify/order 与 /modify/order-url 的共用入参。
//
// 只带 target_bundle_id：source bundle、curDeadline、uin/appId 全部由 ctl 从 pass 实体
// 反查，不接受前端透传——它们是计费账单的一部分，前端传错等于扣错钱。
// pass_id 走 path param，与续费同范式。
type ModifyPassOrderRequest struct {
	TargetBundleID string `json:"target_bundle_id"`
}

// ModifyPassOrderUrlResult 两步式下单的响应：订单号 + 支付页 URL。
type ModifyPassOrderUrlResult struct {
	DealName string `json:"deal_name"`
	PayURL   string `json:"pay_url"`
}

// ModifyPassOrderResult 是 /modify/order 与 /modify/order-and-pay 的共用响应。
//
// 两者都不返 PayURL：前者由前端随后调 order-url，后者走 jifei generateDealsAndPay
// 一次完成下单 + 支付 + 触发 modifyResource 回调，本就没有支付页概念。
// BigOrderID 只用于反查计费控制台排障。
type ModifyPassOrderResult struct {
	DealName   string `json:"deal_name"`
	BigOrderID string `json:"big_order_id"`
}
