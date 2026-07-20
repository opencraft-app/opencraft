package jifeiclient

import (
	"context"
)

// GenerateDealsAndPayRequest 是 jifei CGW `qcloud.Deal.generateDealsAndPay` 一体化下单+支付接口入参
// （para 内层），迭代 8B-1.5 引入。
//
// **协议字段名规范（v1.7.19 B14 协议校准，PDF §4.1 / §4.2 实测）**：
//   - 字段全部 **camelCase**（PDF §4.1 字段表 + §4.2 示例严格一致）
//   - 数组名 **`goods`**（PDF §4.1 line "para.goods Array" + §4.2 示例 line 8 `"goods": [...]`）—
//     不是 `goodsInfos` / `goodsList`
//   - PDF §5.2 示例确认响应 envelope.data 也 camelCase（dealNames / resourceIds / dealIds /
//     bigDealIds / dealDeliverResults）
//
// 历史误判记录：v1.7.5 ~ v1.7.18 期间 trade jifeiclient 字段全部 PascalCase（json tag），
// 联调真实 nc 直发 jifei 拿到 returnCode=100001 `param error[goods can not empty]` 后
// 翻 PDF 才确认协议字段是 camelCase；PDF 第 8 页示例 line 8 `"goods": [...]` 决定性证据。
//
// **Lightclaw 字段集约束**（与 GenerateDealsRequest 一致 + 支付侧 2 字段）：
//   - 协议必需：ownerUin / uin / appId / goods[]
//   - 支付建议：autoVoucher（建议传，Lightclaw 联调期默认 1）
//   - 不传：clientToken / distributionUin / cpsUin / agentPay / payer / voucherIds /
//     qcs_ip / q_token / auth (Q47/Q48 最小化协议表面 + 不签名)
//
// **使用建议**（PDF §1 "调用建议"）：
//   - 业务侧请求超时 ≥ 5s
//   - 降配场景必须用本接口
type GenerateDealsAndPayRequest struct {
	OwnerUin    string      `json:"ownerUin"`
	Uin         string      `json:"uin"`
	AppID       int64       `json:"appId,omitempty"`
	ClientToken string      `json:"clientToken,omitempty"`
	AutoVoucher *int        `json:"autoVoucher,omitempty"`
	Goods       []GoodsInfo `json:"goods"`
}

// GenerateDealsAndPayResponse 是 CGW envelope.data 反序列化目标。
//
// **响应字段集（v1.7.19 B14 协议校准，PDF §5.1 / §5.2 实测）**：
//
// PDF §5.2 示例（page 15）envelope 顶层 + data object：
//
//	{
//	  "data": {
//	    "dealNames":          ["<子订单 1>", ...],
//	    "resourceIds":        { "<dealName>": ["<resourceId>", ...] },
//	    "dealIds":            ["<deal id 1>", ...],
//	    "bigDealIds":         ["<大订单号>", ...],
//	    "dealDeliverResults": { "<dealName>": { "state": "0|1|2|3|4", ... } },
//	  }
//	}
//
// 注意：PDF §5.2 示例 envelope.data 是 **object**（与 getPrice envelope.data 是 array 不同）；
// trade jifeiclient.do() 把 envelope.data raw bytes 透传给 outResp 指针，由 *Response struct
// 决定形态，本类型用 object 形态正确接收。
//
// **关键观察 & Lightclaw 用法**：
//
//  1. ResourceIDs：PDF §5.1 提示 "异步发货 / 业务发货超时 / 未成功" 时 ResourceIDs 为空；Lightclaw
//     下单 pass 类商品的发货回调（ctl.createResource）默认是同步走通的，因此期望同步拿到 resourceId。
//     测试链路对 ResourceIDs 留空也要兼容（PDF §5.2 异步发货返回示例）。
//  2. DealDeliverResults["<deal>"].state 取值：0 发货成功 / 1 发货中 / 2 重试 queryFlow / 3 发货失败 /
//     4 部分发货失败。Lightclaw 联调链路把 ≠ 0 的状态都视为 "异步发货中" — 由 jifei 后续回调
//     trade.createResource 完成最终状态推进，trade 落库时只更新 trade_order.status 到
//     'paid_pending_provision'。
//  3. Lightclaw 单笔下单（goodsNum=1）下数组长度 = 1，trade_order.big_order_id 写入 BigDealIDs[0]；
//     DealNames[0] 同理写入 trade_order.deal_name。
//  4. PriceInfos 不在 generateDealsAndPay 响应字段集里（与 generateDeals 的响应不同）— PDF §5.1
//     没列出，client 不持有。
type GenerateDealsAndPayResponse struct {
	DealNames          []string                          `json:"dealNames"`
	ResourceIDs        map[string][]string               `json:"resourceIds,omitempty"`
	DealIDs            []string                          `json:"dealIds,omitempty"`
	BigDealIDs         []string                          `json:"bigDealIds"`
	DealDeliverResults map[string]map[string]interface{} `json:"dealDeliverResults,omitempty"`
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
	if len(req.Goods) == 0 {
		return nil, errInvalidArg("GenerateDealsAndPay: empty Goods")
	}
	out := &GenerateDealsAndPayResponse{}
	if err := c.do(ctx, InterfaceNameGenerateDealsAndPay, ComponentNameDeal, req, out); err != nil {
		return nil, err
	}
	return out, nil
}
