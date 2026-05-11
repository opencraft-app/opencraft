package jifeiclient

import (
	"context"
	"errors"
)

// errInvalidArg 是 client-side 入参校验失败的 sentinel 错误生成器。
//
// 这条错误不会出现在 CGW 出向（请求根本不发出去），与 *CGWError / ErrCGWHTTPNon200
// 等"协议层 / HTTP 层"错误严格区分。
func errInvalidArg(msg string) error {
	return errors.New("jifeiclient: " + msg)
}

// GenerateDealsRequest 是 jifei CGW `qcloud.Deal.generateDeals` 下单接口入参（para 内层）。
//
// **设计自决 Q67（2026-05-08 迭代 3 落地时）**：
// 设计稿 §3.5.5 只对 getPrice 给出完整字段集；generateDeals 下单方向只在 §4.2.1 / Step T3 /
// Q47 / Q48 / Q42 等条目散点提到约束，没有独立的协议小节。本字段集以 PDF 第 8 页 PascalCase
// 字段名 + Lightclaw 必需字段集为权威：
//
//   - PascalCase 命名（与 getPrice 询价的 camelCase 风格不一致由本 client 适配层吸收 — 业务层
//     / ctl / 前端不感知）
//   - 仅传协议必需字段：OwnerUin / Uin / GoodsInfos[]，不传 TagList / VoucherIDs / AgentPay（Q48）
//   - 不传 Currency 字段（Q42：jifei 按 ProductCode = p_lighthouse 自动推导默认币种 CNY）
//   - 不传 GoodsAlias（Q46：协议层非必填）
//   - 不传 auth.signature（Q47 不签名）
//   - PayMode 来自 trade_order.pay_mode 显式透传（Q42）
//
// 如果 PDF 后续投放修订要求新增必填字段，按"最小化协议表面"原则补充到本结构 + Q67 / Q68
// 决策记录里。
type GenerateDealsRequest struct {
	OwnerUin   string           `json:"OwnerUin"`
	Uin        string           `json:"Uin"`
	GoodsInfos []GoodsInfo      `json:"GoodsInfos"`
}

// GoodsInfo 是 GenerateDealsRequest.GoodsInfos 单条记录。
//
// 字段集与询价 ResInfo 类似但 PascalCase；GoodsDetail 仍是 map[string]interface{}，
// 由 jifei 适配层从 trade_bundle_definition.sv_list 展平 + product_info 透传后填入。
type GoodsInfo struct {
	GoodsCategoryID string                 `json:"GoodsCategoryId"`
	RegionID        int                    `json:"RegionId,omitempty"`
	ZoneID          int                    `json:"ZoneId,omitempty"`
	GoodsNum        int                    `json:"GoodsNum"`
	PayMode         int                    `json:"PayMode"`
	GoodsDetail     map[string]interface{} `json:"GoodsDetail,omitempty"`
	// 注：不持有 TagList / VoucherIDs / AgentPay / GoodsAlias / Currency 字段（Q46 / Q48 / Q42 收敛）。
}

// GenerateDealsResponse 是 CGW returnValue 反序列化目标。
//
// PDF 第 8 页约定 generateDeals 响应结构：
//
//	{
//	  BigDealId:  "<jifei 大订单号>",
//	  DealNames:  ["<子订单 1>", "<子订单 2>", ...],
//	  PriceInfos: [{ ... }, { ... }, ...]
//	}
//
// Lightclaw 本期单次下单 GoodsInfos 长度 = 1（一笔下单一个 pass，与 Q41 协同 GoodsNum=1），
// 所以 DealNames 数组通常只含 1 条 — 但 client 不强约束数组长度，由调用方按业务语义提取。
//
// PriceInfos 价格字段（Q50）一律不持久化 — 留作 ELK 日志审计兜底；client 提供 PriceInfos
// 字段供调用方透传日志，但业务层 trade_order 表不存。
type GenerateDealsResponse struct {
	BigDealID  string                   `json:"BigDealId"`
	DealNames  []string                 `json:"DealNames"`
	PriceInfos []map[string]interface{} `json:"PriceInfos,omitempty"`
}

// GenerateDeals 调用 jifei CGW `qcloud.Deal.generateDeals` 下单接口。
//
// 错误语义与 GetPrice 一致（Q68 错误模型）。
func (c *client) GenerateDeals(ctx context.Context, req *GenerateDealsRequest) (*GenerateDealsResponse, error) {
	if req == nil {
		return nil, errInvalidArg("GenerateDeals: nil request")
	}
	out := &GenerateDealsResponse{}
	if err := c.do(ctx, InterfaceNameGenerateDeals, ComponentNameDeal, req, out); err != nil {
		return nil, err
	}
	return out, nil
}
