// trade pass 退款链路（trade-pass-refund-design.md v0.5）出向接口实现。
//
// 接口名：qcloud.Deal.OnlineRefund
// 协议正本：/root/project/mono/.tmp/线上退设备退款.doc
//
// 路径分类：与 ModifyResourceStatus 同属"jifei 计费网关签名链路"（走 c.billingBaseURL，
// HMAC-SHA256 签名 envelope.interface.auth），不走询价 / 下单的 jifei-test CGW 路径。
//
// 业务定位（设计稿 §2 时序图 + Q8b=b 拍板）：trade 出向"无状态翻译层"——
//   - 仅负责把入参拼成 jifei OnlineRefund 协议字段集 + 透传出向 + 翻译响应
//   - **不写 trade_flow 行**（Q8b=b：jifei OnlineRefund 是同步接口，业务幂等 / 并发抑制
//     完全交由 jifei 协议层本身 + 后续 jifei 异步回 isolateResource 的退费分支抢占式幂等
//     `flow_type='isolate_resource' + dealName` 兜底，无需 trade 端额外抢占）
//
// 错误语义（与 ModifyResourceStatus / GenerateDeals 完全一致）：
//   - nil 入参 / 必填字段缺失 → client-side errInvalidArg（不出请求）
//   - HTTP 层失败（连接 / 超时 / 非 2xx）→ ErrCGWHTTPNon200 / 原始 net error
//   - 协议层失败（HTTP 200 但 returnCode != 0）→ *CGWError；调用方按 PDF 错误码分类处理
//   - 101103：订单尚未发货完成，需重试（jifei 通用错误码）
//   - "allowReturn != 1"：sp_xxx 业务侧 queryResource 拒绝退款（业务规则）
//   - HTTP 200 但 envelope 解析失败 → ErrCGWInvalidEnvelope
package jifeiclient

import (
	"context"
)

// OnlineRefundRequest 是 jifei CGW `qcloud.Deal.OnlineRefund` 退款接口入参（para 内层）。
//
// 协议正本字段表（doc §4.1）：
//
//	uin           String   必填  订单所有者 / 资源所有者主账号（若子账号无财务权限，可到控制台账号管理金融权限）
//	appId         Integer  必填  云平台应用 ID，与 uin 一一对应
//	fromConsole   Integer  可选  1=来自控制台（trade 走后台 admin 路径，固定传 1）
//	clientIp      String   可选  用户客户端 IP，用于 CAM 的 IP 级鉴权
//	token         String   可选  用户 CAM token，用于 CAM 鉴权
//	goodsInfo     Object   必填  商品信息；以 sub_product_code 字符串（如 sp_lighthouse）作为 map key
//
// **goodsInfo 字段形态特殊性（与 ModifyResourceStatus 的差异）**：
//
// jifei 协议规定 goodsInfo 是**以 sub_product_code 字符串作为 key 的动态对象**
// （doc §4.2 请求示例：`"sp_cbs": {...}` / trade 业务侧对应是 `"sp_lighthouse": {...}`），
// 而非 ModifyResourceStatus 的 `resourcesParamSet: [{subProductCode, resourceIds}]` 数组形态。
// Go 端必须用 `map[string]OnlineRefundGoodsEntry` 序列化，不能用 fixed struct field——
// 否则未来扩展 sp_lighthouse_pass / sp_lighthouse_xx 等子产品时无法兼容。
//
// **设计自决**（与现有 5 个出向接口范式严格对齐）：
//
//   - PascalCase struct field + camelCase JSON tag（jifei CGW 协议层对字段名大小写不敏感，wire
//     上接受两种；本 client 沿 PascalCase 范式保持仓库内一致）
//   - **持有 `OwnerUin` 字段并中转到 envelope.interface.extraPara.ownerUin**
//     （2026-06-23 v0.5.1 联调修复 — 与 v1.7.29 销毁链路同款的 jifei 网关硬校验）：
//     设计稿 v0.5 初版判断"Deal 接口族不需要 extraPara"是**协议理解错误**——sandbox-bj-7
//     现网实测 jifei 网关返 `returnCode=100000, returnMessage="param error,need ownerUin
//     or site"`，与 ModifyResourceStatus 当初 v1.7.29 踩过的坑（client.go:434-439 注释）
//     完全同款。jifei CGW 网关层做的 `extraPara.ownerUin or extraPara.site` 二选一校验
//     是**跨接口族通用**的，不分 `qcloud.Deal.*` / `qcloud.operation.*` 接口族。
//     OwnerUin 字段 `json:"-"` 跳过 para wire 序列化，由 OnlineRefund() 提取后中转到
//     envelope.interface.extraPara 路径（与 ModifyResourceStatus 一比一同款）。
//   - FromConsole / ClientIP / Token 用 omitempty——为零值时 jifei 走默认行为（doc §4.1
//     "1，来自控制台" 表示后台 admin 入口；trade 在调用方装配点固定传 1）
//
// **本期 Q8=a 拍板**：trade 不预校验退款金额，也不传 ignoreQuota / extParam / activityId 等
// 业务扩展字段——这些字段保留协议字面量但不在 Request 结构里暴露（避免 trade 内部多余配置）。
type OnlineRefundRequest struct {
	UIN   string `json:"uin"`
	AppID int64  `json:"appId"`

	// OwnerUin 是资源所有者主账号 uin，jifei 网关侧硬校验
	// `envelope.interface.extraPara.ownerUin or .site` 二选一非空（与 ModifyResourceStatus
	// v1.7.29 修复同款）。本字段不序列化进 para wire（`json:"-"`），由 OnlineRefund()
	// 提取后中转到 envelope.interface.extraPara 路径。trade pass 退款链路调用方
	// （ctl.RefundPass → trade.RefundResource handler）固定传 entity.Uin（ctl pass 单 uin
	// 表，uin == owner_uin）。
	OwnerUin string `json:"-"`

	FromConsole int    `json:"fromConsole,omitempty"`
	ClientIP    string `json:"clientIp,omitempty"`
	Token       string `json:"token,omitempty"`

	// GoodsInfo 是 jifei 退款"商品信息"对象，map key 必须是 sub_product_code 字符串
	// （如 "sp_lighthouse"），value 是该 sub_product_code 下的退款配置 + 资源列表。
	//
	// **设计稿 §3 拍板**：本期单条退款（Q3=a），trade 在调用方装配点固定塞一个 entry：
	//   {"sp_lighthouse": {PayMode: 1, RegionID: 1, ResourceIDList: [<passID>]}}
	// trade_bundle_definition.sub_product_code 字段反查得到 key 名（trade 内部约定）。
	GoodsInfo map[string]OnlineRefundGoodsEntry `json:"goodsInfo"`
}

// OnlineRefundGoodsEntry 是 goodsInfo[sub_product_code] 的单元素（doc §4.1）。
//
// 字段说明：
//
//	payMode         Integer        必填  付费模式：1=预付费；后付费不能退费（trade pass 全部走 1）
//	regionId        Integer        必填  地域 ID（Lighthouse=1 广州；同 Q41）
//	resourceIdList  Array<String>  必填  退费资源列表；单次最多 100 个（Q3=a 单条退款时长度恒 1）
//	activityId      String         可选  活动 ID，仅用于 EMR 退 cvm 等场景；trade pass 不传
//	ignoreQuota     Bool           可选  忽略配额检查，仅 eip 等特殊场景；trade pass 不传
//	extParam        Object         可选  业务自定义透传字段，会在隔离时透传给业务侧；trade pass 不传
//	productCode     String         可选  非必传，调业务 queryResource 时会携带；本期不传
//	subProductCode  String         可选  非必传，调业务 queryResource 时会携带；本期不传
//
// **本期 trade 仅传 PayMode / RegionID / ResourceIDList 三个必填字段**，其余字段
// 用 omitempty 跳过（保留 struct field 以便未来扩展）。
type OnlineRefundGoodsEntry struct {
	PayMode        int      `json:"payMode"`
	RegionID       int      `json:"regionId"`
	ResourceIDList []string `json:"resourceIdList"`

	// 以下字段保留协议字面量但本期 trade 不传，为零值时由 omitempty 跳过序列化。
	ActivityID     string         `json:"activityId,omitempty"`
	IgnoreQuota    bool           `json:"ignoreQuota,omitempty"`
	ExtParam       map[string]any `json:"extParam,omitempty"`
	ProductCode    string         `json:"productCode,omitempty"`
	SubProductCode string         `json:"subProductCode,omitempty"`
}

// OnlineRefundResponse 是 jifei CGW returnValue/data 反序列化目标（doc §5 / §6.1）。
//
// 协议返回 payload（doc §5）：
//
//	{
//	  "dealNames":  ["<deal name 1>", ...],    // 本次退款生成的退款订单号列表
//	  "bigDealIds": ["<big deal id 1>", ...]   // 本次退款生成的退款大订单号列表
//	}
//
// **本期消费策略**（设计稿 §3 + §6 错误处理表）：
//
//   - HappyPath（returnCode=0）：trade 出向 handler 收到本响应后**仅透传 dealNames /
//     bigDealIds 给 ctl**，不做任何持久化、不写 trade_flow 行（Q8b=b 无状态翻译层）。
//     jifei 后续会异步通过 `lightvela.pass.isolateResource(billingIsolateType=refund,
//     dealName=<上面 dealNames[0]>, newDeadline=...)` 回调 trade 入向 isolateResource
//     handler，由该 handler（v1.7.30 BUG-35 已实现）走退费分支抢占式幂等 + 反向调
//     ctl IsolatePass 完成 pass 状态机闭合。
//
//   - 业务失败（returnCode != 0）→ jifeiclient 包成 *CGWError，调用方按 PDF 错误码透传给 ctl：
//
//   - 101103: 订单未发货完成（trade 不在自身做重试，由 ctl admin 调用方决定是否重试）
//
//   - "allowReturn != 1": 业务规则禁止退款（如 bundle_free_trial 试用套餐）
//
//   - "param error": 入参错（trade 拼装错误 / 已被 client-side 校验拦掉）
type OnlineRefundResponse struct {
	DealNames  []string `json:"dealNames"`
	BigDealIDs []string `json:"bigDealIds"`
}

// jifei CGW `qcloud.Deal.OnlineRefund` 协议层常量。
const (
	// InterfaceNameOnlineRefund 是接口名（doc §1 标题）。
	//
	// 与 GenerateDeals / GenerateDealsAndPay 同属 `qcloud.Deal.*` Deal 接口族，
	// 走 jifei 计费网关（HMAC-SHA256 签名），componentName / caller 复用
	// CGWComponentNameLightvela（与现有 6 个出向接口同款 "lightvela"）。
	InterfaceNameOnlineRefund = "qcloud.Deal.OnlineRefund"

	// ComponentNameOnlineRefund 是 CGW envelope componentName 字段值，统一收敛到 "lightvela"
	// （与 5 处 ComponentName* 常量同款 v1.7.4 协议校准）。
	ComponentNameOnlineRefund = CGWComponentNameLightvela

	// FromConsoleYes = 1：trade 走后台 admin 入口（ctl RefundPass → trade RefundResource →
	// jifei OnlineRefund），固定标识"来自控制台"（doc §4.1 "1，来自控制台"）。
	FromConsoleYes = 1
)

// OnlineRefund 调用 jifei CGW `qcloud.Deal.OnlineRefund` 退款接口（同步）。
//
// 用途（trade-pass-refund-design.md §3 ctl → trade → jifei 链路）：
// ctl admin handler 调用 trade.RefundResource → trade 拼装 OnlineRefundRequest
// 调本方法 → jifei 同步返 dealNames / bigDealIds → trade 透传给 ctl → ctl 透传给 admin。
//
// **同步语义关键事实**（设计稿 §3 + Q8b=b 拍板理由）：
//
//   - jifei OnlineRefund 是**同步接口**，业务成功 / 失败都立即返响应（returnCode + dealNames）
//   - 不存在"中间 in_progress"中态——trade 端不需要 trade_flow 行保护并发
//   - 后续真实退款资金流转 + pass 隔离生效由 jifei 异步回 isolateResource 推动
//
// **错误语义**（与现有出向接口完全一致）：
//
//   - nil 入参 / 必填字段缺失 → client-side errInvalidArg（不出请求）
//   - 业务失败（returnCode != 0）→ *CGWError；调用方用 errors.As 提取
//   - HTTP / envelope 失败 → ErrCGWHTTPNon200 / ErrCGWInvalidEnvelope
//
// **签名链路**（Q-D-SIG-1~6 范式，与 ModifyResourceStatus 同款）：
// 走 doSigned 路径——baseURL=c.billingBaseURL，HMAC-SHA256 签名 envelope.interface.auth；
// trade.Options.BillingAPIGWBaseURL / BillingAppID / BillingAppSecret 三者任一为空时
// 直接报 client-side 错误（不出请求），由调用方装配点（trade.cmd/trade/main.go）保证注入。
func (c *client) OnlineRefund(
	ctx context.Context,
	req *OnlineRefundRequest,
) (*OnlineRefundResponse, error) {
	if req == nil {
		return nil, errInvalidArg("OnlineRefund: nil request")
	}
	if req.UIN == "" {
		return nil, errInvalidArg("OnlineRefund: empty UIN")
	}
	if req.AppID <= 0 {
		return nil, errInvalidArg("OnlineRefund: AppID must be positive")
	}
	if req.OwnerUin == "" {
		// 2026-06-23 v0.5.1 联调修复：jifei 网关硬校验 extraPara.ownerUin 非空，
		// 缺则返 returnCode=100000 "param error,need ownerUin or site"。本字段必填，
		// 与 ModifyResourceStatus.OwnerUIN（v1.7.29 同款）保持一致。
		return nil, errInvalidArg("OnlineRefund: empty OwnerUin")
	}
	if len(req.GoodsInfo) == 0 {
		return nil, errInvalidArg("OnlineRefund: empty GoodsInfo")
	}
	for subProductCode, entry := range req.GoodsInfo {
		if subProductCode == "" {
			return nil, errInvalidArg("OnlineRefund: GoodsInfo key (sub_product_code) is empty")
		}
		if entry.PayMode != PayModePrepaid {
			return nil, errInvalidArg(
				"OnlineRefund: GoodsInfo[" + subProductCode + "].PayMode must be 1 (prepaid); doc §4.1 \"后付费不能退费\"")
		}
		if entry.RegionID <= 0 {
			return nil, errInvalidArg(
				"OnlineRefund: GoodsInfo[" + subProductCode + "].RegionID must be positive")
		}
		if len(entry.ResourceIDList) == 0 {
			return nil, errInvalidArg(
				"OnlineRefund: GoodsInfo[" + subProductCode + "].ResourceIDList is empty")
		}
		for i, rid := range entry.ResourceIDList {
			if rid == "" {
				return nil, errInvalidArg(
					"OnlineRefund: GoodsInfo[" + subProductCode + "].ResourceIDList[" + itoa(i) + "] is empty")
			}
		}
	}

	// 2026-06-23 v0.5.1 联调修复：与 ModifyResourceStatus 同款走 doSignedWithExtra，
	// 把 OwnerUin 中转到 envelope.interface.extraPara.ownerUin（jifei 网关硬校验，缺则
	// returnCode=100000 "param error,need ownerUin or site"）。para wire 不受影响
	// （OwnerUin 字段 `json:"-"` 跳过序列化），与 v1.7.29 销毁链路修复路径一比一对齐。
	extraPara := &extraParaBlock{OwnerUin: req.OwnerUin}
	out := &OnlineRefundResponse{}
	if err := c.doSignedWithExtra(
		ctx, InterfaceNameOnlineRefund, ComponentNameOnlineRefund,
		extraPara, req, out,
	); err != nil {
		return nil, err
	}
	return out, nil
}
