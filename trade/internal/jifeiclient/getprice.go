package jifeiclient

import "context"

// GetPriceRequest 是 jifei CGW `qcloud.price.getPrice` 询价接口入参（para 内层）。
//
// 字段命名与 PDF 第 5 页 / 设计稿 §3.5.5 (4) camelCase 保持严格一致。
//
// Lightclaw 本期场景约束（Q47 / Q48 / Q42 协同）：
//   - 不传 auth.signature（CGW 协议层根本无此字段）
//   - 不传 tagList / voucherIds / agentPay（Q48 协议表面最小化）
//   - currency 由 jifei 按 productCode 自动推导（Q42），但 CGW 询价层 currency 是 res 级字段、
//     PDF 上没有"协议要求传"的强约束，本期 trade 适配层显式传 "CNY" 与下单接口对齐
//   - sv_* 系列字段从 trade_bundle_definition.sv_list 展平（必填）
type GetPriceRequest struct {
	OwnerUin string         `json:"ownerUin"`
	Uin      string         `json:"uin"`
	ResInfo  []GetPriceItem `json:"resInfo"`
}

// GetPriceItem 是 GetPriceRequest.ResInfo 数组的单条记录（一个 bundle 询价单元）。
type GetPriceItem struct {
	GoodsCategoryID string                 `json:"goodsCategoryId"`
	Currency        string                 `json:"currency,omitempty"`
	RegionID        int                    `json:"regionId,omitempty"`
	ZoneID          int                    `json:"zoneId,omitempty"`
	GoodsNum        int                    `json:"goodsNum"`
	PayMode         int                    `json:"payMode"`
	Action          string                 `json:"action"`                // "purchase" / "renew" / "modify"，本期仅 purchase
	GoodsDetail     map[string]interface{} `json:"goodsDetail,omitempty"` // 含 productCode / subProductCode / pid / timeSpan / timeUnit / sv_* 展平后字段
}

// GetPriceResponse 是 CGW returnValue 反序列化目标。
type GetPriceResponse struct {
	Data []GetPriceData `json:"data"`
}

// GetPriceData 是 returnValue.data 数组单条（与入参 ResInfo[] 1:1 对应）。
//
// 字段集与设计稿 §3.5.5 (5) 出参 schema 严格对齐；本期 trade 适配层只关心
// price / totalCost / realTotalCost / currency / policyDetail.total（拍平为 discount）—
// 其余字段（highPrecisionPrice / policy / partDetail / timeUnit / timeSpan 等）由 client
// 透传后由调用方 / ELK 日志兜底（与 Q50 不持久化原则一致）。
type GetPriceData struct {
	Price              string                 `json:"price"`
	TotalCost          string                 `json:"totalCost"`
	RealTotalCost      string                 `json:"realTotalCost"`
	Currency           string                 `json:"currency"`
	TimeUnit           string                 `json:"timeUnit,omitempty"`
	TimeSpan           int                    `json:"timeSpan,omitempty"`
	GoodsNum           int                    `json:"goodsNum,omitempty"`
	ProductCode        string                 `json:"productCode,omitempty"`
	SubProductCode     string                 `json:"subProductCode,omitempty"`
	Pid                string                 `json:"pid,omitempty"`
	Policy             int                    `json:"policy,omitempty"`
	PolicyDetail       *PolicyDetail          `json:"policyDetail,omitempty"`
	HighPrecisionPrice map[string]interface{} `json:"highPrecisionPrice,omitempty"`
	PartDetail         []map[string]interface{} `json:"partDetail,omitempty"`
}

// PolicyDetail 是 GetPriceData.policyDetail 嵌套结构。
//
// 适配层把 Total 拍平为业务层 `discount` 字段（与 Q50 / ctl-bundle-design-update.md §2.3.1
// v3.1 拍平版严格协同）；User / Common 分项不映射到业务层，仅在 ELK 日志保留供排障。
type PolicyDetail struct {
	Total  float64 `json:"total"`
	User   float64 `json:"user,omitempty"`
	Common float64 `json:"common,omitempty"`
}

// GetPrice 调用 jifei CGW `qcloud.price.getPrice` 询价接口。
//
// 错误语义（Q68）：
//   - HTTP 层失败（连接 / 超时 / 非 2xx）→ wrap ErrCGWHTTPNon200 或原始 net error
//   - 协议层失败（returnCode != 0）→ 返回 *CGWError（用 errors.As 提取）
//   - envelope 解码失败 → wrap ErrCGWInvalidEnvelope
func (c *client) GetPrice(ctx context.Context, req *GetPriceRequest) (*GetPriceResponse, error) {
	if req == nil {
		return nil, errInvalidArg("GetPrice: nil request")
	}
	out := &GetPriceResponse{}
	if err := c.do(ctx, InterfaceNameGetPrice, ComponentNamePrice, req, out); err != nil {
		return nil, err
	}
	return out, nil
}
