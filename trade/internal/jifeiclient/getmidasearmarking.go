package jifeiclient

import "context"

// GetMidasEarmarkingRequest 是 jifei CGW `qcloud.margin.getMidasEarmarking` "专款专用获取支付参数"
// 接口入参（para 内层）。
//
// **协议参考**：`/root/project/mono/.tmp/专款专用获取支付参数+-+qcloud.margin.getMidasEarmarking.pdf`
// （5 页 / 2026-05-11 投放）；componentName = "MC"（PDF 第 4 页 curl）。
//
// **字段集（PDF 第 3 页）**：
//
//	名称                类型     必填  说明
//	ownerUin           string   是   账户所有者
//	uin                string   是   当前操作者，可以是 ownerUin 或协作者 uin
//	dealNames          []string 是   支付的订单号列表
//	voucherIds         []string 否   代金券列表
//	platform           string   否   "mobile" / "pc"，默认 pc（对应 midas pf 参数）
//	wxOpenId           string   否   微信公众号/小程序场景必填
//	wxAppId            string   否   微信侧 appid
//	cancelUrl          string   否   用户取消支付后的前端回跳地址
//	returnUrl          string   否   用户完成支付后的前端回跳地址
//	contractOrder      int      否   1=支付中签约 / 0=非签约
//	channel            string   否   "remitPay"=对公打款 / "wechatClawbot"=微信 Clawbot
//	remitpayPayerName  string   否   channel=remitPay 时必传
//
// **Lightclaw 本期场景约束（Q-PAY-1 ~ Q-PAY-5 拍板 2026-05-11）**：
//   - 国内站仅传 OwnerUin / Uin / DealNames 三个必填字段（Q-PAY-4：不传 platform，jifei 默认 pc）
//   - 国际站获取支付链接已切到计费 CloudAPI CreatePayUrl，本接口仅保留给国内站路径使用。
//   - 不传 VoucherIds / WxOpenID / WxAppID / Channel / RemitpayPayerName
//     （与 Q48 协议表面最小化原则一致 — Lightclaw 控制台没有这些 UI 入口）
//
// **PascalCase 命名一致性**：与 GenerateDeals / GenerateDealsAndPay 保持 PascalCase
// （JSON tag 显式 camelCase，与 PDF 第 3 页字段名严格对齐）。
type GetMidasEarmarkingRequest struct {
	OwnerUin  string   `json:"ownerUin"`
	Uin       string   `json:"uin"`
	DealNames []string `json:"dealNames"`
	// v1.7.31 接口拆分新增：可选字段，空值时不序列化（omitempty），兼容现有行为。
	Platform  string `json:"platform,omitempty"`  // "pc" / "mobile"，默认 pc
	WxOpenID  string `json:"wxOpenId,omitempty"`  // 微信场景必填
	WxAppID   string `json:"wxAppId,omitempty"`   // 微信场景必填
	CancelURL string `json:"cancelUrl,omitempty"` // 取消支付后的前端回跳地址
	ReturnURL string `json:"returnUrl,omitempty"` // 完成支付后的前端回跳地址

	ContractOrder int    `json:"contractOrder,omitempty"` // 1=支付中签约 / 0=非签约
	PayScene      string `json:"payScene,omitempty"`      // 国际站信用卡签约支付：credit_card
}

// GetMidasEarmarkingResponse 是 CGW returnValue 反序列化目标。
//
// **字段集来源说明**：
//
//  1. PDF 协议（`.tmp/jifei_pdf_txt/专款专用获取支付参数+-+qcloud.margin.getMidasEarmarking.md`
//     2026-05-11 投放）列出的字段：
//
//     名称                       类型    说明
//     billId                    string  支付流水号
//     url                       string  支付链接（Lightclaw 取此字段返给前端）
//     appid                     string  米大师 appid（前端 SDK 跳转用）
//     needCharge                int     0=零元订单已支付成功 / 1=需跳 Midas 充值（Q-PAY-3：直接返 url）
//     wxInfo.wxSign             string  channel=wechatClawbot 时返；本期不感知
//     remitPayInfo.*            *       channel=remitpay 时返；本期不感知
//
// 2. **PDF 协议未列、但 jifei 实测稳定返回的字段（2026-05-23 联调期实测确认）**：
//
//	名称                       类型      说明
//	tokenId                   string    米大师支付 token；前端跳转 Midas SDK 用，与 url 内 query
//	                                    `token_id` 同值；本字段 PDF 第 4 页未列出
//	outTradeNo                string    米大师订单号；与 BillID 同值（PDF 第 4 页未列出，
//	                                    但 jifei 实际同时返这两个字段）
//	dealNames                 []string  原样回显入参 dealNames，本期 1 元素切片
//	bigDealIds                []string  对应大订单号集合（= trade_order.big_order_id）
//	dealDeliverResults        json      子订单发货状态明细，本期不感知，仅留 ELK 日志兜底
//
// **D3 兜底策略（2026-05-23 拍板）**：以上 5 个字段虽然实测稳定返，但属于"PDF 协议外契约"，
// jifei 后续可能在某些回包路径（错误回包 / channel=remitPay 通道 / 灰度变更）下不返。
// 业务层使用指针类型反序列化，缺失即 nil，JSON 序列化时 omitempty 输出为 null，前端兜底
// 处理。**禁止把这些字段值写死成 ""/0**，避免误把 jifei 实际未返的字段当成"已返空值"。
//
// **Lightclaw 本期映射**：
//   - URL 字段直接返给业务层（→ trade_order.pay_url 缓存 + 透传给 ctl）
//   - BillID / AppID / NeedCharge / TokenID / OutTradeNo 透传给前端做 Midas SDK 跳转
//   - DealNames / BigDealIDs / DealDeliverResults 仅留 ELK 日志兜底，不透前端（D6）
//   - WxInfo / RemitPayInfo 不感知（本期不传 channel = remitPay / wechatClawbot）
type GetMidasEarmarkingResponse struct {
	BillID     string `json:"billId"`
	URL        string `json:"url"`
	AppID      string `json:"appid"`
	NeedCharge int    `json:"needCharge"`

	// 以下字段 PDF 协议未列，但 jifei 联调实测稳定返（2026-05-23 验证）；指针类型支持
	// "协议未返回 → nil → JSON null" 兜底（详见上方"D3 兜底策略"段）。
	TokenID            *string                      `json:"tokenId,omitempty"`
	OutTradeNo         *string                      `json:"outTradeNo,omitempty"`
	DealNames          []string                     `json:"dealNames,omitempty"`
	BigDealIDs         []string                     `json:"bigDealIds,omitempty"`
	DealDeliverResults map[string]DealDeliverResult `json:"dealDeliverResults,omitempty"`

	// WxInfo / RemitPayInfo 故意不持有：本期不传 channel = remitPay / wechatClawbot；
	// 联调期若发现 jifei 对 Lightclaw uin 默认走非 pc 通道再补字段。
}

// DealDeliverResult 是 jifei `dealDeliverResults` map 的 value 字段集（PDF 协议未列出，
// 实测形态 `{"state":"1","resourceId":null}`，2026-05-23 联调验证）。
//
// 仅做 ELK 日志兜底用，**不透传给前端**（D6）；本期业务层不消费 state / ResourceID。
type DealDeliverResult struct {
	State      string  `json:"state"`
	ResourceID *string `json:"resourceId"`
}

// GetMidasEarmarking 调用 jifei CGW `qcloud.margin.getMidasEarmarking` 获取支付参数接口。
//
// 错误语义与 GenerateDeals / GetPrice 一致：
//   - nil 入参 / 必填字段缺失 → client-side errInvalidArg（不出请求）
//   - 业务失败（returnCode != 0）→ *CGWError；调用方可用 errors.As 提取并按业务语义分类
//   - HTTP 层 / envelope 解析失败 → ErrCGWHTTPNon200 / ErrCGWInvalidEnvelope
func (c *client) GetMidasEarmarking(ctx context.Context, req *GetMidasEarmarkingRequest) (*GetMidasEarmarkingResponse, error) {
	if req == nil {
		return nil, errInvalidArg("GetMidasEarmarking: nil request")
	}
	if req.OwnerUin == "" {
		return nil, errInvalidArg("GetMidasEarmarking: empty OwnerUin")
	}
	if req.Uin == "" {
		return nil, errInvalidArg("GetMidasEarmarking: empty Uin")
	}
	if len(req.DealNames) == 0 {
		return nil, errInvalidArg("GetMidasEarmarking: empty DealNames")
	}
	for i, dn := range req.DealNames {
		if dn == "" {
			return nil, errInvalidArg("GetMidasEarmarking: DealNames[" + itoa(i) + "] is empty")
		}
	}
	out := &GetMidasEarmarkingResponse{}
	if err := c.do(ctx, InterfaceNameGetMidasEarmarking, ComponentNameMidasCenter, req, out); err != nil {
		return nil, err
	}
	return out, nil
}

// itoa 是 strconv.Itoa 的极简内联（避免本文件单独 import strconv）。
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := false
	if i < 0 {
		neg = true
		i = -i
	}
	var buf [20]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}
