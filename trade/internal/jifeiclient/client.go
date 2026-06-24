// Package jifeiclient 封装 trade → jifei 出向的 CGW 协议层 HTTP 客户端。
//
// 协议参考：
//   - 设计稿 §3.5.5 jifei CGW 协议层契约（询价方向）
//   - PDF：`/root/project/mono/.tmp/询价接口+- qcloud.price.getPrice（CGW）.pdf`（22 页 / 2026-05-07 投放）
//   - 拍板项 Q47 / Q48 / Q42 / Q50 / Q51（详见 .tmp/trade-purchase-flow-design.md §10）
//   - 自决项 Q67（generateDeals PascalCase 最小字段集）/ Q68（错误模型）
//
// 设计要点：
//
//  1. **CGW framework 双层结构**：所有 CGW 请求都遵循
//     `{version, componentName, eventId, timestamp, seqId, interface{interfaceName, para}}`
//     7 字段顶层 + `interface.para` 内层业务字段；响应同结构
//     `{returnCode, returnMessage, returnValue{...}}`（returnCode == 0 即业务成功）。
//
//  2. **不签名（Q47）**：trade → jifei 请求方向 CGW 协议层根本无 `auth.signature` 字段，
//     trade 不持有、不传任何签名 — 与 Q48 一道收敛"最小协议表面"。
//
//  3. **CGW 网关鉴权（Q51）**：
//     - HTTP `Host` header：`trade.itd.com`（CGW 网关基于 Host 路由到 jifei 后端）
//     - HTTP `x-qcloud-user-id` header：trade 服务账号 uin（标识请求来源，与业务层
//     `interface.para.ownerUin` / `uin` 字段独立）
//     - 中转机 IP 白名单：由部署侧出口 IP 注册，client 不感知
//
//  4. **错误模型（Q68）**：
//     - HTTP 层失败（连接 / 超时 / 非 2xx）→ 哨兵 `ErrCGWHTTPNon200` 或原始 net error
//     - 协议层失败（HTTP 200 但 returnCode != 0）→ typed `*CGWError{ReturnCode, ReturnMessage}`
//     - 出参解析失败 → 哨兵 `ErrCGWInvalidEnvelope`
//     这样上层 jifei 适配层可以用 `errors.Is` / `errors.As` 区分降级 vs 透传。
//
//  5. **超时**：默认 4s（与 ctlclient 一致，对齐 Q59 同步发货 5s 总预算 - 1s buffer）；
//     调用方可通过 Options.HTTPClient 注入自定义超时 / Transport。
package jifeiclient

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// 协议层常量（与设计稿 §3.5.5 / Q47 / Q51 严格对齐）。
//
// **2026-05-18 jifei 联调期协议校准（按 user 拍板 Q-INT-12 v1.7.4）**：
//   - **caller 与 componentName 同值** = "lightvela"（PDF §公共参数 caller 描述"调用方模块名"，
//     与 componentName 描述完全相同；jifei 业务侧约定 lightvela 业务全部 5 个出向接口都用
//     `lightvela`，**不再沿 PDF curl 示例的 `qcbuy` / `MC` / `Deal` / `price` / `operation`**
//     这些 jifei 历史业务的 demo 取值）
//   - **eventId 改 int 类型**（PDF §公共参数明示类型 int；2026-05-08 起 string hex 已与 jifei 实际
//     校验语义不符）
//   - **seqId 不传**（PDF §公共参数注释 "业务调用计费时不用传递"）
//   - **x-qcloud-user-id 仅测试环境带**（测试 uin = 700000164995；现网由部署侧出口 IP 鉴权，
//     不需要带；client 在 xQCloudUserID == "" 时**不发送** header）
const (
	// CGWVersion 是 CGW framework 顶层 version 字段；PDF 使用 "1.0"。
	CGWVersion = "1.0"

	// CGWHostHeader 是 CGW 网关路由用 Host header；PDF 第 5 页明示。
	//
	// **2026-05-18 v1.7.2 拍板 Q-INT-11=b 后**：本常量不再被 do() 主动注入，由 clgateway
	// 网关 upstream 段重写 Host header 覆盖 trade 发出的请求。本常量保留用于 client_test.go
	// 直接发送（绕过 clgateway）的旧路径，新代码不要使用。
	CGWHostHeader = "trade.itd.com"

	// CGWUserIDHeader 是 CGW 网关用户标识 header（Q51）。
	CGWUserIDHeader = "x-qcloud-user-id"

	// CGWTransactionIDHeader 是 jifei 计费侧请求染色 / 链路追踪 header (v1.7.28 BUG-05 排障引入)。
	//
	// 参考 lighthouse_devops patching/patching_lightpower.py HTTP_REQUESTER_PATCH_STUB 范式 —
	// lightpower 在出向请求中带 `X-QCloud-Transaction-ID`(32 位 UUID hex) 让 jifei 侧能基于 transaction_id
	// 在内部链路追踪系统反查具体请求路径 / 各步骤日志。trade 出向 jifei CGW 加同样 header
	// 便于联调排障 (例如 jifei 返 700002 "rc check failed" 时, 业务方报具体 transaction_id 给
	// 计费同事排查 sp 内置校验失败的具体原因, 不需要双方手工对齐请求时间戳)。
	//
	// 与 lightpower 不同点：lightpower 是入向链路 (透传上游 transaction_id), trade 是出向链路起点
	// (自己生成新 transaction_id), 故每次请求 do() 内调用 randomTransactionID() 生成新值。
	CGWTransactionIDHeader = "X-QCloud-Transaction-ID"

	// CGWComponentIDHeader 是 jifei 侧业务方标识 header (与 transaction_id 同源 lightpower patching)。
	// 固定值 "lightclaw.trade" 标识 trade 服务作为请求源。
	CGWComponentIDHeader = "X-QCloud-Component-ID"
	CGWComponentIDValue  = "lightclaw.trade"

	// 询价 / 下单 / 获取支付链接的 CGW interfaceName 与 componentName。
	// **v1.7.4 起 5 个 componentName 常量值统一收敛到 "lightvela"**（user 拍板 Q-INT-12）；
	// 常量名保留以维持 5 处调用 site 兼容（getprice.go / generatedeals.go /
	// generatedealsandpay.go / getmidasearmarking.go / modifyresourcestatus.go）。
	InterfaceNameGetPrice            = "qcloud.price.getPrice"
	InterfaceNameGenerateDeals       = "qcloud.Deal.generateDeals"
	InterfaceNameGenerateDealsAndPay = "qcloud.Deal.generateDealsAndPay"
	InterfaceNameGetMidasEarmarking  = "qcloud.margin.getMidasEarmarking"
	// InterfaceNameGetDealsByKeyIndex 是 jifei 订单状态反查接口（v1.7.32 引入）。
	// 用于前端轮询订单支付状态场景（详见 .tmp/ctl-order-status-query-design.md）。
	InterfaceNameGetDealsByKeyIndex = "qcloud.Deal.getDealsByKeyIndex"

	// CGWComponentNameLightvela 是 lightvela 业务约定的 componentName / caller 值。
	// 5 处 ComponentName* 常量都收敛到此值（v1.7.4 协议校准）。
	CGWComponentNameLightvela = "lightvela"

	// 5 处 ComponentName* 常量保留为别名，避免改 5 处调用 site；值统一为 lightvela。
	ComponentNamePrice       = CGWComponentNameLightvela
	ComponentNameDeal        = CGWComponentNameLightvela
	ComponentNameMidasCenter = CGWComponentNameLightvela

	// defaultTimeout 是 jifei CGW 出向请求默认超时。
	//
	// **30s（v1.7.28 BUG-10 修复 2026-05-21）**：
	// jifei 同步生成订单链路 (qcloud.Deal.generateDeals / generateDealsAndPay) 包含
	// 同步回调 trade lightvela.pass.checkCreate 并等待 trade 返 returnCode=0 才能继续，
	// 整个同步链路实测 > 4s（trade 内部还要反查 ctl/bundle + ctl/pass 等）；如果客户端
	// 4s 超时会让 jifei 在还没拿到 trade callback 响应前就被中断，最终 returnCode 反包
	// 返 context deadline exceeded（实测 BUG-10 现象）。
	//
	// 30s 是 PDF §1.3 同步接口默认 SLA 的安全上限（PDF "接口必须是同步的，3秒超时"指的是
	// trade → jifei 异步回调的发货接口链路，generateDeals 这种交易出口接口允许更长）。
	defaultTimeout = 30 * time.Second

	// maxResponseBytes 是错误日志保留的响应 body 上限，防巨型报文打爆日志。
	maxResponseBytes = 4096
)

// 哨兵 / typed 错误（Q68）。

// ErrCGWHTTPNon200 表示 jifei CGW 网关返回非 2xx 状态码。
var ErrCGWHTTPNon200 = errors.New("jifei cgw: http non-2xx")

// ErrCGWInvalidEnvelope 表示 CGW 响应 envelope 字段缺失 / JSON 解码失败。
var ErrCGWInvalidEnvelope = errors.New("jifei cgw: invalid envelope")

// CGWError 表示 jifei CGW 协议层业务错误（HTTP 200 但 returnCode != 0）。
//
// 上层适配层用 errors.As 提取 ReturnCode / ReturnMessage 后再做"降级 vs 透传 vs 重试"的策略选择
// （例如 Q56 退款响应分类映射）。
//
// **TransactionID 字段（v1.7.28 BUG-05 排障引入）**：每次 do() 调用生成的 32 字符 UUID hex，
// 注入到出向请求 X-QCloud-Transaction-ID header；CGWError 持有该值便于 ctl / 上层日志直接
// 拿到 transaction_id 报给 jifei 同事追查具体请求路径。
type CGWError struct {
	ReturnCode    int
	ReturnMessage string
	InterfaceName string
	EventID       int64  // v1.7.4 起改为 int64 — PDF §公共参数 eventId 类型 = int
	TransactionID string // v1.7.28 新增 — 32 字符 UUID hex，与 X-QCloud-Transaction-ID header 同值
}

// Error 实现 error 接口。
func (e *CGWError) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("jifei cgw business error: interface=%s eventId=%d transactionId=%s returnCode=%d returnMessage=%q",
		e.InterfaceName, e.EventID, e.TransactionID, e.ReturnCode, e.ReturnMessage)
}

// Client 是 trade → jifei CGW 出向客户端的对外接口（便于 mock）。
type Client interface {
	// GetPrice 调用 jifei CGW `qcloud.price.getPrice` 询价接口。
	//
	// 入参 req 已经是 CGW para 内层业务字段（OwnerUin / Uin / ResInfo[]）；
	// client 内部负责拼 framework 顶层 7 字段、HTTP header、错误码翻译。
	GetPrice(ctx context.Context, req *GetPriceRequest) (*GetPriceResponse, error)

	// GenerateDeals 调用 jifei CGW `qcloud.Deal.generateDeals` 下单接口。
	//
	// 入参 req 已经是 CGW para 内层业务字段（OwnerUin / Uin / GoodsInfos[]）；
	// 出参 PascalCase（与 PDF 第 8 页 PriceInfos / BigDealId / DealNames[] 严格对齐）。
	GenerateDeals(ctx context.Context, req *GenerateDealsRequest) (*GenerateDealsResponse, error)

	// GenerateDealsAndPay 调用 jifei CGW `qcloud.Deal.generateDealsAndPay` "下单并支付" 一体化接口
	// （迭代 8B-1.5）。
	//
	// 与 GenerateDeals 的关系：
	//   - 协议规范完全一致（jifei PDF §1 "协议规范：接口协议与下单接口 generateDeals 保持一致"）
	//   - 复用 GoodsInfo + 同样的 OwnerUin / Uin 字段，只在 para 多一个 AutoVoucher 标志位
	//   - 一次调用完成 "创建订单 + 同步支付"，跳过支付 URL，并触发业务侧 checkCreate / createResource
	//     回调（这是 jifei 文档中 **唯一可在购买环节即时返回 resourceId 的接口**）
	//
	// 与 PlaceOrder 双步链路相比，PlaceOrderAndPay 用于联调测试 / 自动化 e2e 场景：在测试代金券充足
	// 的环境下，无需真人浏览器付款即可让 trade -> jifei -> ctl.createResource 整条链路端到端跑通。
	GenerateDealsAndPay(ctx context.Context, req *GenerateDealsAndPayRequest) (*GenerateDealsAndPayResponse, error)

	// GetMidasEarmarking 调用 jifei CGW `qcloud.margin.getMidasEarmarking` "专款专用获取支付参数"
	// 接口（云 API 别名 CreatePayUrl）。
	//
	// 用途：双步购买链路的第二步 — trade.PlaceOrder 调 generateDeals 拿到 dealName 后，调用方
	// 再调本方法把 dealName 换成 Midas 收银台支付链接，由前端跳转 Midas 完成支付。jifei 异步
	// 收款后再回调 trade.createResource 完成发货。
	//
	// 协议参考：`/root/project/mono/.tmp/专款专用获取支付参数+-+qcloud.margin.getMidasEarmarking.pdf`
	// （5 页 / 2026-05-11 投放）。
	//
	// 错误语义同 GenerateDeals / GetPrice：HTTP 层 → ErrCGWHTTPNon200；envelope → ErrCGWInvalidEnvelope；
	// 业务层 returnCode != 0 → *CGWError。
	GetMidasEarmarking(ctx context.Context, req *GetMidasEarmarkingRequest) (*GetMidasEarmarkingResponse, error)

	// ModifyResourceStatus 调用 jifei CGW `qcloud.operation.ModifyResourceStatus` 资源状态变更接口
	// （D-2 切片引入 — 销毁链路用户主动入口）。
	//
	// 入参 req 已经是 CGW para 内层业务字段（ClientType / SubmitByUser / ReferenceID / ProductCode /
	// UIN / AppID / RegionID / PayMode / ResourcesParamSet[] / OperateName）；
	// 出参 PascalCase（与 PDF §1.1 第 6 页 operationSet[] / failedResources[] 对齐）。
	//
	// 协议参考：`/root/project/mono/.tmp/【订购关系建设】资源中心对外cgw接口定义.pdf` §1.1。
	//
	// 销毁链路调用方（trade.DeleteResource handler）传 OperateName=PRE_DESTROY；jifei 收到后立即
	// 同步返响应（status=0），异步通过 destroyResource 回调（lightvela.pass.destroyResource）
	// 推动 trade 实际销毁链路。
	ModifyResourceStatus(ctx context.Context, req *ModifyResourceStatusRequest) (*ModifyResourceStatusResponse, error)

	// GetDealsByKeyIndex 调用 jifei CGW `qcloud.Deal.getDealsByKeyIndex` 反查订单状态
	// （v1.7.32 引入，详见 .tmp/ctl-order-status-query-design.md §5.1）。
	//
	// 本期仅用 cond.dealName 单订单查询；未来扩展批量查询仅需填 cond.dealNameList 。
	// trade orderstatus logic 在本地中态订单才会调用本接口；B7 不可达降级交由调用方处理。
	GetDealsByKeyIndex(ctx context.Context, req *GetDealsByKeyIndexRequest) (*GetDealsByKeyIndexResponse, error)

	// OnlineRefund 调用 jifei CGW `qcloud.Deal.OnlineRefund` 线上退款接口
	// （trade-pass-refund-design.md v0.5 引入 — ctl→trade→jifei 主动退款链路）。
	//
	// 入参 req 已经是 CGW para 内层业务字段（UIN / AppID / FromConsole / GoodsInfo[]）；
	// 出参 PascalCase（与 doc §5 dealNames[] / bigDealIds[] 对齐）。
	//
	// 协议参考：`/root/project/mono/.tmp/线上退设备退款.doc`。
	//
	// 同步语义：业务成功 / 失败都立即返响应（returnCode + dealNames），不存在"中间 in_progress"
	// 中态；后续真实退款资金流转 + pass 隔离生效由 jifei 异步回 isolateResource 推动。
	// trade 出向 handler 定位为"无状态翻译层"，不写 trade_flow 行（设计稿 Q8b=b 拍板）。
	OnlineRefund(ctx context.Context, req *OnlineRefundRequest) (*OnlineRefundResponse, error)
}

// Options 是 Client 可选构造参数。
type Options struct {
	// HTTPClient 允许调用方注入自定义 HTTP client（用于注入 mTLS / 自定义 Transport / 测试）。
	// 不传则用默认 http.Client{Timeout: defaultTimeout}。
	HTTPClient *http.Client

	// EventIDProvider 允许测试注入确定性 eventId 生成器。生产留空走 randomEventIDInt64。
	// v1.7.4 起返回类型从 string → int64（PDF §公共参数 eventId 类型 = int）。
	EventIDProvider func() int64

	// NowProvider 允许测试注入确定性时间戳。生产留空走 time.Now。
	NowProvider func() time.Time

	// ===== 销毁链路（Q-D-SIG-1~6）专用 — 计费网关协议三件套 =====
	//
	// 与 "jifei-test" CGW 路由（询价 / 下单 / 支付） 严格区分：
	//   - 销毁链路调用 qcloud.operation.ModifyResourceStatus 接口要走 jifei 计费网关
	//     (test.api-gateway.billing.tencentyun.com / 9.139.137.40，sandbox-bj-7 经
	//     clgateway 直连 IP 81.71.196.13/v1/proxy/jifei-billing-apigw-test/resource-center/interface)
	//   - 计费网关协议**强制 HMAC-SHA256 签名**（参考 .tmp/jifei_pdf_txt/计费网关-接入和签名算法.txt）
	//   - trade 出向时在 envelope.interface.auth 注入 4 字段：appid / timestamp / nonce / signature
	//
	// 三个字段都为空时，本 client 仍按非签名路径工作（兼容询价 / 下单等老接口）；
	// 销毁链路调用 ModifyResourceStatus 时由调用方装配点（main.go）通过 Options 注入。

	// BillingAPIGWBaseURL 是 jifei 计费网关测试 / 现网入口 URL。
	// 不为空时，签名链路接口（当前仅 ModifyResourceStatus）走此 URL；其余 CGW 接口仍走
	// New() 的 baseURL 参数。空字符串时调用销毁链路接口会因 baseURL 为空报错。
	BillingAPIGWBaseURL string

	// BillingAppID 是计费网关分配的 appid（Q-D-SIG-3）。从 SSM + sops 注入到 trade env。
	BillingAppID string

	// BillingAppSecret 是计费网关分配的 appSecret（Q-D-SIG-3），HMAC-SHA256 签名密钥。
	// 从 SSM + sops 注入到 trade env，**禁止入 Git**。
	BillingAppSecret string

	// BillingNonceProvider 允许测试注入确定性 nonce。生产留空走 randomNonce。
	BillingNonceProvider func() string

	// SiteKind 是部署站点标识（v1.7.x 国际站接入新增，trade-international-site-design
	// v1.1 §3.1 A3）：
	//   - "intl" → 出向 envelope.interface.extraPara 自动注入 Site="2" / Language="en"
	//   - "cn" / 空 / 其他 → 不注入 Site / Language（omitempty 跳过，与现状一致）
	//
	// trade 内部一律使用 "cn" / "intl" 语义字面量（与 ctl/shadow/sandbox env 一致）；
	// **仅在** envelope 装配出向一处映射为 PDF 协议字面量 "1" / "2"（B-PROTO-5）。
	SiteKind string
}

type client struct {
	baseURL         string
	xQCloudUserID   string
	httpClient      *http.Client
	eventIDProvider func() int64
	nowProvider     func() time.Time

	// 销毁链路签名路径配置（Q-D-SIG-1~6）；空值表示未启用签名路径。
	billingBaseURL   string
	billingAppID     string
	billingAppSecret string
	billingNonceFn   func() string

	// siteKind 是 trade 内部部署站点语义字面量（"cn" / "intl"），由调用方通过 Options
	// 注入；在 makeExtraParaForSite 里被映射为 PDF 协议字面量 "1" / "2"（B-PROTO-5）。
	siteKind string
}

// New 构造 jifei CGW client。
//
// 参数：
//   - baseURL：CGW 网关入口 URL（v1.7.2 起一般是 clgateway 测试服务域名 +
//     `/v1/proxy/<route_id>/interfaces/interface.php`，由 clgateway upstream 段重写
//     Host header 后转发到真 jifei；本 client 不再主动注入 Host header）。
//   - xQCloudUserID：仅测试环境带（如 700000164995）；现网空字符串 → 不发送 header
//     （由部署侧出口 IP 鉴权）。
//   - opts...：可选 Options（HTTPClient / EventIDProvider / NowProvider）。
//
// baseURL / xQCloudUserID 会做 TrimSpace；空字符串保留（baseURL 空时 do() 报错；
// xQCloudUserID 空时 do() 跳过 header 注入）。
func New(baseURL, xQCloudUserID string, opts ...Options) Client {
	c := &client{
		baseURL:         strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		xQCloudUserID:   strings.TrimSpace(xQCloudUserID),
		httpClient:      &http.Client{Timeout: defaultTimeout},
		eventIDProvider: randomEventIDInt64,
		nowProvider:     time.Now,
		billingNonceFn:  randomNonce,
	}
	if len(opts) > 0 {
		o := opts[0]
		if o.HTTPClient != nil {
			c.httpClient = o.HTTPClient
		}
		if o.EventIDProvider != nil {
			c.eventIDProvider = o.EventIDProvider
		}
		if o.NowProvider != nil {
			c.nowProvider = o.NowProvider
		}
		c.billingBaseURL = strings.TrimRight(strings.TrimSpace(o.BillingAPIGWBaseURL), "/")
		c.billingAppID = strings.TrimSpace(o.BillingAppID)
		c.billingAppSecret = strings.TrimSpace(o.BillingAppSecret)
		if o.BillingNonceProvider != nil {
			c.billingNonceFn = o.BillingNonceProvider
		}
		c.siteKind = strings.ToLower(strings.TrimSpace(o.SiteKind))
	}
	return c
}

// envelope 是 CGW framework 顶层结构（请求 / 响应共用）。
//
// **请求方向（v1.7.4 起 PDF §公共参数 严格对齐）**：
//   - Version：协议版本号 "1.0"
//   - ComponentName：调用方模块名 = "lightvela"
//   - Caller：调用方模块名 = "lightvela"（与 ComponentName 同值；PDF 描述完全相同但 jifei
//     协议要求两个字段都必填，AI 不合并）
//   - EventID：随机 int 事件号（PDF 类型 int；v1.7.4 起 string hex → int64）
//   - Timestamp：毫秒时间戳（PDF 示例 1504077981203 13 位，与现仓 UnixMilli 兼容）
//   - SeqID：**已删除**（PDF §公共参数 注释 "业务调用计费时不用传递"，v1.7.4 协议校准）
//   - Interface：双层结构 {interfaceName, para}
//
// **响应方向**：jifei 填 ReturnCode / ReturnMessage / ReturnValue；ComponentName / EventID
// 通常被回显，client 不强校验。
//
// **v1.7.14 B9 修正 Version 字段类型**：jifei 实际响应中 `version` 是数字类型（如 `1`），
// 而 PDF §公共参数 + trade 出向请求中 `version` 是字符串类型（如 `"1.0"`）。这是 jifei
// 协议实际不对称：请求/响应同名字段类型不一致。trade jifeiclient 用 json.RawMessage
// 兼容两个方向 — 出向时 do() 把 CGWVersion 字符串 marshal 为 RawMessage 写入，
// 入向时直接接受任何 JSON 类型（client 不消费 Version 业务语义，仅做 trace 调试）。
type envelope struct {
	Version       json.RawMessage `json:"version,omitempty"`
	ComponentName string          `json:"componentName,omitempty"`
	Caller        string          `json:"caller,omitempty"`  // v1.7.4 新增 — PDF §公共参数 必填
	EventID       int64           `json:"eventId,omitempty"` // v1.7.4 string → int64
	Timestamp     int64           `json:"timestamp,omitempty"`
	Interface     *interfaceBlock `json:"interface,omitempty"`

	// 响应字段
	ReturnCode    *int            `json:"returnCode,omitempty"`
	ReturnMessage string          `json:"returnMessage,omitempty"`
	ReturnValue   json.RawMessage `json:"returnValue,omitempty"`
	// v1.7.15 B10: jifei 实际响应 envelope 中业务 payload 在顶层 `data` 字段
	// (与 returnValue 平级), 而不是嵌套在 returnValue 里. PDF §公共参数 / 出参 schema
	// 描述的 returnValue 实际是数字 (与 returnCode 一致, 仅成功标志位); 真正的业务
	// 数据载荷由顶层 data 字段携带 (实测 jifei 询价响应:
	//   {returnCode:0, returnValue:0, returnMessage:"ok", data:[{price:4900,...}]}).
	// trade jifeiclient 用 RawMessage 透传 data, 由 do() 反序列化到 outResp.
	Data json.RawMessage `json:"data,omitempty"`
}

// respEnvelope 是 jifei CGW 响应方向 envelope 的解码目标（v1.7.29 引入）。
//
// **与 envelope（请求方向）的差异 / 为什么单独类型**：
//
// jifei CGW 的请求 envelope 与响应 envelope 字段集大体一致，但 **`interface` 字段在错误响应里
// 会从对象降级为字符串字面量**（实测 returnCode=100000 "param error" 响应里
// `"interface":"qcloud.operation.ModifyResourceStatus"`），与请求方向 `interfaceBlock` struct
// 类型不兼容；如果继续复用 envelope 解响应，json.Unmarshal 会因 interface 字段类型不匹配整体
// 报错，把真正的 returnCode / returnMessage 业务错误信息一起吞掉变成 ErrCGWInvalidEnvelope，
// 让上层无法 errors.As 提取 *CGWError 做后续分类（重试 / 透传 / 降级）。
//
// 解决方案：响应方向单独定义 respEnvelope，把 `interface` 字段类型放宽为 json.RawMessage（仅
// 占位，client 不消费响应方向的 interface 内容；业务 payload 走顶层 `data`，业务状态走顶层
// `returnCode` / `returnMessage`），这样无论 jifei 把 interface 降级成 string、对象、null 还是
// 完全省略，都不阻塞业务错误透出。
type respEnvelope struct {
	Version       json.RawMessage `json:"version,omitempty"`
	ComponentName string          `json:"componentName,omitempty"`
	Caller        string          `json:"caller,omitempty"`
	EventID       int64           `json:"eventId,omitempty"`
	Timestamp     int64           `json:"timestamp,omitempty"`

	// Interface 字段在响应方向不消费，仅占位以兼容 jifei 错误响应里 string vs object 的
	// 类型不一致；用 RawMessage 接收任意 JSON 形态。
	Interface json.RawMessage `json:"interface,omitempty"`

	ReturnCode    *int            `json:"returnCode,omitempty"`
	ReturnMessage string          `json:"returnMessage,omitempty"`
	ReturnValue   json.RawMessage `json:"returnValue,omitempty"`
	Data          json.RawMessage `json:"data,omitempty"`
}

// interfaceBlock 是 framework 内层 interface 字段。
//
// **Auth 字段（Q-D-SIG-1~6 销毁链路签名）**：仅当走 jifei 计费网关签名路径
// （ModifyResourceStatus）时填充；询价 / 下单等 jifei-test CGW 路径保持空（omitempty 跳过）。
//
// **ExtraPara 字段（v1.7.29 修复：销毁链路 ownerUin 协议遗漏）**：仅当走资源中心 CGW 接口
// （ModifyResourceStatus / ModifyResourceAttribute / NoticeResourceAttributeChange 三族）时填充；
// 这一族接口的 envelope.interface 层级独立有 `extraPara.ownerUin` 字段（PDF
// `【订购关系建设】资源中心对外cgw接口定义.md` §1.1 / §1.2 / §1.3 示例 line 167-168 / 539-540 /
// 910-911 三处明确给出），与下单/询价的 `para.ownerUin` 平铺路径不同；jifei 网关侧硬校验
// `extraPara.ownerUin or extraPara.site` 二选一非空，缺则返 returnCode=100000
// "param error,need ownerUin or site"。其它接口（询价 / 下单 / 支付 / 专款专用）此字段保持
// nil（omitempty 跳过），不影响出向 wire。
//
// **签名 base 影响**（仅签名链路）：signBillingEnvelope Step 1 把整个 iface（去 auth）做 md5
// 作为 req 字段；ExtraPara 序列化进 wire 即自然进 md5 base，与协议"去 auth"语义一致；
// jifei 侧重算签名时也包含 extraPara，双方 base 字节相同 → 签名匹配。
type interfaceBlock struct {
	InterfaceName string          `json:"interfaceName"`
	ExtraPara     *extraParaBlock `json:"extraPara,omitempty"`
	Para          json.RawMessage `json:"para"`
	Auth          *billingAuth    `json:"auth,omitempty"`
}

// extraParaBlock 是资源中心 CGW 接口（ModifyResourceStatus 等）envelope.interface.extraPara
// 子对象，承载 ownerUin / site / language 三个跨接口公共字段（PDF 协议示例统一位置）。
//
// v1.7.x 国际站接入（trade-international-site-design v1.1 §3.1 A2/A3）扊展：
//   - OwnerUin：在销毁链路（ModifyResourceStatus）必填；其他接口可为空（omitempty跳过）。
//   - Site：站点标识。**PDF 协议字面量**："1"=国内 / "2"=国外（B-PROTO-5）；空字符串
//     不序列化（omitempty），降级到 jifei 默认行为（“业务区分不了可以不传”）。
//     **禁止**将 trade 内部 SiteKind 字面量 `"cn"` / `"intl"` 直接赋值给本字段——
//     会被 jifei 网关按错误码 100000 拒掉。
//   - Language：语言标识。常见取值 "zh"/"en"；空字符串不序列化。
type extraParaBlock struct {
	// OwnerUin 是资源所有者主账号 uin（与 para.uin 同值）。omitempty 跟随 v1.7.x
	// 接入后的使用范围扩展（询价 / 下单接口不填 OwnerUin，仅填 Site/Language）。
	OwnerUin string `json:"ownerUin,omitempty"`

	// Site 是站点标识（v1.7.x 国际站接入新增）：
	//   - "1" → 国内（PDF 协议字面量）
	//   - "2" → 国外（PDF 协议字面量）
	//   - ""  → omitempty 跳过，降级到 jifei 默认
	Site string `json:"site,omitempty"`

	// Language 是语言标识（v1.7.x 国际站接入新增）：
	//   - "zh" / "en"
	//   - "" → omitempty 跳过，降级到 jifei 默认
	Language string `json:"language,omitempty"`
}

// billingAuth 是 jifei 计费网关 envelope.interface.auth 4 字段。
//
// 协议参考：.tmp/jifei_pdf_txt/计费网关-接入和签名算法.txt §接口参数说明 / §签名算法。
// 拼接 stringA 时按字段名 ASCII 字典序：appid, nonce, req(=md5(interface 去 auth)), timestamp。
type billingAuth struct {
	AppID     string `json:"appid"`
	Timestamp string `json:"timestamp"` // 秒级时间戳字符串
	Nonce     string `json:"nonce"`
	Signature string `json:"signature"` // HMAC-SHA256 hex 大写
}

// do 是所有 CGW 请求的统一执行入口。
//
// 步骤：
//  1. 把业务字段 para 序列化（para 已经是上层封装好的 *Request struct）
//  2. 拼 framework envelope（Version / ComponentName / Caller / EventID / Timestamp / Interface）
//     v1.7.4 起：seqId 不传；componentName == caller == "lightvela"；eventId int64
//  3. 发起 POST，注入 `x-qcloud-user-id` header（仅当 xQCloudUserID 非空 — 测试环境带，
//     现网由部署侧出口 IP 鉴权不带）；**不再注入 Host header**（v1.7.2 Q-INT-11=b 拍板后
//     改由 clgateway upstream 段重写）
//  4. 解析响应 envelope，按 returnCode 分类：
//     - HTTP 非 2xx → 包 ErrCGWHTTPNon200
//     - returnCode == nil 或 envelope 解码失败 → 包 ErrCGWInvalidEnvelope
//     - returnCode != 0 → 返回 *CGWError
//     - returnCode == 0 → 把 returnValue 反序列化到 outResp（调用方传的 *Response struct）
func (c *client) do(
	ctx context.Context,
	interfaceName, componentName string,
	para any,
	outResp any,
) error {
	return c.doWithRoute(ctx, interfaceName, componentName, nil, para, outResp, false)
}

// doWithRoute 是 do() 的扩展形态：
//   - signed=false → 走 c.baseURL（jifei-test CGW 路由，不签名，询价 / 下单 / 支付）
//   - signed=true  → 走 c.billingBaseURL（jifei 计费网关，HMAC-SHA256 签名，销毁链路）
//
// 销毁链路调用方（modifyresourcestatus.go）通过 doSigned() / doSignedWithExtra() 调用本方法。
func (c *client) doSigned(
	ctx context.Context,
	interfaceName, componentName string,
	para any,
	outResp any,
) error {
	return c.doWithRoute(ctx, interfaceName, componentName, nil, para, outResp, true)
}

// doSignedWithExtra 是 doSigned 的扩展形态：除了 doSigned 的签名路径外，额外允许调用方注入
// `envelope.interface.extraPara` 子对象（资源中心 CGW 三族接口的硬协议要求，详见
// interfaceBlock.ExtraPara 字段注释）。extraPara 为 nil 时行为与 doSigned 完全一致。
func (c *client) doSignedWithExtra(
	ctx context.Context,
	interfaceName, componentName string,
	extraPara *extraParaBlock,
	para any,
	outResp any,
) error {
	return c.doWithRoute(ctx, interfaceName, componentName, extraPara, para, outResp, true)
}

// applySiteKindToExtraPara 按 client.siteKind 给出向 envelope.interface.extraPara 注入
// Site / Language 协议字面量（v1.7.x 国际站接入 A2/A3 / trade-international-site-design
// v1.1 §3.1 / B-PROTO-5）。
//
// 设计要点：
//   - **siteKind → PDF 协议字面量映射**：仅在本处发生一次。trade 内部其他位置一律
//     使用 "cn" / "intl" 语义字面量。
//   - siteKind == "intl" → Site="2" Language="en"
//   - 其他（含 "cn" / 空 / 非法值）→ 保持传入的 extraPara 不动（与现状一致）
//   - **调用方 nil 不传 extraPara 的处理**：
//   - 如 siteKind == "intl"，自动创建一个只带 Site / Language 的新 extraParaBlock
//     （OwnerUin 留空，omitempty 跳过）
//   - 如 siteKind != "intl"，仍返回 nil，interfaceBlock.ExtraPara 仍会被 omitempty 跳过
//   - **对 modifyresourcestatus 路径的兼容**：其调用方传了 extraPara{OwnerUin: ...}，
//     本函数 mutate 同一对象的 Site / Language 字段（不拷贝），OwnerUin 保留不变。
//     该 mutation 发生在 paraBytes 完成之后、envelope marshal 之前，与签名链路
//     的 md5(iface) 计算顺序一致。
//
// **负面保障**：本函数绝对不会在出向 wire 上写出 `"site":"intl"` 这样的 trade
// 内部字面量，D1 单测会对此事实加反向断言。
func (c *client) applySiteKindToExtraPara(extraPara *extraParaBlock) *extraParaBlock {
	if c.siteKind != "intl" {
		// cn / 空 / 非法值：维持入参原状（含 nil），不污染老接口出向 wire
		return extraPara
	}
	if extraPara == nil {
		extraPara = &extraParaBlock{}
	}
	extraPara.Site = "2" // PDF 协议字面量：2 = 国外
	extraPara.Language = "en"
	return extraPara
}

func (c *client) doWithRoute(
	ctx context.Context,
	interfaceName, componentName string,
	extraPara *extraParaBlock,
	para any,
	outResp any,
	signed bool,
) error {
	targetURL := c.baseURL
	if signed {
		targetURL = c.billingBaseURL
		if targetURL == "" {
			return fmt.Errorf("jifeiclient: BillingAPIGWBaseURL is required for signed interface %s", interfaceName)
		}
		if c.billingAppID == "" || c.billingAppSecret == "" {
			return fmt.Errorf("jifeiclient: BillingAppID/BillingAppSecret are required for signed interface %s", interfaceName)
		}
	} else if targetURL == "" {
		return fmt.Errorf("jifeiclient: baseURL is required")
	}

	paraBytes, err := json.Marshal(para)
	if err != nil {
		return fmt.Errorf("jifeiclient: marshal para: %w", err)
	}

	// v1.7.x 国际站接入（A2/A3）：按 client.siteKind 给 extraPara 注入 Site / Language
	// 协议字面量（B-PROTO-5）。调用方未传 extraPara 时若 siteKind="intl" 自动 new 一个；
	// 调用方传了 extraPara（仅 modifyresourcestatus 走 doSignedWithExtra）时 mutate 同对象
	// 的 Site / Language 字段。
	extraPara = c.applySiteKindToExtraPara(extraPara)

	eventID := c.eventIDProvider()
	// v1.7.14 B9: Version 字段从 string → json.RawMessage 兼容 jifei 响应中数字类型；
	// 出向请求时 marshal CGWVersion ("1.0") 为带引号的 JSON 字符串字面量写入 wire。
	versionRaw, _ := json.Marshal(CGWVersion)
	iface := &interfaceBlock{
		InterfaceName: interfaceName,
		ExtraPara:     extraPara,
		Para:          paraBytes,
	}
	env := envelope{
		Version:       versionRaw,
		ComponentName: componentName,
		Caller:        componentName, // v1.7.4 PDF §公共参数 caller 与 componentName 同值
		EventID:       eventID,
		Timestamp:     c.nowProvider().UnixMilli(),
		Interface:     iface,
	}

	// 计费网关签名（Q-D-SIG-1~6）：在 envelope.interface.auth 注入 4 字段。
	// 算法详见 signBillingEnvelope —— 必须在 marshal envelope 之前完成签名注入。
	if signed {
		nowSec := c.nowProvider().Unix()
		nonce := c.billingNonceFn()
		auth, err := signBillingEnvelope(c.billingAppID, c.billingAppSecret, nowSec, nonce, iface)
		if err != nil {
			return fmt.Errorf("jifeiclient: sign billing envelope (interface=%s): %w", interfaceName, err)
		}
		iface.Auth = auth
	}

	bodyBytes, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("jifeiclient: marshal envelope: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return fmt.Errorf("jifeiclient: build request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	// v1.7.4：x-qcloud-user-id 仅测试环境带（uin = 700000164995）；现网空字符串 → 不发 header
	// （由部署侧出口 IP 鉴权）。Host header 不再主动注入 — 由 clgateway upstream 段重写。
	if c.xQCloudUserID != "" {
		req.Header.Set(CGWUserIDHeader, c.xQCloudUserID)
	}
	// v1.7.28 BUG-05 排障：注入 X-QCloud-Transaction-ID (32 字符 UUID hex) + X-QCloud-Component-ID
	// header 让 jifei 计费侧能基于 transaction_id 在内部链路追踪系统反查请求路径，便于联调期
	// 业务方报具体 transaction_id 给 jifei 同事追查 (例如 700002 "rc check failed" 的 sp 内置
	// 校验失败原因)。参考 lighthouse_devops/lighthouse/patching/patching_lightpower.py 范式。
	transactionID := randomTransactionID()
	req.Header.Set(CGWTransactionIDHeader, transactionID)
	req.Header.Set(CGWComponentIDHeader, CGWComponentIDValue)

	// v1.7.28 BUG-05/06 联调期临时 dump：把出向 envelope 完整 body 打到日志，便于
	// 排障 jifei 700002 sp 校验异常时反查 trade 实际发的字段集是否符合 PDF 协议。
	// 联调结束后须移除（grep "[jifei-out]" 删行 + 移除 log import）。
	log.Printf("[jifei-out] interface=%s eventId=%d transactionId=%s body=%s",
		interfaceName, eventID, transactionID, string(bodyBytes))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("jifeiclient: http do (interface=%s eventId=%d transactionId=%s): %w",
			interfaceName, eventID, transactionID, err)
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)
	// v1.7.28 BUG-05/06 联调期临时 dump：把 jifei 返回 body 完整打到日志，便于排障。
	log.Printf("[jifei-in] interface=%s eventId=%d transactionId=%s status=%d body=%s",
		interfaceName, eventID, transactionID, resp.StatusCode, string(respBytes))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("jifeiclient: %w: status=%d interface=%s eventId=%d transactionId=%s body=%s",
			ErrCGWHTTPNon200, resp.StatusCode, interfaceName, eventID, transactionID, truncate(respBytes, maxResponseBytes))
	}

	// v1.7.29 修复（Q2 envelope 解析鲁棒性）：响应方向用 respEnvelope 单独类型解码，
	// 不再复用 envelope（请求方向用），原因：jifei CGW 错误响应里 `interface` 字段会从对象
	// 降级为字符串字面量（实测 returnCode=100000 "param error" 响应中
	// `"interface":"qcloud.operation.ModifyResourceStatus"`），与请求方向 `interfaceBlock`
	// struct 类型不兼容会触发 json unmarshal 失败，把真正的业务错误（returnCode/Message）吞掉
	// 变成 ErrCGWInvalidEnvelope。respEnvelope 用 json.RawMessage 接收 interface 字段、
	// 不解析其内部结构（trade 也不消费响应方向的 interface），从而把 returnCode 透出来。
	var respEnv respEnvelope
	if err := json.Unmarshal(respBytes, &respEnv); err != nil {
		return fmt.Errorf("jifeiclient: %w: unmarshal envelope (interface=%s eventId=%d transactionId=%s body=%s): %v",
			ErrCGWInvalidEnvelope, interfaceName, eventID, transactionID, truncate(respBytes, maxResponseBytes), err)
	}
	if respEnv.ReturnCode == nil {
		return fmt.Errorf("jifeiclient: %w: returnCode missing (interface=%s eventId=%d transactionId=%s body=%s)",
			ErrCGWInvalidEnvelope, interfaceName, eventID, transactionID, truncate(respBytes, maxResponseBytes))
	}
	if rc := *respEnv.ReturnCode; rc != 0 {
		return &CGWError{
			ReturnCode:    rc,
			ReturnMessage: respEnv.ReturnMessage,
			InterfaceName: interfaceName,
			EventID:       eventID,
			TransactionID: transactionID,
		}
	}

	if outResp == nil {
		return nil
	}
	// v1.7.15 B10: 业务 payload 从 envelope.data (顶层) 反序列化, 不是 returnValue.
	// 详见 envelope.Data 字段注释.
	if len(respEnv.Data) == 0 || string(respEnv.Data) == "null" {
		// data 为空但 returnCode == 0 — 协议上视为成功无 payload, 调用方处理 zero value.
		return nil
	}
	if err := json.Unmarshal(respEnv.Data, outResp); err != nil {
		return fmt.Errorf("jifeiclient: %w: unmarshal data (interface=%s eventId=%d): %v",
			ErrCGWInvalidEnvelope, interfaceName, eventID, err)
	}
	return nil
}

// randomEventIDInt64 生成 [1, 2^31) 范围的随机正整数作为默认 eventId（v1.7.4）。
//
// 取 [1, 2^31) 范围而非 [1, 2^63)：避开 jifei 网关层可能存在的 int32 解析（PDF §公共参数
// 仅写 "类型 int"，未明确 32/64 — 谨慎兼容）。crypto/rand 失败时退化为基于纳秒时间戳的
// 伪随机值（不会 panic — eventId 全局唯一即可，极小概率重复对调用链路无副作用）。
func randomEventIDInt64() int64 {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return time.Now().UnixNano() & 0x7fffffff
	}
	v := int64(b[0])<<24 | int64(b[1])<<16 | int64(b[2])<<8 | int64(b[3])
	v &= 0x7fffffff // 强制正数（最高位清 0），兼容 int32
	if v == 0 {
		v = 1 // 避免与 envelope.EventID == 0 的 zero value 混淆
	}
	return v
}

// signBillingEnvelope 按 jifei 计费网关协议算签名并构造 interface.auth 字段。
//
// 协议参考：.tmp/jifei_pdf_txt/计费网关-接入和签名算法.txt §签名算法。
//
// 4 步算法：
//  1. req = strtoupper(md5(interface JSON "去 auth" 后的 utf8 字节流))
//     注：传入的 iface 此时 Auth 还是 nil，json.Marshal 时 omitempty 自动跳过；
//     等本函数返回 *billingAuth 后由调用方再 iface.Auth = auth 注入。
//  2. 把 4 个参数 (appid, nonce, req, timestamp) 按字段名 ASCII 字典序拼成
//     key1=value1&key2=value2 形式 = stringA。
//  3. stringB = stringA + "&appSecret=" + appSecret。
//  4. signature = strtoupper(hmac_sha256(stringB, appSecret) hex)。
//
// 字段位置：返回的 *billingAuth 由调用方写入 envelope.interface.auth（与 interfaceName /
// para 平级），而非顶层 envelope.auth。
func signBillingEnvelope(appID, appSecret string, timestampSec int64, nonce string, iface *interfaceBlock) (*billingAuth, error) {
	if iface == nil {
		return nil, fmt.Errorf("signBillingEnvelope: nil interface block")
	}
	if appID == "" || appSecret == "" {
		return nil, fmt.Errorf("signBillingEnvelope: empty appID or appSecret")
	}
	if nonce == "" {
		return nil, fmt.Errorf("signBillingEnvelope: empty nonce")
	}

	// Step 1: req = upper(md5(interface JSON utf8 - auth))
	// 此时 iface.Auth == nil，json.Marshal 走 omitempty 跳过 auth 字段，与协议
	// "去 auth" 语义一致；调用方在拿到本函数返回的 *billingAuth 后再注入。
	ifaceBytes, err := json.Marshal(iface)
	if err != nil {
		return nil, fmt.Errorf("signBillingEnvelope: marshal interface: %w", err)
	}
	md5Sum := md5.Sum(ifaceBytes)
	req := strings.ToUpper(hex.EncodeToString(md5Sum[:]))

	timestamp := strconv.FormatInt(timestampSec, 10)

	// Step 2: stringA = ASCII 字典序拼接 key=value
	params := map[string]string{
		"appid":     appID,
		"nonce":     nonce,
		"req":       req,
		"timestamp": timestamp,
	}
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+params[k])
	}
	stringA := strings.Join(parts, "&")

	// Step 3: stringB = stringA + "&appSecret=" + appSecret
	stringB := stringA + "&appSecret=" + appSecret

	// Step 4: signature = upper(hmac_sha256(stringB, appSecret) hex)
	mac := hmac.New(sha256.New, []byte(appSecret))
	mac.Write([]byte(stringB))
	signature := strings.ToUpper(hex.EncodeToString(mac.Sum(nil)))

	return &billingAuth{
		AppID:     appID,
		Timestamp: timestamp,
		Nonce:     nonce,
		Signature: signature,
	}, nil
}

// randomNonce 生成 16 字符 hex 随机 nonce（默认 BillingNonceProvider）。
// 8 字节随机源即可满足 jifei nonce 唯一性需求；crypto/rand 失败退化为纳秒时间戳 hex。
func randomNonce() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(b[:])
}

// randomTransactionID 生成 32 字符 hex (16 bytes 随机) 作为 X-QCloud-Transaction-ID header 值
// (v1.7.28 BUG-05 排障引入). 参考 lighthouse_devops patching/patching_lightpower.py 范式 —
// jifei 计费侧能基于 transaction_id 在内部链路追踪系统反查具体请求路径, 排障时业务方
// 报具体 transaction_id 给 jifei 同事即可定位 (避免双方手工对齐请求时间戳).
//
// 用 16 字节 (128 bit) 随机源, hex 编码后正好 32 字符, 与 lightpower 透传上游 transaction_id
// 的格式一致 (32 字符 UUID hex 去 dashes). crypto/rand 失败时退化为 eventId hex (极小概率,
// 不会 panic — transaction_id 极小概率重复对追踪粒度无致命影响).
func randomTransactionID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// 退化路径: 用 eventId 派生一个固定长度 hex (虽然不是真随机但保证非空 + 32 字符)
		fallback := time.Now().UnixNano()
		for i := 0; i < 16; i++ {
			b[i] = byte(fallback >> (uint(i%8) * 8))
		}
	}
	return hex.EncodeToString(b[:])
}

func truncate(b []byte, max int) string {
	if len(b) <= max {
		return string(b)
	}
	return string(b[:max]) + "...(truncated)"
}
