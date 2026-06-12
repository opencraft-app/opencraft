package jifeiclient

import (
	"context"
)

// ModifyResourceStatusRequest 是 jifei CGW `qcloud.operation.ModifyResourceStatus`
// 资源状态变更接口入参（para 内层），D-2 切片引入。
//
// 协议正本（`/root/project/mono/.tmp/【订购关系建设】资源中心对外cgw接口定义.pdf` §1.1）：
//
//	clientType        Integer  必填  4=产品（trade 自家走 4）
//	submitByUser      Integer  必填  1=用户主动 / 0=系统自动
//	referenceId       String   必填  本次请求的唯一 ID（jifei 用作幂等键）
//	productCode       String   必填  四层定义第一层（运行时按 pass.bundle_id → bundle_definition.product_code 反查；Q26 ✅）
//	uin               String   必填  资源实际拥有者主账号
//	subAccountUin     String   可选  操作者 uin（主账号 / 子账号 / 协作者 / 角色），不传则等同 uin
//	appId             Integer  必填  云平台应用 ID（与 uin 一一对应）
//	regionId          Integer  必填  地域 ID（Lighthouse=1 广州；Q41 ✅）
//	payMode           Integer  必填  0=后付费 / 1=预付费 / 2=预留实例-资源包（pass=1）
//	returnFlowId      Integer  可选  0/不传=不返业务 flowId，1=返；本期销毁链路不依赖此字段
//	resourcesParamSet Array    必填  资源列表，每项 {subProductCode, resourceIds[]}；总数 ≤ 10
//	operateName       String   必填  操作类型枚举：PRE_DESTROY / PRE_ISOLATE / POST_DESTROY 等
//	resultNotified    Integer  可选  1=事后通知（跳过业务回调，需白名单）；本期不用
//
// **设计自决**：
//
//   - PascalCase（与 jifeiclient.go 现有 GenerateDealsRequest / GenerateDealsAndPayRequest
//     保持一致；jifei CGW 协议层对字段名大小写不敏感，wire 上接受 camelCase / PascalCase 两种 — PDF
//     第 5 页示例 para 字段是 camelCase，但本 client 沿 PascalCase 范式以保持仓库内一致；
//     如未来 jifei 网关变严格 camelCase，可改 JSON tag 一行收敛）
//
//   - 不持有 `resultNotified` 字段（trade 不在白名单上，不能跳过业务回调；销毁链路必须走
//     "trade.ModifyResourceStatus → jifei → trade.destroyResource 回调 → trade.ctlAdapter.DestroyPass"）
//
//   - SubAccountUin 用 `omitempty` —— 为空时 jifei 等同 uin（PDF 字段表"实际操作者"语义）
//
//   - ReturnFlowID 用 `omitempty` —— 为 0 / nil 时 jifei 默认不返业务 flowId（与本期不依赖
//     一致；如未来父 task 想用 jifei 端 flowId 做对账，可改 *int 三态）
//
// **operateName 枚举对照**（PDF §1.1 第 4-5 页完整列表）：
//
//	PRE_ISOLATE     预付费隔离（仅隔离不退费；退费走交易退款接口）
//	PRE_DESTROY     预付费销毁  ← 本期销毁链路使用
//	POST_ISOLATE    后付费隔离（需要"资源管理能力-主动变更"）
//	POST_DESTROY    后付费销毁
//	POST_REVERSAL   后付费恢复
//	RESOURCE_BLOCK  资源不合规冻结
//	RESOURCE_UNBLOCK 资源合规解冻
//	PRE_CREATE      预付费创建
//	POST_CREATE     后付费创建
//
// 本 client 不固化 operateName 取值常量 — 按 jifei 协议字段语义保持开放枚举（caller 传入），
// 仅在销毁链路调用方（trade.DeleteResource handler）固化为 OperateNamePreDestroy 字符串常量。
type ModifyResourceStatusRequest struct {
	ClientType   int    `json:"clientType"`
	SubmitByUser int    `json:"submitByUser"`
	ReferenceID  string `json:"referenceId"`
	ProductCode  string `json:"productCode"`

	// OwnerUIN 是资源所有者主账号 uin（PDF 资源中心§1.1 示例明示位于
	// `envelope.interface.extraPara.ownerUin`，不在 para 里）。jifei 网关侧硬校验
	// `extraPara.ownerUin or extraPara.site` 二选一非空，缺则返 returnCode=100000
	// "param error,need ownerUin or site"。本字段不序列化进 para wire（`json:"-"`），
	// 由 ModifyResourceStatus() 提取后中转到 envelope.interface.extraPara 路径。
	OwnerUIN string `json:"-"`

	UIN               string                     `json:"uin"`
	SubAccountUIN     string                     `json:"subAccountUin,omitempty"`
	AppID             int64                      `json:"appId"`
	RegionID          int                        `json:"regionId"`
	PayMode           int                        `json:"payMode"`
	ReturnFlowID      int                        `json:"returnFlowId,omitempty"`
	ResourcesParamSet []ModifyResourceStatusItem `json:"resourcesParamSet"`
	OperateName       string                     `json:"operateName"`
}

// ModifyResourceStatusItem 是 resourcesParamSet 数组单元素 —— 一组同 subProductCode 下的资源 ID 列表。
//
// 协议字段（PDF §1.1）：
//
//	subProductCode  String         必填  四层定义第二层（如 sp_lighthouse_pass）
//	resourceIds     Array<String>  必填  资源 ID 列表（透传至业务侧 destroyResource 回调）；总数 ≤ 10
//
// 本期销毁链路下，trade.DeleteResource 一次只销毁一个 pass（resourceIds 单元素），但 client 不限制
// 单次调用资源数（保留批量销毁可扩展性，由 caller 决定切批策略）。
type ModifyResourceStatusItem struct {
	SubProductCode string   `json:"subProductCode"`
	ResourceIDs    []string `json:"resourceIds"`
}

// ModifyResourceStatusResponse 是 CGW returnValue 反序列化目标。
//
// PDF §1.1 第 6 页 / §1.1.1.1.2 第 7 页给出的字段集（PascalCase 适配）：
//
//	{
//	  "operationSet": [{
//	    "subProductCode": "<sub product>",
//	    "operationId":    0,        // 同步流程返回 0；当前协议已无法精确返回历史字段，不要使用
//	    "resultType":     0,        // 0=同步 / 1=异步（异步时按 operationId 查询）；同步流程返 0
//	    "status":         0,        // 0=全部成功 / 1=全部失败 / 2=部分失败 / 3=全部异步进行中
//	    "bizFlowIds":     [{"resourceId": "id1", "flowId": 123}, ...]  // 业务接口返回的异步 flow id
//	  }],
//	  "failedResources": [{
//	    "resourceId":    "<resource id>",
//	    "returnCode":    100001,
//	    "returnMessage": "<failure reason>"
//	  }]
//	}
//
// **本期消费策略**（D-2 切片）：
//
//   - HappyPath：returnCode=0 + operationSet[*].status=0 → trade.DeleteResource 同步返成功，
//     ctl Logic.DeletePass 收到后立即返用户 200；后续真实销毁由 jifei 异步回调 trade.destroyResource 推动
//
//   - 业务失败（returnCode != 0）→ jifeiclient 已经包成 *CGWError，调用方按 PDF 错误码分类处理
//
//   - 同步部分失败（status=2/1）+ failedResources 非空 → jifeiclient 这一层无法判定（returnCode=0），
//     由调用方（trade.DeleteResource handler）根据本结构断言；本期销毁链路单资源调用，partial failure
//     退化为 "整批失败" 处理（同 status=1）
//
//   - 异步进行中（status=3 / resultType=1）→ 本期不消费 bizFlowIds，依赖 jifei 后续回调推动
//
// **字段保真**：
//
//   - 不解析 `bizFlowIds` 子字段集（本期不消费）；保留 RawMessage 占位以便未来扩展
//   - failedResources 字段全量解析（后续监控指标 / 告警可读取）
type ModifyResourceStatusResponse struct {
	OperationSet    []ModifyResourceStatusOperation `json:"operationSet"`
	FailedResources []ModifyResourceStatusFailure   `json:"failedResources,omitempty"`
}

// ModifyResourceStatusOperation 是 operationSet 数组单元素。
type ModifyResourceStatusOperation struct {
	SubProductCode string `json:"subProductCode,omitempty"`
	OperationID    int64  `json:"operationId"`
	ResultType     int    `json:"resultType"`
	Status         int    `json:"status"`
}

// ModifyResourceStatusFailure 是 failedResources 数组单元素。
type ModifyResourceStatusFailure struct {
	ResourceID    string `json:"resourceId"`
	ReturnCode    int    `json:"returnCode"`
	ReturnMessage string `json:"returnMessage"`
}

// jifei CGW `qcloud.operation.ModifyResourceStatus` 协议层常量。
const (
	// InterfaceNameModifyResourceStatus 是接口名（PDF §1 标题）。
	InterfaceNameModifyResourceStatus = "qcloud.operation.ModifyResourceStatus"

	// ComponentNameOperation 是 CGW envelope componentName 字段值。
	//
	// **v1.7.4 协议校准**（Q-INT-12 拍板）：值由 "operation" 改为统一的 "lightvela"，与其他
	// 4 处出向 componentName 常量保持一致（getprice / generatedeals / generatedealsandpay /
	// getmidasearmarking）。注：本期 Phase 5 销毁联调跳过 trade → jifei 出向通知（见
	// .tmp/integration-plan-2026-05-18.md §10 Q-INT-10），ModifyResourceStatus 真接入时
	// 再按 jifei 同事反馈是否需要单独 override。
	//
	// 历史注：PDF §1 标题给出的"网关 moduleName: resource-center"是 jifei CGW 网关层路由用，
	// 不等同于 envelope.componentName；jifei 响应 envelope.componentName 回 "resourceCenter"
	// 是 jifei 后端业务模块标识，请求方向不强一致（jifeiclient.do 没校验响应 componentName）。
	ComponentNameOperation = CGWComponentNameLightvela

	// OperateNamePreDestroy 是销毁链路使用的 operateName 取值（PDF §1.1 字段表）。
	//
	// 销毁场景固定 PRE_DESTROY，对应"预付费销毁"语义；jifei 收到后会异步回调
	// `qcloud.PRODUCT_NAME.destroyResource`（trade 侧 dispatcher 对应 lightvela.pass.destroyResource）。
	OperateNamePreDestroy = "PRE_DESTROY"

	// ClientTypeProduct = 4：trade 作为产品方调用 jifei 的固定 clientType（PDF §1.1 字段表"4-产品"）。
	ClientTypeProduct = 4

	// SubmitByUserYes = 1：本期销毁链路入口 A（用户控制台主动）固定传 1；
	// 系统主动入口（如生命周期 cron）传 0，但当前 trade.DeleteResource 仅服务用户主动入口。
	SubmitByUserYes = 1

	// PayModePrepaid = 1：预付费（pass 全部走 1）。
	PayModePrepaid = 1
)

// ModifyResourceStatus 调用 jifei CGW `qcloud.operation.ModifyResourceStatus` 资源状态变更接口。
//
// 用途（D-2 切片）：trade.DeleteResource handler 调用本方法把"用户已请求销毁"指令同步通知 jifei；
// jifei 收到后立即同步返响应（status=0），并异步通过 destroyResource 回调推动 trade 实际销毁链路。
//
// 错误语义（与 GenerateDeals / GetPrice 一致）：
//
//   - nil 入参 / 必填字段缺失 → client-side errInvalidArg（不出请求）
//   - 业务失败（returnCode != 0）→ *CGWError；调用方可用 errors.As 提取
//   - HTTP 层 / envelope 解析失败 → ErrCGWHTTPNon200 / ErrCGWInvalidEnvelope
//
// **关于 partial failure 检测**：本 client 不在 ModifyResourceStatus 这一层断言
// `OperationSet[*].Status != 0` 或 `FailedResources` 非空 — 这是协议层"业务半成功"状态，
// 由调用方（trade.DeleteResource handler）按业务语义决定是返 5xx / 200+warning / 重试。
// 这与 GenerateDealsAndPay 的 DealDeliverResults["state"] 处理同型 — 协议层只翻译 returnCode，
// 业务半成功状态由业务层消费。
func (c *client) ModifyResourceStatus(
	ctx context.Context,
	req *ModifyResourceStatusRequest,
) (*ModifyResourceStatusResponse, error) {
	if req == nil {
		return nil, errInvalidArg("ModifyResourceStatus: nil request")
	}
	if req.ReferenceID == "" {
		return nil, errInvalidArg("ModifyResourceStatus: empty ReferenceID")
	}
	if req.ProductCode == "" {
		return nil, errInvalidArg("ModifyResourceStatus: empty ProductCode")
	}
	if req.UIN == "" {
		return nil, errInvalidArg("ModifyResourceStatus: empty UIN")
	}
	if req.OwnerUIN == "" {
		return nil, errInvalidArg("ModifyResourceStatus: empty OwnerUIN")
	}
	if req.AppID <= 0 {
		return nil, errInvalidArg("ModifyResourceStatus: AppID must be positive")
	}
	if req.RegionID <= 0 {
		return nil, errInvalidArg("ModifyResourceStatus: RegionID must be positive")
	}
	if req.OperateName == "" {
		return nil, errInvalidArg("ModifyResourceStatus: empty OperateName")
	}
	if len(req.ResourcesParamSet) == 0 {
		return nil, errInvalidArg("ModifyResourceStatus: empty ResourcesParamSet")
	}
	for i, item := range req.ResourcesParamSet {
		if item.SubProductCode == "" {
			return nil, errInvalidArg(
				"ModifyResourceStatus: ResourcesParamSet[" + itoa(i) + "].SubProductCode is empty")
		}
		if len(item.ResourceIDs) == 0 {
			return nil, errInvalidArg(
				"ModifyResourceStatus: ResourcesParamSet[" + itoa(i) + "].ResourceIDs is empty")
		}
		for j, rid := range item.ResourceIDs {
			if rid == "" {
				return nil, errInvalidArg(
					"ModifyResourceStatus: ResourcesParamSet[" + itoa(i) + "].ResourceIDs[" + itoa(j) + "] is empty")
			}
		}
	}

	// **Q-D-SIG-1~6 销毁链路签名分叉**：ModifyResourceStatus 走 jifei 计费网关协议
	// （base_url = c.billingBaseURL，HMAC-SHA256 签名 envelope.interface.auth），
	// 与询价 / 下单 / 支付的 jifei-test CGW 路由严格区分。doSigned 内部按 c.billingAppID /
	// c.billingAppSecret 构造 4 字段 auth；三者任一为空时直接报 client-side 错误（不出请求）。
	//
	// **v1.7.29 修复**：资源中心 CGW 接口 envelope.interface.extraPara.ownerUin 必填（PDF
	// §1.1 示例），jifei 网关硬校验。走 doSignedWithExtra 路径把 OwnerUIN 中转到
	// envelope.interface.extraPara，para wire 不受影响（OwnerUIN 字段 json:"-" 跳过序列化）。
	extraPara := &extraParaBlock{OwnerUin: req.OwnerUIN}
	out := &ModifyResourceStatusResponse{}
	if err := c.doSignedWithExtra(
		ctx, InterfaceNameModifyResourceStatus, ComponentNameOperation,
		extraPara, req, out,
	); err != nil {
		return nil, err
	}
	return out, nil
}
