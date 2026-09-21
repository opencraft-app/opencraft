package jifeiclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// flexString 是 jifei CGW 价格字段的容忍解码类型 (v1.7.17 B12)。
//
// 背景：jifei CGW 询价 / 下单接口对金额字段（price / totalCost / realTotalCost
// 等）的回包类型不稳定 — 实测 sandbox-bj-7 询价响应同一字段：
//   - 设计稿 / PDF §4.4 标记为 string
//   - 实际 jifei 沙箱回包是裸数字 (e.g. `"price": 4900`)
//
// 为了同时容忍数字和字符串，并且保持业务层 InquiryItem.Price string 字段不变，
// 这里定义 flexString 作为底层 string，实现 UnmarshalJSON 时数字裸值原样保留
// 数字字面量字符串（如 `4900` → "4900"，`100.00` → "100.00"），字符串值剥引号。
//
// 调用方（adapter / logic 层）赋值给 string 类型业务字段时显式 string(d.Price)
// 转换即可。
type flexString string

// UnmarshalJSON 同时接受 JSON string、JSON number、JSON null。
//
// null → 空字符串；数字保留原始字面量（例如 4900 不会变成 "4.900000e+03"）。
func (f *flexString) UnmarshalJSON(b []byte) error {
	bs := bytes.TrimSpace(b)
	if len(bs) == 0 || bytes.Equal(bs, []byte("null")) {
		*f = ""
		return nil
	}
	if bs[0] == '"' {
		var s string
		if err := json.Unmarshal(bs, &s); err != nil {
			return fmt.Errorf("flexString: unmarshal string: %w", err)
		}
		*f = flexString(s)
		return nil
	}
	// 数字 / 布尔 / 其它裸值 — 保留原始字面量
	*f = flexString(bs)
	return nil
}

// MarshalJSON 始终把 flexString 序列化为 JSON 字符串。
//
// 这样 envelopeForSuccess 等测试 helper 仍然能用 GetPriceData{Price: "100.00"}
// 形态构造响应包，反序列化端拿到 "100.00" 字符串，业务层 InquiryItem.Price 透传无损。
func (f flexString) MarshalJSON() ([]byte, error) {
	return json.Marshal(string(f))
}

// flexFloat 是 jifei CGW 时长字段的容忍解码类型。
//
// 存在原因是变配场景：新购 / 续费的 timeSpan 是整数周期（`1` 个月），但变配的
// timeSpan 是"当前时刻到 curDeadline 的剩余时长占比"，实测回包为小数
// （`"timeSpan": 0.133333`，即约 4 天 / 1 个月）。字段声明成 int 时
// encoding/json 会直接报 `cannot unmarshal number 0.133333 into ... int`，
// 整个变配询价回包解析失败 —— 价格其实已经算对了，只是我们读不进来。
//
// 与 flexString / flexInt 同一范式：兜底 number（整数或小数）、string-encoded
// 数字、null（→ 0）。业务层按 float64 使用；整数值序列化回 JSON 仍是 `1` 而非
// `1.0`，故对新购 / 续费的既有出参零影响。
type flexFloat float64

// UnmarshalJSON 同时接受 JSON number（整数 / 小数）、JSON string-encoded 数字、JSON null。
func (f *flexFloat) UnmarshalJSON(b []byte) error {
	bs := bytes.TrimSpace(b)
	if len(bs) == 0 || bytes.Equal(bs, []byte("null")) {
		*f = 0
		return nil
	}
	if bs[0] == '"' {
		var s string
		if err := json.Unmarshal(bs, &s); err != nil {
			return fmt.Errorf("flexFloat: unmarshal string: %w", err)
		}
		if strings.TrimSpace(s) == "" {
			*f = 0
			return nil
		}
		n, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return fmt.Errorf("flexFloat: parse string-encoded number %q: %w", s, err)
		}
		*f = flexFloat(n)
		return nil
	}
	var n float64
	if err := json.Unmarshal(bs, &n); err != nil {
		return fmt.Errorf("flexFloat: unmarshal number: %w", err)
	}
	*f = flexFloat(n)
	return nil
}

// MarshalJSON 始终序列化为 JSON number（整数值不带小数点）。
func (f flexFloat) MarshalJSON() ([]byte, error) {
	return json.Marshal(float64(f))
}

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
//
// Q71 拍板（2026-05-13）：GoodsCategoryID 类型从 string 改 int64，与 jifei PDF
// §4.1 line 14 `"goodsCategoryId": 100019`（无引号 int）严格对齐。
type GetPriceItem struct {
	GoodsCategoryID int64  `json:"goodsCategoryId"`
	Currency        string `json:"currency,omitempty"`
	RegionID        int    `json:"regionId,omitempty"`
	ZoneID          int    `json:"zoneId,omitempty"`
	GoodsNum        int    `json:"goodsNum"`
	PayMode         int    `json:"payMode"`
	// Action 历史上传 "purchase" / "renew" / "modify" 表示订单类型；jifei PDF
	// 《下单接口 qcloud.Deal.generateDeals》line 173 / 206 明示「**有 categoryid
	// 则不用传 action**」。trade 调用 getPrice 时 GoodsCategoryID 必填（按
	// scene=purchase/renew 从 trade_bundle_definition.category_ids 反查不同
	// categoryId），因此 jifei 后台可由 categoryId 反查 scene，无需额外的 action
	// 字段。生产环境实测：同时传 action + categoryId 会被 jifei 现网拒回
	// `returnCode=100001 param error[action: is invalid]`（v1.7.x B17 修复）。
	// json tag 加 `omitempty`，业务侧（inquiry/service.go）不再赋值，序列化时
	// 自动省略；单元测试保留对该 struct 字段的赋值不影响行为（jifei mock
	// server 不校验出向 body 含 action）。
	Action      string                 `json:"action,omitempty"`
	GoodsDetail map[string]interface{} `json:"goodsDetail,omitempty"` // 含 productCode / subProductCode / pid (int) / timeSpan / timeUnit / sv_* (int) 等字段
}

// GetPriceResponse 是 CGW returnValue 反序列化目标。
type GetPriceResponse struct {
	Data []GetPriceData `json:"data"`
}

// GetPriceData 是 returnValue.data 数组单条（与入参 ResInfo[] 1:1 对应）。
//
// 字段集与设计稿 §3.5.5 (5) 出参 schema 严格对齐；本期 trade 适配层只关心
// price / totalCost / realTotalCost / currency / policyDetail.total（拍平为 discount）；
// 国际站询价会消费 highPrecisionPrice.*High 并换算成对前端兼容的金额单位。其余字段
// 由 client 透传后由调用方 / ELK 日志兜底（与 Q50 不持久化原则一致）。
type GetPriceData struct {
	Price         flexString `json:"price"`
	TotalCost     flexString `json:"totalCost"`
	RealTotalCost flexString `json:"realTotalCost"`
	Currency      string     `json:"currency"`
	TimeUnit      string     `json:"timeUnit,omitempty"`
	// TimeSpan 变配场景是小数（剩余时长占比，实测 0.133333），新购 / 续费是整数周期，
	// 故用 flexFloat 容忍解码。详见 flexFloat 注释。
	TimeSpan           flexFloat           `json:"timeSpan,omitempty"`
	GoodsNum           int                 `json:"goodsNum,omitempty"`
	ProductCode        string              `json:"productCode,omitempty"`
	SubProductCode     string              `json:"subProductCode,omitempty"`
	Pid                int64               `json:"pid,omitempty"`    // Q71：PDF §4.4 pid 是 int
	Policy             float64             `json:"policy,omitempty"` // jifei 实测返回 0.01 浮点（折扣率 1.0=不打折 / 0.01=1 折），不能用 int；本字段仅 ELK 兜底，业务层不消费
	PolicyDetail       *PolicyDetail       `json:"policyDetail,omitempty"`
	TaxDetail          *TaxDetail          `json:"taxDetail,omitempty"`
	HighPrecisionPrice *HighPrecisionPrice `json:"highPrecisionPrice,omitempty"`
	// PartDetail jifei 沙箱实测回包是 object（如 `{"discount": ...}`），但 PDF
	// §4.4 / 设计稿标 array。为兼容两种形态保留为 RawMessage（业务层不消费此字段，
	// 仅 ELK 日志兜底，与 Q50 不持久化原则一致）。v1.7.18 B13.
	PartDetail json.RawMessage `json:"partDetail,omitempty"`
}

// TaxDetail is the international tax metadata returned for one quoted item.
type TaxDetail struct {
	TaxRate flexString `json:"taxRate"`
}

// HighPrecisionPrice 是 jifei 国际站高精度金额字段。
//
// 实测国际站 USD 询价应优先消费 realTotalCostHigh 等高精度字段，字段单位为
// 主币种 * 1e8。字段类型同 price / totalCost 一样存在 number/string 漂移，使用
// flexString 容忍解码。
type HighPrecisionPrice struct {
	PriceHigh         flexString `json:"priceHigh,omitempty"`
	TotalCostHigh     flexString `json:"totalCostHigh,omitempty"`
	RealTotalCostHigh flexString `json:"realTotalCostHigh,omitempty"`
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
	// v1.7.16 B11: jifei 响应 envelope.data 是 GetPriceData 数组 (顶层就是 [{...}, ...]),
	// 不是对象包装 {data: [...]}. do() 直接把 envelope.data raw bytes unmarshal 到
	// outResp, 所以这里给 do() 一个数组指针, 然后 wrap 回 GetPriceResponse 给调用方
	// (保持 GetPrice 公开 API 形态不变).
	var data []GetPriceData
	if err := c.do(ctx, InterfaceNameGetPrice, ComponentNamePrice, req, &data); err != nil {
		return nil, err
	}
	return &GetPriceResponse{Data: data}, nil
}
