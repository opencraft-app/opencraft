package ctlclient

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// 同 SP 变配的 trade → ctl 反向调。需求：TAPD 1010132091137784162 §5.2 / §7.1
//
// 两个接口对应计费的两个阶段：
//   - CheckPassModify ← jifei checkModify：下单前校验，只读，不改状态
//   - ModifyPass      ← jifei modifyResource：支付成功后受理发货，CAS active→modifying + 派 task
//
// 请求体形状镜像 ctl/pkg/transport 的 CheckPassModifyRequest / PassModifyRequest；
// 不 import ctl 的 transport 包，与本文件其余 DTO 同规矩（ctl transport 是私有 DTO，不是跨服务 contract）。

// CheckPassModifyRequest 镜像 ctl/pkg/transport.CheckPassModifyRequest。
//
// CurDeadline 用 *time.Time：nil 表示"不校验到期时间"，而不是"到期时间是零值"。
// trade 侧从 jifei goodsDetail.curDeadline 按 CST 解析成绝对时刻后透传，
// wire 层走 RFC3339（与 IsolatePassRequest.NewDeadline 同款），ctl 不再做时区转换。
type CheckPassModifyRequest struct {
	SourceBundleID string `json:"source_bundle_id"`
	TargetBundleID string `json:"target_bundle_id"`

	Uin   int64 `json:"uin,omitempty"`
	AppID int64 `json:"app_id,omitempty"`

	ProductCode    string `json:"product_code,omitempty"`
	SubProductCode string `json:"sub_product_code,omitempty"`

	CurDeadline *time.Time `json:"cur_deadline,omitempty"`
}

// ModifyPassRequest 镜像 ctl/pkg/transport.PassModifyRequest。
//
// 内嵌 CheckPassModifyRequest 而不是重列字段：发货受理会重跑一遍 check 的全部校验
// （询价到发货之间 pass 可能已漂移），两处字段集必须永远一致。
type ModifyPassRequest struct {
	CheckPassModifyRequest

	// FlowID = trade_flow.id PK，落到 ctl pass.modify_flow_id。
	// 必须 > 0：ctl 靠它区分"同一笔单重投"和"另一笔单插队"。
	FlowID int64 `json:"trade_flow_id"`

	// DealName = jifei 子订单号，ctl 用作 VelaGW 订阅切换的幂等键。
	DealName string `json:"deal_name,omitempty"`

	// TranID 仅日志留痕。
	TranID string `json:"tran_id,omitempty"`
}

// CheckPassModifyResponse 镜像 ctl/pkg/transport.CheckPassModifyResponse。
type CheckPassModifyResponse struct {
	PassID  string `json:"pass_id"`
	Allowed bool   `json:"allowed"`
}

// ModifyPassResponse 镜像 ctl/pkg/transport.PassModifyResponse。
type ModifyPassResponse struct {
	PassID string `json:"pass_id"`
	TaskID string `json:"task_id"`
}

// CheckPassModify 调 POST /internal/ctl/passes/{pass_id}/check-modify
//
// 只读校验，不改任何状态；成功即"允许变配"，trade 翻译成计费的 data.status = 0。
//
// 错误语义（ctl errcode，4xx 都是业务永久错，trade 不该让计费重试）：
//   - 404 PASS_NOT_FOUND                    pass 不存在
//   - 403 PASS_MODIFYING                    已有变配在跑
//   - 403 PASS_NOT_MODIFIABLE               status ∉ {active}
//   - 400 PASS_MODIFY_TARGET_NOT_ALLOWED    source → target 不在允许的升配关系里
//   - 409 PASS_MODIFY_CONFIG_MISMATCH       uin/appId/source bundle/curDeadline 与 pass 不一致
//   - 409 PASS_MODIFY_INSTANCE_NOT_READY    实例不是全部 Running
//   - 5xx                                    DB 异常等基础设施错，trade 侧按 B 类让计费重试
//
// 计费 checkModify 总时限 3s，调用方应给 ctx 一个明显更小的超时。
func (c *httpClient) CheckPassModify(
	ctx context.Context,
	passID string,
	req *CheckPassModifyRequest,
) (*CheckPassModifyResponse, error) {
	if strings.TrimSpace(passID) == "" {
		return nil, fmt.Errorf("ctlclient: passID is required")
	}
	if req == nil {
		req = &CheckPassModifyRequest{}
	}
	endpoint := c.baseURL + "/internal/ctl/passes/" + url.PathEscape(passID) + "/check-modify"

	var detail CheckPassModifyResponse
	if err := c.do(ctx, http.MethodPost, endpoint, req, &detail); err != nil {
		return nil, err
	}
	return &detail, nil
}

// ModifyPass 调 POST /internal/ctl/passes/{pass_id}/modify
//
// 受理发货：ctl 重跑前置校验 → CAS active→modifying → 派发变配父 task → 返 task_id。
//
// 幂等：同一 trade_flow_id 重投返 200 + 原链路的 task_id。这点很重要——计费在超时或
// 失败后会持续重投 modifyResource，非幂等会被判定发货失败去退款。
//
// 错误语义与 CheckPassModify 一致，另加：403 PASS_MODIFYING 表示**另一笔** flow
// 正占着 pass（同一笔 flow 重投走幂等成功分支，不会落到这个码）。
func (c *httpClient) ModifyPass(
	ctx context.Context,
	passID string,
	req *ModifyPassRequest,
) (*ModifyPassResponse, error) {
	if strings.TrimSpace(passID) == "" {
		return nil, fmt.Errorf("ctlclient: passID is required")
	}
	if req == nil {
		req = &ModifyPassRequest{}
	}
	endpoint := c.baseURL + "/internal/ctl/passes/" + url.PathEscape(passID) + "/modify"

	var detail ModifyPassResponse
	if err := c.do(ctx, http.MethodPost, endpoint, req, &detail); err != nil {
		return nil, err
	}
	return &detail, nil
}
