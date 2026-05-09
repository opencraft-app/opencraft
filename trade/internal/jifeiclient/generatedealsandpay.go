package jifeiclient

import (
	"context"
)

// GenerateDealsAndPayRequest 是 jifei CGW `qcloud.Deal.generateDealsAndPay` 一体化下单+支付接口入参
// （para 内层），迭代 8B-1.5 引入。
//
// **协议关系**（PDF §1 "协议规范：接口协议与下单接口 generateDeals 保持一致"）：
//   - 字段集与 GenerateDealsRequest 几乎一致：OwnerUin / Uin / GoodsInfos[]
//   - 多两个支付侧字段：AppID（PDF §4.1 "所有者云平应用ID"，必填）与 AutoVoucher（自动选用代金券）
//   - 复用 GoodsInfo 类型 — jifei 协议规范在两处共享相同结构
//
// **设计自决**：
//   - PascalCase 与 GenerateDealsRequest 一致（与 getPrice 的 camelCase 不一致由本 client 适配层吸收）
//   - 不持有 ClientToken / VoucherIDs / AgentPay / Payer / DistributionUin / CpsUin 等"代付/活动"
//     扩展字段（与 GenerateDealsRequest 一致的"最小必需字段集"原则；如生产链路确需再扩）
//   - AutoVoucher 用 *bool 表示三态：nil = 不传字段（jifei 默认 0=否）；显式 true = 传 1；
//     显式 false = 传 0。Lightclaw 测试链路下 PlaceOrderAndPay 总是传 true，但 client 不固化策略。
//
// **使用建议**（PDF §1 "调用建议"）：
//   - 业务侧请求超时 ≥ 5s（这条接口同步等待 jifei 内部"创建+扣费+回调"全链路）
//   - 降配场景必须用本接口，不能拆成"先 generateDeals 后支付"两步
type GenerateDealsAndPayRequest struct {
	OwnerUin    string      `json:"OwnerUin"`
	Uin         string      `json:"Uin"`
	AppID       int64       `json:"AppId,omitempty"`
	AutoVoucher *int        `json:"AutoVoucher,omitempty"`
	GoodsInfos  []GoodsInfo `json:"GoodsInfos"`
}

// GenerateDealsAndPayResponse 是 CGW returnValue 反序列化目标。
//
// PDF §5.1 / §5.2 给出的字段集（PascalCase 适配）：
//
//	{
//	  DealNames:           ["<子订单 1>", ...],
//	  ResourceIDs:         { "<子订单>": ["<资源 ID 1>", ...] },  // 同步发货时返回；异步/失败 / 代付订单为空
//	  DealIDs:             ["<deal id 1>", ...],
//	  BigDealIDs:          ["<大订单号>", ...],
//	  DealDeliverResults:  { "<子订单>": { "state": "0|1|2|3|4", ... } },
//	}
//
// **关键观察 & Lightclaw 用法**：
//
//  1. ResourceIDs：PDF §5.1 提示 "异步发货 / 业务发货超时 / 未成功" 时 ResourceIDs 为空；Lightclaw
//     下单 pass 类商品的发货回调（ctl.createResource）默认是同步走通的，因此期望同步拿到 resourceId。
//     测试链路对 ResourceIDs 留空也要兼容（PDF 第 15 页给出 "resourceIds: []" 异步发货返回示例）。
//  2. DealDeliverResults["<deal>"].state 取值：0 发货成功 / 1 发货中 / 2 重试 queryFlow / 3 发货失败 /
//     4 部分发货失败。Lightclaw 联调链路把 ≠ 0 的状态都视为 "异步发货中" — 由 jifei 后续回调
//     trade.createResource 完成最终状态推进，trade 落库时只更新 trade_order.status 到
//     'paid_pending_provision'。
//  3. 沿用 GenerateDeals 的 BigDealID 字段在 Lightclaw 单笔下单（GoodsNum=1）下数组长度 = 1，
//     trade_order.big_order_id 写入 BigDealIDs[0]；DealNames[0] 同理写入 trade_order.deal_name。
//  4. PriceInfos 不在响应字段集里（与 generateDeals 的响应不同）— PDF §5.1 没列出，client 不持有。
type GenerateDealsAndPayResponse struct {
	DealNames          []string                          `json:"DealNames"`
	ResourceIDs        map[string][]string               `json:"ResourceIds,omitempty"`
	DealIDs            []string                          `json:"DealIds,omitempty"`
	BigDealIDs         []string                          `json:"BigDealIds"`
	DealDeliverResults map[string]map[string]interface{} `json:"DealDeliverResults,omitempty"`
}

// GenerateDealsAndPay 调用 jifei CGW `qcloud.Deal.generateDealsAndPay` 一体化下单+支付接口。
//
// 错误语义与 GenerateDeals / GetPrice 一致：
//   - nil 入参 / 必填字段缺失 → client-side errInvalidArg（不出请求）
//   - 业务失败（returnCode != 0）→ *CGWError；调用方可用 errors.As 提取并按 PDF §6 错误码表分类处理
//     （100207/331106 余额不足、100151 资源锁、100199 用户拦截、800200 未实名 ...）
//   - HTTP 层 / envelope 解析失败 → ErrCGWHTTPNon200 / ErrCGWInvalidEnvelope
func (c *client) GenerateDealsAndPay(ctx context.Context, req *GenerateDealsAndPayRequest) (*GenerateDealsAndPayResponse, error) {
	if req == nil {
		return nil, errInvalidArg("GenerateDealsAndPay: nil request")
	}
	if req.OwnerUin == "" {
		return nil, errInvalidArg("GenerateDealsAndPay: empty OwnerUin")
	}
	if req.Uin == "" {
		return nil, errInvalidArg("GenerateDealsAndPay: empty Uin")
	}
	if len(req.GoodsInfos) == 0 {
		return nil, errInvalidArg("GenerateDealsAndPay: empty GoodsInfos")
	}
	out := &GenerateDealsAndPayResponse{}
	if err := c.do(ctx, InterfaceNameGenerateDealsAndPay, ComponentNameDeal, req, out); err != nil {
		return nil, err
	}
	return out, nil
}
