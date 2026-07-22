// Package ctlclient 封装 trade → ctl 的内部反向调用。
//
// 设计稿对齐（trade-purchase-flow-design §5.2 / §5.4 / §6 / §7.5）：
//   - checkCreate：调 GetBundleByID + ListPassesByUser 做实时校验
//     （Q24 / Q33：bundle 自校验；Q25 / Q66 修订 / Q69：互斥占用查询）
//   - createResource：调 CompletePass 完成发货
//     （Q42 / billing-integration B3：trade 透传完整入参，ctl 不做幂等）
//
// 资源反查（trade-resource-query-design §3.2 / §4 / §8 11A 已合入 ctl）：
//   - ListPassAppIDs：调 GET /internal/ctl/passes/app-ids（jifei.getAllAppIds）
//   - ListPassesByAppID：调 GET /internal/ctl/passes/by-app（jifei.getUserResources）
//   - ListPassesByResourceIDs：调 POST /internal/ctl/passes/by-resource-ids（jifei.queryResource）
//
// 协议层：
//   - 鉴权：Authorization: Bearer <internalServiceToken>
//     与 ctl 的 requireInternalBearer 对齐（CTL_INTERNAL_TOKEN）
//   - 错误模型：透传 ctl 的 errorResponse{code, message, request_id, details}
//     ctl 侧 5xx / 业务错（401/404/4xx）一律包装为 *Error，附带 RequestID 便于排障
//
// 超时：所有方法默认 4 秒（设计稿 Q59 同步发货 5 秒预算 - 1 秒 buffer），
// 调用方可通过 ctx 进一步收紧；超出 4 秒由 http.Client 强制中断。
//
// 资源反查链路超时（trade-resource-query-design §3.x 三层预算）：
//   - jifei 协议 3s → trade handler 2.5s → ctlclient 1.5s（ctx 收紧覆盖默认 4s）
package ctlclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Client 是 ctl 内部反向调用契约。
//
// 抽象成 interface 便于上层 service / handler 注入 mock 做单元测试，
// 也允许迭代 8+ 替换实现（如切到 tRPC / connect-go 时不破坏调用方）。
type Client interface {
	// GetBundleByID 调 GET /internal/ctl/bundles/{bundleId}
	//
	// 返回 ctl 维护的 bundle 业务规格精简子集（剥离 ai_gateway_plans /
	// sub_product_code / time_span / time_unit 等内部字段，详见 ctl
	// transport.InternalBundleDetail 注释）。
	//
	// trade 用法：checkCreate 阶段拿 bundle_state / bundle_sales_state 做自校验。
	GetBundleByID(ctx context.Context, bundleID string) (*BundleDetail, error)

	// ListPassesByUser 调 GET /internal/ctl/passes?external_user_id=xxx
	//
	// 返回当前 user_id 名下**全部** pass 记录（不论是否过期 / 隔离 / 删除）。
	//
	// trade 用法（Q66 修订 + Q69 拍板，2026-05-09）：checkCreate 阶段判定互斥占用 —
	// **列表非空即互斥占用**，无条件阻断新购下单（过期 pass 走续费路径，不走新购）。
	// trade 业务层只关心数组长度，不需要逐条检查时间字段。
	ListPassesByUser(ctx context.Context, externalUserID string) ([]*PassDetail, error)

	// CompletePass 调 POST /internal/ctl/passes/complete
	//
	// 由 trade createResource 在 jifei 同步发货流程中调用，将 jifei 协议层
	// 透传字段（uin / app_id / time_span / time_unit / deal_name / renew_flag）
	// 提交给 ctl 完成付费 pass 写入 + ai-gateway 订阅联动。
	//
	// 注意（v4 收敛 / billing-integration B3）：
	//   - ctl 内部不再做幂等（兜底防御 USER_HAS_ACTIVE_PASS 即拒）
	//   - trade 侧由 trade_flow 抢占式幂等（Q61）保证不重复调
	CompletePass(ctx context.Context, req *CompletePassRequest) (*PassDetail, error)

	// TransferPass 调 POST /internal/ctl/passes/transfer
	//
	// 由 trade transferResource 在 jifei 外部资源迁入发货回调后调用，将存量免费 pass
	// 原子更新为计费 bundle，并绑定计费侧新 uin/app_id。与 CompletePass 不同，本接口不创建
	// 新 pass、不动 quota/subscription，只迁移既有 pass 的计费归属。
	TransferPass(ctx context.Context, req *TransferPassRequest) (*PassDetail, error)

	// ListPassAppIDs 调 GET /internal/ctl/passes/app-ids
	//
	// jifei.getAllAppIds 反查链路（trade-resource-query-design §3.2 / §4）：
	// 按 bundle_ids（可空，空 → ctl 不加 bundle_id 过滤）+ 0-based 分页返回**去重**
	// app_id 列表与去重总数。
	//
	// 参数语义：
	//   - bundleIDs：trade 侧根据 subProductCode 解析得到，nil/空 → 不加过滤
	//   - pageNo：0-based（与 jifei 协议一致）
	//   - pageSize：trade handler 已按 PDF §1.1 兜底 20000 上限，ctlclient 不再校验
	//
	// 返回：([appIDs]int64, total int64, err error) — total 是去重后的用户总数。
	ListPassAppIDs(ctx context.Context, bundleIDs []string, pageNo, pageSize int) ([]int64, int64, error)

	// ListPassesByAppID 调 GET /internal/ctl/passes/by-app
	//
	// jifei.getUserResources 反查链路（trade-resource-query-design §3.2 / §4）：
	// 按 app_id（必填）+ bundle_ids（可空）+ 0-based 分页返回 pass 列表与去重前总数。
	//
	// 参数语义：
	//   - appID：必填，> 0；ctl 侧会做参数校验
	//   - bundleIDs：trade 侧根据 subProductCode 解析得到，nil/空 → 不加过滤
	//   - pageNo / pageSize：与 ListPassAppIDs 一致
	//
	// 返回：([passes]*PassDetail, total int64, err error)。
	ListPassesByAppID(ctx context.Context, appID int64, bundleIDs []string, pageNo, pageSize int) ([]*PassDetail, int64, error)

	// ListPassesByResourceIDs 调 POST /internal/ctl/passes/by-resource-ids
	//
	// jifei.queryResource 反查链路（trade-resource-query-design §3.2 / §4）：
	// 按 (app_id, pass_ids) 集合反查 pass 详情。
	//
	// 参数语义：
	//   - appID：必填，> 0
	//   - passIDs：必填，1 ≤ len ≤ 100（PDF §2.2 "至少支持 100 个资源"）
	//
	// 关键约束（PDF §1.2）：不存在的 / 已销毁的 pass 不返回（数组减少元素，不报错），
	// 调用方需自行做长度校验后再做映射。
	//
	// 返回：([passes]*PassDetail, err error) — 不带 total（按 ID 反查不分页）。
	ListPassesByResourceIDs(ctx context.Context, appID int64, passIDs []string) ([]*PassDetail, error)

	// IsolatePass 调 POST /internal/ctl/passes/{pass_id}/isolate
	//
	// 用途（Sub-4 / .tmp/trade-pass-isolate-design.md §3 + §11 Q22-I-E）：
	// trade 接到 jifei `lightvela.pass.isolateResource` 回调后反向调本接口，
	// ctl 完成 pass.status active → isolating CAS 并派发 IsolatePass 父 task。
	//
	// 路径语义：
	//   - passID 走 URL path 段（与 ctl 现网路由 /internal/ctl/passes/{pass_id}/isolate 对齐）
	//   - body 当前为空 IsolatePassRequest{} 预留结构体（reason / operator_uin 等运营元数据未来可加）
	//
	// 错误语义（ctl 侧约定）：
	//   - 200：成功派发；返 {pass_id, task_id}；幂等场景同样返 200（同一 task_id）
	//   - 404 PASS_NOT_FOUND：pass_id 不存在 → ErrNotFound（trade 侧 A 类退款）
	//   - 403 PASS_ISOLATING：已隔离中（重入幂等保护）→ *Error.Code = "PASS_ISOLATING"
	//   - 403 PASS_ISOLATED：已隔离完毕（终态）→ *Error.Code = "PASS_ISOLATED"
	//   - 400 PASS_INVALID_PARAM：参数缺失（trade 侧应在前置层校验避免触发）
	//   - 5xx：DB / MQ 异常 → *Error.HTTPStatus >= 500（trade 侧 B 类 returnCode 让 jifei 重试）
	//
	// 调用方应通过 ctx 设置 1.5s 超时（设计稿 §3 三层预算 4s handler - 1.5s ctl - 1s 收尾 buffer）。
	IsolatePass(ctx context.Context, passID string, req *IsolatePassRequest) (*IsolatePassResponse, error)

	// RenewPass 调 POST /internal/ctl/passes/{pass_id}/renew
	//
	// 用途（R-C / .tmp/trade-pass-renew-design.md §4.3 / §5.2）：
	// trade 接到 jifei `lightvela.pass.renewResource` 回调后反向调本接口，
	// ctl 完成 pass.status active → renewing CAS（R-B 已落地 logic.RenewPass 主入口
	// + renew.go 双分支：sandbox 同步 / cvm 异步 501 占位）并派发 RenewPass 父 task。
	//
	// 路径语义：
	//   - passID 走 URL path 段（与 ctl 现网路由 /internal/ctl/passes/{pass_id}/renew 对齐）
	//   - body 透传 jifei 协议层关键字段（time_span / time_unit / deal_name / trade_flow_id）
	//
	// 错误语义（ctl 侧约定，与 ctl/pkg/errcode/pass.go R-B 已加常量对齐）：
	//   - 200：成功派发；返 {pass_id, task_id}；幂等场景同样返 200（同一 task_id）
	//   - 404 PASS_NOT_FOUND：pass_id 不存在 → ErrNotFound（trade 侧 A 类退款）
	//   - 403 PASS_RENEWING：已在续费中（重入幂等保护）→ *Error.Code = "PASS_RENEWING"
	//   - 403 PASS_NOT_RENEWABLE：pass 已 isolated/deleted/已超 12 月止步重试窗口 → "PASS_NOT_RENEWABLE"
	//   - 501 PASS_RENEW_NOT_IMPLEMENTED：cvm-kind 异步路径占位，本期 trade 不应触发
	//   - 400 PASS_INVALID_PARAM：参数缺失（trade 侧应在 checkRenew 层校验避免触发）
	//   - 5xx：DB / MQ 异常 → *Error.HTTPStatus >= 500（trade 侧 B 类 returnCode 让 jifei 重试）
	//
	// 调用方应通过 ctx 设置 1.5s 超时（与 IsolatePass 同三层预算）。
	RenewPass(ctx context.Context, passID string, req *RenewPassRequest) (*RenewPassResponse, error)

	// DestroyPass 调 POST /internal/ctl/passes/{pass_id}/destroy
	//
	// 用途（trade-pass-destroy §3.5 / §4.5.2 / §4.5.3 / §11-A Q1）：
	// trade 接到 jifei `lightvela.pass.destroyResource` 回调后反向调本接口，
	// ctl 完成 pass.status (deleting∨isolated) → terminating CAS 并派发 DestroyPass 父 task。
	//
	// 路径语义：
	//   - passID 走 URL path 段（与 ctl 路由 /internal/ctl/passes/{pass_id}/destroy 对齐）
	//   - body：DestroyPassRequest（含 trade_flow_id + destroy_reason）
	//
	// 错误语义（ctl 侧约定，与 IsolatePass 同范式）：
	//   - 200 + DestroyPassResponse{TaskID}：成功派发
	//   - 404 PASS_NOT_FOUND：pass 不存在 → trade 侧需要 DeleteByID 回滚 trade_flow + A 类退款
	//   - 403 PASS_TERMINATING：销毁主链已在跑（重投幂等保护，trade 视为 idempotent 成功）
	//   - 400 PASS_INVALID_PARAM：当前 status 不在 {deleting, isolated} 集合 → 永久不可推进 → A 类
	//   - 5xx：DB / MQ 异常 → *Error.HTTPStatus >= 500（trade 侧 B 类 returnCode 让 jifei 重试）
	//
	// 调用方应通过 ctx 设置 1.5s 超时（与 IsolatePass / RenewPass 同三层预算）。
	DestroyPass(ctx context.Context, passID string, req *DestroyPassRequest) (*DestroyPassResponse, error)
}

// BundleDetail 镜像 ctl/pkg/transport.InternalBundleDetail。
//
// 不直接 import ctl 的 transport 包是为了维持服务间封装边界 —
// ctl 的 transport 包是 ctl 私有 DTO，不是公共 contract；
// 跨服务共享待迭代 8+ 上线时再抽 contract 仓。
type BundleDetail struct {
	BundleID              string `json:"bundle_id"`
	BundleName            string `json:"bundle_name"`
	BundleState           string `json:"bundle_state"` // ONLINE / OFFLINE
	AgentQuota            int64  `json:"agent_quota"`  // 设备配额
	Credit                int64  `json:"credit"`       // 用户可见积分额度
	BundleSalesAvailCount int    `json:"bundle_sales_available_count"`
	BundleSalesTotalCount int    `json:"bundle_sales_total_count"`
	BundleSalesState      string `json:"bundle_sales_state"` // 计算字段 AVAILABLE / SOLD_OUT
}

// PassDetail 镜像 ctl/pkg/transport.PassResponse。
//
// 字段含义详见 ctl pass.go transport 定义；这里 trade 主要消费：
//   - PassID / BundleID / ExpiredTime / IsolatedTime / DeletedTime —
//     互斥占用判定保留字段方便排障/审计（Q69：trade 只关心列表非空，不需要
//     逐条检查时间字段，但保留字段用于日志记录"互斥被哪条 pass 占用"）
//   - Uin / AppID — createResource 透传校验
//   - RenewFlag —
//     资源反查链路（trade-resource-query-design §3.3 / §11 Q10）：
//     trade 把 jifei.renewFlag 字段持久化到 ctl pass.renew_flag，反查时透传回
//     jifei.getUserResources / queryResource 的 resources[i].renewFlag。
//     取值与 ctl 一致：MANUAL_RENEW / AUTO_RENEW / 空（缺省）。
type PassDetail struct {
	PassID       string     `json:"pass_id"`
	UserID       string     `json:"user_id"`
	BundleID     string     `json:"bundle_id"`
	BundleName   string     `json:"bundle_name"`
	Uin          int64      `json:"uin"`
	AppID        int64      `json:"app_id"`
	CreatedTime  time.Time  `json:"created_time"`
	ExpiredTime  time.Time  `json:"expired_time"`
	IsolatedTime *time.Time `json:"isolated_time"`
	DeletedTime  *time.Time `json:"deleted_time"`
	UpdatedTime  time.Time  `json:"updated_time"`

	CreditTotal     int64 `json:"credit_total"`
	CreditAvailable int64 `json:"credit_available"`

	// RenewFlag 续费标记（trade-resource-query-design §11 Q10 / 11A 已合入 ctl）。
	// 取值：MANUAL_RENEW / AUTO_RENEW / 空字符串（缺省）。
	// 不使用 omitempty —— ctl 必返此字段（即便为空字符串），调用方按字面值映射 jifei。
	RenewFlag string `json:"renew_flag"`
}

// CompletePassRequest 镜像 ctl/pkg/transport.CompletePassRequest。
//
// 字段语义详见 ctl 侧定义；trade 在 createResource 回调收到 jifei 协议层
// 字段后构造此请求体提交给 ctl。
type CompletePassRequest struct {
	UserID    string `json:"user_id"`
	BundleID  string `json:"bundle_id"`
	TimeSpan  int    `json:"time_span"`
	TimeUnit  string `json:"time_unit"`
	Uin       int64  `json:"uin"`
	AppID     int64  `json:"app_id"`
	DealName  string `json:"deal_name"`
	RenewFlag string `json:"renew_flag,omitempty"`
}

// TransferPassRequest 镜像 ctl/pkg/transport.TransferPassRequest。
type TransferPassRequest struct {
	PassID         string `json:"pass_id"`
	UserID         string `json:"user_id,omitempty"`
	SourceBundleID string `json:"source_bundle_id,omitempty"`
	TargetBundleID string `json:"target_bundle_id"`
	OldUin         int64  `json:"old_uin"`
	OldAppID       int64  `json:"old_app_id"`
	NewUin         int64  `json:"new_uin"`
	NewAppID       int64  `json:"new_app_id"`
	DealName       string `json:"deal_name"`
	BigOrderID     string `json:"big_order_id,omitempty"`
}

// IsolatePassRequest 镜像 ctl/pkg/transport.IsolatePassRequest。
//
// 字段语义：
//   - FlowID（trade_flow_id）：trade_flow.id 主键，trade 侧抢占式幂等机制下作为 jifei flowId 出参。
//     ctl 侧父 task IsolatePass 完成 instance pause + pass.status → isolated 后，会用此 ID 反向调
//     trade 的 `POST /internal/trade/flows/{flow_id}/complete` callback，把 trade_flow.status 推进到
//     completed（设计稿 .tmp/trade-pass-isolate-design.md §6 + §10 Q22-I-E 端到端闭环）。
//
// 透传行为：
//   - FlowID == 0 时（dev/test 旧链路兼容）ctl 侧跳过 callback，仅完成本地隔离；trade_flow 由
//     reconcile worker + jifei queryFlow 兜底推进。
//   - FlowID > 0 时 ctl 侧异步父 task markSuccess 前 best-effort 调 trade callback。
//
// 与 ctl 现网行为对齐：HTTP body 长度 0 时 ctl 不强校验 body；非空 body 时 ctl 按 JSON decode。
// 保留预留 reason / operator_uin 等运营元数据扩展位。
type IsolatePassRequest struct {
	// FlowID 是 trade_flow.id 主键（trade 侧抢占式幂等行的 BIGINT AUTO_INCREMENT PK），
	// ctl 父 task 终态时回调 trade `/internal/trade/flows/{flow_id}/complete` 用。
	// 0 值兼容旧链路（dev/test/未透传场景），ctl 侧跳过 callback。
	FlowID int64 `json:"trade_flow_id,omitempty"`

	// NewDeadline 是 jifei 退费场景下的"新到期时间"（PDF isolateResource §2.2 退费分支）。
	//
	// 三态语义（v1.7.30 退费隔离扩展）：
	//   - nil           → 生命周期隔离场景；ctl 父 task 终态仅 CAS isolating→isolated，
	//                     **不动** pass.expired_time，避免误把 expired_time 改成零值。
	//   - 非 nil time.Time → 退费隔离场景；ctl 父 task 终态在同一事务里
	//                     CAS isolating→isolated + 写 pass.expired_time = *NewDeadline。
	//
	// 时区：trade handler 已把 jifei 北京时间字面值（CST）按 jifei.CurDeadlineLocation 解析为
	// 绝对时刻 UTC time.Time，ctl 拿到后无需再做时区转换；wire 层走 RFC3339（time.Time
	// 默认 JSON 编码即 RFC3339 UTC，与 ctl 全栈 UTC 规范一致）。
	NewDeadline *time.Time `json:"new_deadline,omitempty"`

	// DealName 是 jifei 退费场景下的子订单号（PDF §2.2 dealName，仅退费传）。
	//
	// trade 侧已存入 trade_flow.deal_name 列做审计 / 反查兜底键；同时透传给 ctl 仅用作日志，
	// ctl 不做业务消费（dealName 不参与 pass 状态机）。
	//
	// 空字符串 = 生命周期场景或老调用链路。
	DealName string `json:"deal_name,omitempty"`
}

// IsolatePassResponse 镜像 ctl/pkg/transport.IsolatePassResponse。
//
// 字段：
//   - PassID：回显请求路径里的 pass_id，便于排障
//   - TaskID：ctl 派发的 IsolatePass 父 task 的 task_id；trade 侧持久化到 trade_flow.response_body
//     便于排障（设计稿 §3.4 trade_flow ↔ ctl task 关联）
type IsolatePassResponse struct {
	PassID string `json:"pass_id"`
	TaskID string `json:"task_id"`
}

// RenewPassRequest 镜像 ctl/pkg/transport.RenewPassRequest（R-D 待落地）。
//
// 字段语义（设计稿 .tmp/trade-pass-renew-design.md §4.3 / §5.2）：
//   - TimeSpan / TimeUnit：jifei 续费协议透传，与 trade_order 落库列同型。
//     R-B logic 侧 CalcExpiredTime 已扩展 'y' case（Q19=b 全链路 m/d/y），
//     trade checkRenew 已做 ∈ {y,m,d} 严格白名单（Q12=a），无需 ctl 再次校验集合。
//   - DealName：jifei 协议层 dealName，ctl 侧透传到 ai-gateway 订阅升级链路（B3 范式）；
//     非空字符串铁律（trade 调本接口前已通过 R-C Q15=a panic assertion 兜底）。
//   - FlowID：trade_flow.id 主键，ctl 父 task 终态时回调 trade
//     `/internal/trade/flows/{flow_id}/complete` 用，与 IsolatePass 同型；0 值兼容旧链路。
//
// JSON 字段名与 ctl 内部 transport 对齐（snake_case），不直接 import ctl 维持服务边界。
type RenewPassRequest struct {
	TimeSpan int    `json:"time_span"`
	TimeUnit string `json:"time_unit"`
	DealName string `json:"deal_name"`
	// FlowID 是 trade_flow.id 主键，ctl 父 task 终态时回调 trade callback 用。
	// 0 值兼容旧链路（dev/test/未透传场景）。
	FlowID int64 `json:"trade_flow_id,omitempty"`
}

// RenewPassResponse 镜像 ctl/pkg/transport.RenewPassResponse（R-D 待落地）。
//
// 字段：
//   - PassID：回显请求路径里的 pass_id，便于排障
//   - TaskID：ctl 派发的 RenewPass 父 task 的 task_id；trade 侧持久化到
//     trade_flow.response_body 便于排障。本期 sandbox 同步分支（R-B logic 直走完成）
//     ctl 可能返空 task_id；调用方按字面值透传，不做强校验。
type RenewPassResponse struct {
	PassID string `json:"pass_id"`
	TaskID string `json:"task_id"`
}

// === trade-pass-destroy DTO（设计稿 §3.5 / §4.5.2 / §4.5.3 / §10）===

// DestroyPassRequest 镜像 ctl/pkg/transport.DestroyPassRequest。
//
// 字段语义：
//   - FlowID（trade_flow_id）：trade_flow.id PK；ctl 父 task 收尾步 5c 调
//     `POST /internal/trade/flows/{flow_id}/complete` callback 推进 trade_flow.status 到 completed
//     （0 时跳过 callback；与 IsolatePassRequest.FlowID 同语义）
//   - DestroyReason：jifei `para.source` 透传值（biz/qn/other/空串；Q24 ✅ 拍板），
//     ctl 侧 destroyResource handler 把它带到父 task payload，收尾步 5b 写入
//     history_pass.destroy_reason 列。空串视为合法 tombstone。
type DestroyPassRequest struct {
	FlowID        int64  `json:"trade_flow_id,omitempty"`
	DestroyReason string `json:"destroy_reason,omitempty"`
}

// DestroyPassResponse 镜像 ctl/pkg/transport.DestroyPassResponse。
//
// 字段：
//   - PassID：回显请求路径里的 pass_id，便于排障
//   - TaskID：ctl 派发的 DestroyPass 父 task 的 task_id；trade 侧持久化到
//     trade_flow.response_body 便于排障（与 IsolatePass / RenewPass 同范式）
type DestroyPassResponse struct {
	PassID string `json:"pass_id"`
	TaskID string `json:"task_id"`
}

// ctl 侧 isolatePass 业务错误码（与 ctl/pkg/errcode/pass.go 对齐，便于 trade 上层 errors.As + Code 判定）。
//
// 调用方典型用法：
//
//	if errors.As(err, &ctlErr) && ctlErr.Code == ctlclient.ErrCodePassIsolating { ... }
const (
	ErrCodePassNotFound          = "PASS_NOT_FOUND"
	ErrCodePassIsolating         = "PASS_ISOLATING"
	ErrCodePassIsolated          = "PASS_ISOLATED"
	ErrCodePassInvalidParam      = "PASS_INVALID_PARAM"
	ErrCodePassRenewing          = "PASS_RENEWING"              // R-C：续费中（重入幂等保护）
	ErrCodePassNotRenewable      = "PASS_NOT_RENEWABLE"         // R-C：pass 已 isolated/deleted/超 12 月窗口
	ErrCodePassRenewNotImplement = "PASS_RENEW_NOT_IMPLEMENTED" // R-C：cvm-kind 异步路径占位 501

	// trade-pass-destroy 错误码（设计稿 §4.5.2 / §4.5.3 / §11-A Q1）：
	ErrCodePassTerminating = "PASS_TERMINATING" // pass 已在销毁主链中（重投幂等保护，trade 视为 idempotent 成功）
	ErrCodePassDeleting    = "PASS_DELETING"    // pass 已在用户主动销毁触发段（D-2.3 入口 A），不应出现在 destroyResource 链路
)

// Error 是 ctl HTTP 错误响应的强类型化封装。
//
// 调用方用 errors.As(err, &ctlclient.Error{}) 拿到结构化字段；
// HTTPStatus 用于区分 4xx（业务错，trade 透传）/ 5xx（基础设施错，trade 重试或 503）。
type Error struct {
	HTTPStatus int    // 上游 HTTP status
	Code       string // ctl errcode.Error.Code（如 "PASS_BUNDLE_OFFLINE" / "INVALID_PARAM"）
	Message    string // 人类可读消息
	RequestID  string // ctl 侧 request_id，用于跨服务日志串联
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("ctl http %d code=%s message=%q request_id=%s",
		e.HTTPStatus, e.Code, e.Message, e.RequestID)
}

// ErrNotFound 在 ctl 返回 404 时返回，方便调用方 errors.Is 判定。
//
// 典型场景：
//   - GetBundleByID 时 bundleID 在 ctl 不存在
//   - ListPassesByUser 时（理论不返 404，但保留兼容）
var ErrNotFound = errors.New("ctlclient: not found")

// ErrUnauthorized 在 ctl 返回 401 时返回，通常意味着 InternalServiceToken
// 与 ctl 配置的 CTL_INTERNAL_TOKEN 不一致 — 属于配置错而非业务错。
var ErrUnauthorized = errors.New("ctlclient: unauthorized")

// envelope 反序列化 ctl 的 successResponse / errorResponse 框架。
//
// ctl 侧 server.go 的 successResponse / errorResponse 都是 {code, message,
// request_id, data?, details?} 的形态，这里用一个 envelope 同时承载两种语义。
type envelope struct {
	Code      string          `json:"code"`
	Message   string          `json:"message"`
	RequestID string          `json:"request_id,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
	Details   any             `json:"details,omitempty"`
}

// httpClient 是 Client 的标准实现。
type httpClient struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

// Options 可选配置。空值走默认。
type Options struct {
	// HTTPClient 自定义底层客户端（注入 tracing transport 用）；
	// 默认为 &http.Client{Timeout: 4s}
	HTTPClient *http.Client
}

// New 构造 ctlclient.Client。
//
// 必填参数：
//   - baseURL：ctl 内部接入地址，如 http://ctl.lightclaw-svc.svc.cluster.local:8080
//   - internalServiceToken：与 ctl CTL_INTERNAL_TOKEN 一致的 Bearer token
func New(baseURL, internalServiceToken string, opts ...Options) Client {
	c := &httpClient{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		token:   strings.TrimSpace(internalServiceToken),
	}
	if len(opts) > 0 && opts[0].HTTPClient != nil {
		c.httpClient = opts[0].HTTPClient
	} else {
		c.httpClient = &http.Client{Timeout: 4 * time.Second}
	}
	return c
}

func (c *httpClient) GetBundleByID(ctx context.Context, bundleID string) (*BundleDetail, error) {
	if strings.TrimSpace(bundleID) == "" {
		return nil, fmt.Errorf("ctlclient: bundleID is required")
	}
	endpoint := c.baseURL + "/internal/ctl/bundles/" + url.PathEscape(bundleID)

	var detail BundleDetail
	if err := c.do(ctx, http.MethodGet, endpoint, nil, &detail); err != nil {
		return nil, err
	}
	return &detail, nil
}

func (c *httpClient) ListPassesByUser(ctx context.Context, externalUserID string) ([]*PassDetail, error) {
	if strings.TrimSpace(externalUserID) == "" {
		return nil, fmt.Errorf("ctlclient: externalUserID is required")
	}
	q := url.Values{}
	q.Set("external_user_id", externalUserID)
	endpoint := c.baseURL + "/internal/ctl/passes?" + q.Encode()

	// ctl 返回 {data: {passes: [...]}}, 这里反序列化到 listPassesResponse 桥接结构
	var resp struct {
		Passes []*PassDetail `json:"passes"`
	}
	if err := c.do(ctx, http.MethodGet, endpoint, nil, &resp); err != nil {
		return nil, err
	}
	return resp.Passes, nil
}

func (c *httpClient) CompletePass(ctx context.Context, req *CompletePassRequest) (*PassDetail, error) {
	if req == nil {
		return nil, fmt.Errorf("ctlclient: CompletePass req is nil")
	}
	endpoint := c.baseURL + "/internal/ctl/passes/complete"

	var detail PassDetail
	if err := c.do(ctx, http.MethodPost, endpoint, req, &detail); err != nil {
		return nil, err
	}
	return &detail, nil
}

func (c *httpClient) TransferPass(ctx context.Context, req *TransferPassRequest) (*PassDetail, error) {
	if req == nil {
		return nil, fmt.Errorf("ctlclient: TransferPass req is nil")
	}
	endpoint := c.baseURL + "/internal/ctl/passes/transfer"

	var detail PassDetail
	if err := c.do(ctx, http.MethodPost, endpoint, req, &detail); err != nil {
		return nil, err
	}
	return &detail, nil
}

// ListPassAppIDs 实现 jifei.getAllAppIds 反查（trade-resource-query-design §3.2 / §4）。
//
// 入参 bundleIDs 为 nil 或空时**不传** bundle_ids 查询参数（ctl SQL 不加过滤），
// 与 trade handler 处 subProductCode 空值语义一致（设计稿 §2.2 Q2 拍板）。
//
// 调用方应通过 ctx 设置 1.5s 超时（设计稿三层预算），ctlclient 不主动收紧。
func (c *httpClient) ListPassAppIDs(
	ctx context.Context,
	bundleIDs []string,
	pageNo, pageSize int,
) ([]int64, int64, error) {
	if pageSize <= 0 {
		return nil, 0, fmt.Errorf("ctlclient: pageSize must be > 0, got %d", pageSize)
	}
	if pageNo < 0 {
		return nil, 0, fmt.Errorf("ctlclient: pageNo must be >= 0, got %d", pageNo)
	}

	q := url.Values{}
	q.Set("page_no", strconv.Itoa(pageNo))
	q.Set("page_size", strconv.Itoa(pageSize))
	if len(bundleIDs) > 0 {
		// ctl 侧 parseCSVQueryParam 期望 CSV 格式（与 11A 一致）
		q.Set("bundle_ids", strings.Join(bundleIDs, ","))
	}
	endpoint := c.baseURL + "/internal/ctl/passes/app-ids?" + q.Encode()

	// ctl 返回 {data: {app_ids: [...], total: N}}
	var resp struct {
		AppIDs []int64 `json:"app_ids"`
		Total  int64   `json:"total"`
	}
	if err := c.do(ctx, http.MethodGet, endpoint, nil, &resp); err != nil {
		return nil, 0, err
	}
	return resp.AppIDs, resp.Total, nil
}

// ListPassesByAppID 实现 jifei.getUserResources 反查（trade-resource-query-design §3.2 / §4）。
//
// 调用方应通过 ctx 设置 1.5s 超时（设计稿三层预算）。
func (c *httpClient) ListPassesByAppID(
	ctx context.Context,
	appID int64,
	bundleIDs []string,
	pageNo, pageSize int,
) ([]*PassDetail, int64, error) {
	if appID <= 0 {
		return nil, 0, fmt.Errorf("ctlclient: appID must be > 0, got %d", appID)
	}
	if pageSize <= 0 {
		return nil, 0, fmt.Errorf("ctlclient: pageSize must be > 0, got %d", pageSize)
	}
	if pageNo < 0 {
		return nil, 0, fmt.Errorf("ctlclient: pageNo must be >= 0, got %d", pageNo)
	}

	q := url.Values{}
	q.Set("app_id", strconv.FormatInt(appID, 10))
	q.Set("page_no", strconv.Itoa(pageNo))
	q.Set("page_size", strconv.Itoa(pageSize))
	if len(bundleIDs) > 0 {
		q.Set("bundle_ids", strings.Join(bundleIDs, ","))
	}
	endpoint := c.baseURL + "/internal/ctl/passes/by-app?" + q.Encode()

	// ctl 返回 {data: {passes: [...], total: N}}
	var resp struct {
		Passes []*PassDetail `json:"passes"`
		Total  int64         `json:"total"`
	}
	if err := c.do(ctx, http.MethodGet, endpoint, nil, &resp); err != nil {
		return nil, 0, err
	}
	return resp.Passes, resp.Total, nil
}

// ListPassesByResourceIDs 实现 jifei.queryResource 反查（trade-resource-query-design §3.2 / §4）。
//
// PDF §1.2 约束：不存在的 / 已销毁的 pass 不返回（数组减少元素，不报错），
// 调用方应自行做"返回数 < 入参数"的差集处理（trade handler 直接按返回值映射 resources）。
//
// 入参 passIDs 校验：1 ≤ len ≤ 100（PDF §2.2 "至少支持 100 个资源"）；
// ctlclient 在此处做兜底校验，trade handler 应在前置层先做参数返回 400。
//
// 调用方应通过 ctx 设置 1.5s 超时（设计稿三层预算）。
func (c *httpClient) ListPassesByResourceIDs(
	ctx context.Context,
	appID int64,
	passIDs []string,
) ([]*PassDetail, error) {
	if appID <= 0 {
		return nil, fmt.Errorf("ctlclient: appID must be > 0, got %d", appID)
	}
	if len(passIDs) == 0 {
		return nil, fmt.Errorf("ctlclient: passIDs must not be empty")
	}
	if len(passIDs) > 100 {
		return nil, fmt.Errorf("ctlclient: passIDs exceed limit 100, got %d", len(passIDs))
	}

	endpoint := c.baseURL + "/internal/ctl/passes/by-resource-ids"
	body := struct {
		AppID   int64    `json:"app_id"`
		PassIDs []string `json:"pass_ids"`
	}{
		AppID:   appID,
		PassIDs: passIDs,
	}

	// ctl 返回 {data: {passes: [...]}} —— 此接口不带 total（按 ID 反查不分页）
	var resp struct {
		Passes []*PassDetail `json:"passes"`
	}
	if err := c.do(ctx, http.MethodPost, endpoint, body, &resp); err != nil {
		return nil, err
	}
	return resp.Passes, nil
}

// IsolatePass 实现 trade → ctl 反向调（Sub-4 / .tmp/trade-pass-isolate-design.md §3 + §11 Q22-I-E）。
//
// 路径：POST /internal/ctl/passes/{pass_id}/isolate（passID URL escape，避免特殊字符破坏路由）
// Body：req（当前为空结构体；nil 时本方法兜底空 IsolatePassRequest{}）
//
// 调用方应通过 ctx 设置 1.5s 超时（设计稿三层预算）。
func (c *httpClient) IsolatePass(
	ctx context.Context,
	passID string,
	req *IsolatePassRequest,
) (*IsolatePassResponse, error) {
	if strings.TrimSpace(passID) == "" {
		return nil, fmt.Errorf("ctlclient: passID is required")
	}
	if req == nil {
		req = &IsolatePassRequest{}
	}
	endpoint := c.baseURL + "/internal/ctl/passes/" + url.PathEscape(passID) + "/isolate"

	var detail IsolatePassResponse
	if err := c.do(ctx, http.MethodPost, endpoint, req, &detail); err != nil {
		return nil, err
	}
	return &detail, nil
}

// RenewPass 实现 Client（R-C；ctl 侧 endpoint 在 R-D 落地）。
//
// 路径：POST /internal/ctl/passes/{pass_id}/renew
// body：JSON-encoded RenewPassRequest
//
// R-D 落地前调用本方法会拿到 ctl 侧 404（路由未注册）→ ErrNotFound；
// 调用方（renewresource handler）按 B 类（让 jifei 重试）处理，等 R-D 上线后即可联调通。
func (c *httpClient) RenewPass(
	ctx context.Context,
	passID string,
	req *RenewPassRequest,
) (*RenewPassResponse, error) {
	if strings.TrimSpace(passID) == "" {
		return nil, fmt.Errorf("ctlclient: passID is required")
	}
	if req == nil {
		req = &RenewPassRequest{}
	}
	endpoint := c.baseURL + "/internal/ctl/passes/" + url.PathEscape(passID) + "/renew"

	var detail RenewPassResponse
	if err := c.do(ctx, http.MethodPost, endpoint, req, &detail); err != nil {
		return nil, err
	}
	return &detail, nil
}

// DestroyPass 实现 trade → ctl 反向调（trade-pass-destroy §3.5 / §4.5.2 / §4.5.3）。
//
// 路径：POST /internal/ctl/passes/{pass_id}/destroy（passID URL escape，避免特殊字符破坏路由）
// Body：JSON-encoded DestroyPassRequest（含 trade_flow_id + destroy_reason）
//
// 调用方应通过 ctx 设置 1.5s 超时（与 IsolatePass / RenewPass 同三层预算）。
func (c *httpClient) DestroyPass(
	ctx context.Context,
	passID string,
	req *DestroyPassRequest,
) (*DestroyPassResponse, error) {
	if strings.TrimSpace(passID) == "" {
		return nil, fmt.Errorf("ctlclient: passID is required")
	}
	if req == nil {
		req = &DestroyPassRequest{}
	}
	endpoint := c.baseURL + "/internal/ctl/passes/" + url.PathEscape(passID) + "/destroy"

	var detail DestroyPassResponse
	if err := c.do(ctx, http.MethodPost, endpoint, req, &detail); err != nil {
		return nil, err
	}
	return &detail, nil
}

// do 是统一的 HTTP 调用入口，承载序列化、鉴权、状态码识别、envelope 解包。
//
// out 必须是指针；nil out 表示忽略响应体的 data 字段。
func (c *httpClient) do(ctx context.Context, method, endpoint string, body any, out any) error {
	var bodyReader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("ctlclient: marshal request body: %w", err)
		}
		bodyReader = bytes.NewReader(raw)
	}

	httpReq, err := http.NewRequestWithContext(ctx, method, endpoint, bodyReader)
	if err != nil {
		return fmt.Errorf("ctlclient: build request: %w", err)
	}
	if body != nil {
		httpReq.Header.Set("Content-Type", "application/json")
	}
	httpReq.Header.Set("Accept", "application/json")
	if c.token != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.token)
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return fmt.Errorf("ctlclient: do request: %w", err)
	}
	defer resp.Body.Close()

	rawBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("ctlclient: read response: %w", err)
	}

	// 优先按 envelope 解析；若失败说明 ctl 返回了非标准结构（极少见，但保留兜底）
	var env envelope
	envParseErr := json.Unmarshal(rawBody, &env)

	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return fmt.Errorf("%w: status=%d code=%s message=%q request_id=%s",
			ErrUnauthorized, resp.StatusCode, env.Code, env.Message, env.RequestID)
	case resp.StatusCode == http.StatusNotFound:
		return fmt.Errorf("%w: status=%d code=%s message=%q request_id=%s",
			ErrNotFound, resp.StatusCode, env.Code, env.Message, env.RequestID)
	case resp.StatusCode >= 400:
		// 4xx / 5xx 业务错或基础设施错
		if envParseErr != nil {
			return &Error{
				HTTPStatus: resp.StatusCode,
				Code:       "",
				Message:    string(rawBody),
				RequestID:  "",
			}
		}
		return &Error{
			HTTPStatus: resp.StatusCode,
			Code:       env.Code,
			Message:    env.Message,
			RequestID:  env.RequestID,
		}
	}

	// 2xx 路径
	if envParseErr != nil {
		return fmt.Errorf("ctlclient: parse success envelope: %w body=%s", envParseErr, truncate(rawBody, 256))
	}
	if out == nil {
		return nil
	}
	if len(env.Data) == 0 || string(env.Data) == "null" {
		return nil
	}
	if err := json.Unmarshal(env.Data, out); err != nil {
		return fmt.Errorf("ctlclient: unmarshal data into %T: %w body=%s", out, err, truncate(env.Data, 256))
	}
	return nil
}

// truncate 截断 byte slice 用于 error 日志，避免巨型 body 干扰排障。
func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "...(truncated)"
}
