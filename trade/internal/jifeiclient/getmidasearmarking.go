package jifeiclient

import "context"

// GetMidasEarmarkingRequest 是 jifei CGW `qcloud.margin.getMidasEarmarking` "专款专用获取支付参数"
// 接口入参（para 内层）。
//
// **协议参考**：`/root/project/mono/.tmp/专款专用获取支付参数+-+qcloud.margin.getMidasEarmarking.pdf`
// （5 页 / 2026-05-11 投放）；云 API 别名 CreatePayUrl；componentName = "MC"（PDF 第 4 页 curl）。
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
//	contractOrder      int      否   1=支付中签约 / 0=非签约
//	channel            string   否   "remitPay"=对公打款 / "wechatClawbot"=微信 Clawbot
//	remitpayPayerName  string   否   channel=remitPay 时必传
//
// **Lightclaw 本期场景约束（Q-PAY-1 ~ Q-PAY-5 拍板 2026-05-11）**：
//   - 仅传 OwnerUin / Uin / DealNames 三个必填字段（Q-PAY-4：不传 platform，jifei 默认 pc）
//   - 不传 VoucherIds / WxOpenID / WxAppID / ContractOrder / Channel / RemitpayPayerName
//     （与 Q48 协议表面最小化原则一致 — Lightclaw 控制台没有这些 UI 入口）
//
// **PascalCase 命名一致性**：与 GenerateDeals / GenerateDealsAndPay 保持 PascalCase
// （JSON tag 显式 camelCase，与 PDF 第 3 页字段名严格对齐）。
type GetMidasEarmarkingRequest struct {
	OwnerUin  string   `json:"ownerUin"`
	Uin       string   `json:"uin"`
	DealNames []string `json:"dealNames"`
	// 注：本期不持有 VoucherIds / Platform / WxOpenID / WxAppID / ContractOrder / Channel /
	// RemitpayPayerName 字段（Q-PAY-4 + Q48 收敛"最小协议表面"）。
}

// GetMidasEarmarkingResponse 是 CGW returnValue 反序列化目标。
//
// **字段集（PDF 第 4 页）**：
//
//	名称                       类型    说明
//	billId                    string  支付流水号
//	url                       string  支付链接（Lightclaw 取此字段返给前端）
//	appid                     string  米大师 appid（前端 SDK 跳转用）
//	needCharge                int     0=零元订单已支付成功 / 1=需跳 Midas 充值（Q-PAY-3：直接返 url）
//	wxInfo.wxSign             string  channel=wechatClawbot 时返；本期不感知
//	remitPayInfo.bankAccount  string  channel=remitpay 时返；本期不感知
//	remitPayInfo.bankName     string  channel=remitpay 时返；本期不感知
//	remitPayInfo.payeeAccountName  string  同上
//	remitPayInfo.payerName    string  同上
//
// **Lightclaw 本期映射**：
//   - URL 字段直接返给业务层（→ trade_order.pay_url 缓存 + 透传给 ctl）
//   - BillID / AppID / NeedCharge 留作 ELK 日志审计兜底（Q-PAY-1 b 拍板：不落 trade_order 列）
//   - WxInfo / RemitPayInfo 不感知（本期不传 channel = remitPay / wechatClawbot）
type GetMidasEarmarkingResponse struct {
	BillID     string `json:"billId"`
	URL        string `json:"url"`
	AppID      string `json:"appid"`
	NeedCharge int    `json:"needCharge"`
	// WxInfo / RemitPayInfo 故意不持有：本期不传 channel = remitPay / wechatClawbot；
	// 联调期若发现 jifei 对 Lightclaw uin 默认走非 pc 通道再补字段。
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
