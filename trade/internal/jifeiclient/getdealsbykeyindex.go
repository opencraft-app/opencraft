// 出向 jifei CGW 协议层订单状态反查 SDK：`qcloud.Deal.getDealsByKeyIndex`。
//
// 设计稿对齐：`.tmp/ctl-order-status-query-design.md` §5.1。
// PDF 协议参考：`.tmp/jifei_pdf_txt/getDealsByKeyIndex-根据订单号查询订单.doc`。
//
// 用途：trade 在前端发起轮询订单状态时（`POST /internal/trade/orders/:deal/query-status`），
// 仅当本地 `trade_order.status` 处于中态（created / pending_pay / paid_pending_provision）
// 才会调用本接口反查 jifei 真实状态；本地终态（B1：provisioned / payment_failed /
// provision_failed / cancelled）直接短路返本地结果，**不调 jifei**。
package jifeiclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strconv"
)

// GetDealsByKeyIndexRequest 是 jifei CGW `qcloud.Deal.getDealsByKeyIndex` 入参（para 内层）。
//
// 字段命名严格对齐 PDF：`cond.dealName` / `cond.dealNameList` / `cond.bigDealId`。
// 本期仅用 `cond.dealName`（单订单查询），未来如要支持批量查询可填 `dealNameList`。
type GetDealsByKeyIndexRequest struct {
	// Cond 是 jifei 协议层查询条件嵌套层；本期至少要传 DealName。
	Cond GetDealsByKeyIndexCond `json:"cond"`
}

// GetDealsByKeyIndexCond 是 cond 嵌套层；三个字段是“或”关系，至少传一个。
type GetDealsByKeyIndexCond struct {
	// DealName 单订单号反查（本期主路径）。
	DealName string `json:"dealName,omitempty"`
	// DealNameList 批量订单号反查（本期不用，预留）。
	DealNameList []string `json:"dealNameList,omitempty"`
	// BigDealID 大订单号反查（本期不用，预留）。
	BigDealID []string `json:"bigDealId,omitempty"`
}

// GetDealsByKeyIndexResponse 是 envelope.returnValue.data 反序列化目标。
//
// envelope.data 是 object（与 generateDealsAndPay 一致，与 getPrice 的 array 不同）。
//
// **协议层字段类型不稳定的兼容点（v1.7.33 BUG-25 修复，2026-06-01 sandbox-bj-7 联调实测发现）**：
//
//   - `TotalNum` 字段：jifei PDF 协议规定为 int，但 jifei CGW 实测沙箱回包是 string-encoded int
//     (`"totalNum": "1"`)。这里使用 `flexInt` 双兼容（与 `Status` 字段同范式）。修复前 trade
//     orderstatus 反查中态订单时会触发 `json: cannot unmarshal string into Go struct field
//     GetDealsByKeyIndexResponse.totalNum of type int`，B7 fallback 兜底兜底但前端拿不到 jifei
//     真实状态。
type GetDealsByKeyIndexResponse struct {
	// TotalNum 是命中的 deal 总数（本期单查时 = 0 表示订单不存在；= 1 表示命中）。
	//
	// 类型为 flexInt（v1.7.33 BUG-25 修复）：jifei CGW 实测回 string-encoded int (`"1"`)。
	TotalNum flexInt `json:"totalNum"`
	// Deals 是命中的订单详情数组；本期单查时长度 0 / 1。
	Deals []DealQueryItem `json:"deals"`
}

// DealQueryItem 是 deals[] 数组单条；字段集为 PDF 文档示例的子集
// （仅保留业务层 trade_order 反查 + 状态映射所需字段）。
//
// **协议层字段类型不稳定的兼容点**：
//
//   - `Status` 字段：jifei PDF 首页协议描述为 `String`（"status": "2"），但 jifei 实测样例
//     回包是裸 int（"status": 2）。这里使用 `flexInt` 双兼容（与 [getprice.go]::flexString
//     范式一致，是 trade 与 jifei CGW 协议层容忍解码的统一姿势）。
//
//   - `GoodsDetail` 字段：可能是 string-encoded JSON 数组，也可能是直接展开的 JSON 数组对象。
//     这里用 `json.RawMessage` 透传，由调用方按需二次解码（本期 trade orderstatus logic 不解析
//     此字段，仅 jifeiclient 层透传给上层日志兜底）。
type DealQueryItem struct {
	DealName       string                 `json:"dealName"`
	BigDealID      string                 `json:"bigDealId"`
	ProductCode    string                 `json:"productCode"`
	SubProductCode string                 `json:"subProductCode"`
	GoodsDetail    json.RawMessage        `json:"goodsDetail,omitempty"`
	TaskDetail     map[string]interface{} `json:"taskDetail,omitempty"`
	Status         flexInt                `json:"status"`
}

// flexInt 是 jifei CGW 订单状态字段的容忍解码类型（v1.7.32 引入）。
//
// 背景：jifei `getDealsByKeyIndex` 返回的 `status` 字段类型不稳定 — 协议文档首页表述为
// `String`（`"status": "2"`），但实测沙箱回包多数是裸数字（`"status": 2`）。
//
// flexInt 同时容忍：
//   - JSON number（如 `2`）→ 直接解析
//   - JSON string-encoded int（如 `"2"`）→ 剥引号后用 strconv.Atoi 解析
//   - JSON null / 空字符串 → 解析为 0（业务层 0 不在 JifeiDealStatus* 枚举内，调用方按
//     “未知状态”处理）
//
// 与 flexString（getprice.go）范式严格对仗：flexString 兜底 string 字段，flexInt 兜底 int 字段。
// 上层（adapter / logic）把 flexInt 当作 int 使用即可：`int(item.Status)`。
type flexInt int

// UnmarshalJSON 同时接受 JSON int / JSON string-encoded int / JSON null。
func (f *flexInt) UnmarshalJSON(b []byte) error {
	bs := bytes.TrimSpace(b)
	if len(bs) == 0 || bytes.Equal(bs, []byte("null")) {
		*f = 0
		return nil
	}
	if bs[0] == '"' {
		var s string
		if err := json.Unmarshal(bs, &s); err != nil {
			return fmt.Errorf("flexInt: unmarshal string: %w", err)
		}
		if s == "" {
			*f = 0
			return nil
		}
		n, err := strconv.Atoi(s)
		if err != nil {
			return fmt.Errorf("flexInt: parse string-encoded int %q: %w", s, err)
		}
		*f = flexInt(n)
		return nil
	}
	var n int
	if err := json.Unmarshal(bs, &n); err != nil {
		return fmt.Errorf("flexInt: unmarshal int: %w", err)
	}
	*f = flexInt(n)
	return nil
}

// MarshalJSON 始终把 flexInt 序列化为 JSON number。
//
// 这样 envelopeForSuccess 等测试 helper 仍可用 DealQueryItem{Status: flexInt(5)} 形态构造
// 响应包，业务层拿到 int 透传无损。
func (f flexInt) MarshalJSON() ([]byte, error) {
	return json.Marshal(int(f))
}

// jifei 协议层 deal status 枚举（PDF 首页 + 实测样例双印证）。
//
// 注：jifei status=7 在 PDF 首页未公开列出（jifei 内部某个中间态，外部不会触达），本期直接
// 跳过；如未来 jifei 协议扩展再补。trade orderstatus 业务层把未列入下列 8 个值的 status
// 一律按“未知中态”映射为 `pending`（向前兼容）。
const (
	// JifeiDealStatusInit 初始化（中态）。
	JifeiDealStatusInit = 1
	// JifeiDealStatusPaying 支付中（中态）。
	JifeiDealStatusPaying = 2
	// JifeiDealStatusProcessing 处理中 / 已支付待发货（中态）。
	JifeiDealStatusProcessing = 3
	// JifeiDealStatusDelivered 已发货（jifei 视角中态，trade 视角下 pass 还未到 ctl 端）。
	JifeiDealStatusDelivered = 4
	// JifeiDealStatusFinished 已完成（终态，jifei 闭环成功）。
	JifeiDealStatusFinished = 5
	// JifeiDealStatusCanceled 已取消（终态，用户主动取消）。
	JifeiDealStatusCanceled = 6
	// JifeiDealStatusOverdue 超时未支付（终态，jifei 自动判废）。
	JifeiDealStatusOverdue = 8
	// JifeiDealStatusDelete 已删除（终态，运营动作）。
	JifeiDealStatusDelete = 100
)

// GetDealsByKeyIndex 调用 jifei CGW `qcloud.Deal.getDealsByKeyIndex` 反查订单状态。
//
// 错误语义（与 GetPrice / GenerateDeals 一致）：
//   - nil 入参 / cond 三字段全空 → client-side errInvalidArg（不出请求）
//   - HTTP 层失败 / 非 2xx → wrap ErrCGWHTTPNon200 或原始 net error
//   - 协议层失败（returnCode != 0）→ 返回 *CGWError；调用方可用 errors.As 提取
//   - envelope 解码失败 → wrap ErrCGWInvalidEnvelope
//
// **不可达降级**（设计稿不变量 B7）由调用方 (trade orderstatus logic) 实现：捕获本方法
// 任何错误后，返回 200 + 本地状态 + source="local" + upstream_err="..."，不阻断前端轮询。
func (c *client) GetDealsByKeyIndex(ctx context.Context, req *GetDealsByKeyIndexRequest) (*GetDealsByKeyIndexResponse, error) {
	if req == nil {
		return nil, errInvalidArg("GetDealsByKeyIndex: nil request")
	}
	if req.Cond.DealName == "" && len(req.Cond.DealNameList) == 0 && len(req.Cond.BigDealID) == 0 {
		return nil, errInvalidArg("GetDealsByKeyIndex: cond.{dealName,dealNameList,bigDealId} all empty")
	}
	var resp GetDealsByKeyIndexResponse
	if err := c.do(ctx, InterfaceNameGetDealsByKeyIndex, ComponentNameDeal, req, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}
