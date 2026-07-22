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
// **协议字段名规范（v1.7.19 B14 协议校准，PDF §4.1 / §4.2 实测）**：
//   - 字段全部 **camelCase**（PDF §4.1 字段表 + §4.2 示例严格一致；历史 v1.7.5~v1.7.18
//     PascalCase 是 AI 误判，联调实测 jifei 返 returnCode=100001 后翻 PDF 校准）
//   - 数组名 **`goods`**（PDF §4.1 line "para.goods Array"），不是 `goodsInfos`
//
// **Lightclaw 字段集约束**（最小化协议表面 Q47 / Q48 / Q42 / Q46）：
//   - 协议必需：ownerUin / uin / appId / goods[]
//   - 不传：tagList / voucherIds / agentPay / currency (Q46 / Q48 / Q42)
//   - 不传：auth.signature (Q47 不签名)
//   - payMode 来自 trade_order.pay_mode 显式透传 (Q42)
//
// **AppID 字段补齐（v1.7.28 BUG-05 修复，TC1.2.1 联调暴露）**：
//   - PDF §4.1 明确 `para.appId Integer 是`（必填）
//   - v1.7.19 协议校准时只补了 GenerateDealsAndPayRequest.AppID，本 struct 漏配
//   - 实测 jifei 返 100001 "param error[check appId not match uin 700000164995]" — jifei
//     在请求里没看到 appId，按默认空值 (0) 与该 uin 的实际 appId 校验失败
//   - 与 GenerateDealsAndPayRequest.AppID 同范式：int64 + omitempty（空 0 时不传字段，
//     允许 jifei 从 ownerUin 反查；trade 调用方应该总是传非零值，从 shadowclient 拿）
type GenerateDealsRequest struct {
	OwnerUin string      `json:"ownerUin"`
	Uin      string      `json:"uin"`
	AppID    int64       `json:"appId,omitempty"`
	Goods    []GoodsInfo `json:"goods"`
}

// GoodsInfo 是 GenerateDealsRequest.Goods / GenerateDealsAndPayRequest.Goods 单条记录。
//
// 字段集与询价 ResInfo 一致（询价 ResInfo / 下单 GoodsInfo 在 PDF 都是 camelCase）；
// GoodsDetail 仍是 map[string]interface{}，由 jifei 适配层从 trade_bundle_definition.sv_list
// 展平 + product_info 透传后填入。
//
// Q71 拍板（2026-05-13）：GoodsCategoryID 类型从 string 改 int64，与 jifei PDF §4.1
// `"goodsCategoryId": 100019`（无引号 int）一致。GoodsDetail map 内的 pid / sv_* 字段
// 也是 int64 由 trade 适配层直接透传，不 stringify。
//
// ProjectID（v1.7.19 B14 新增）：PDF §4.1 标 "是" 必填（"没有项目概念则传 0"），
// Lightclaw 没有项目概念，trade 适配层固定传 0。
type GoodsInfo struct {
	GoodsCategoryID int64                  `json:"goodsCategoryId"`
	RegionID        int                    `json:"regionId,omitempty"`
	ZoneID          int                    `json:"zoneId,omitempty"`
	GoodsNum        int                    `json:"goodsNum"`
	PayMode         int                    `json:"payMode"`
	ProjectID       int                    `json:"projectId"`
	Action          string                 `json:"action,omitempty"`
	Type            string                 `json:"type,omitempty"`
	GoodsDetail     map[string]interface{} `json:"goodsDetail,omitempty"`
	// 注：不持有 tagList / voucherIds / agentPay / goodsAlias / currency 字段（Q46 / Q48 / Q42 收敛）。
}

// GenerateDealsResponse 是 CGW envelope.data 反序列化目标。
//
// **响应字段集（v1.7.28 BUG-11 修订 2026-05-21，PDF §5.1 / §5.2 实测）**：
//
// PDF §5.2 generateDeals 响应明示 `bigDealId String` (**单数 string**) +
// `dealNames Array` (复数数组)。jifei 实测 2026-05-21 04:11:59 返回 body：
//
//	"data": {
//	  "dealNames": ["20260521995022860913841"],     // 复数数组
//	  "bigDealId": "20260521995022860913831"        // 单数 string
//	}
//
// **历史回归 (v1.7.19 B14 → BUG-11)**：v1.7.19 commit 当时把 BigDealID string
// 改成 BigDealIDs []string + json:"bigDealIds"，注释写"历史 BigDealID string 是
// 误判"。但 PDF §5.2 + 实测都是 string 单数 — v1.7.19 校准方向反了，导致 trade
// 解析 jifei 响应时拿不到 bigDealId（unmarshal 静默成空数组）→ adapter 判定
// "BigDealIDs=[] DealNames=[...]" 走 ErrJifeiResponseInvalid 路径返 502.
//
// **注意 generateDealsAndPay 不同**：PDF generateDealsAndPay 响应是 `bigDealIds Array`
// (复数数组，因为支持多商品下单)，generatedealsandpay.go 的 BigDealIDs []string 是对的。
//
// Lightclaw 本期单次下单 goods 长度 = 1，dealNames 数组通常只含 1 条；BigDealID 也
// 只有 1 个。
type GenerateDealsResponse struct {
	DealNames  []string                 `json:"dealNames"`
	BigDealID  string                   `json:"bigDealId"`
	PriceInfos []map[string]interface{} `json:"priceInfos,omitempty"`
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
