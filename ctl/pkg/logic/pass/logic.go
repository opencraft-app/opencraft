// Package pass 实现用户权益业务逻辑。
package pass

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"ctl/pkg/adapter/aigateway"
	adapterfactory "ctl/pkg/adapter/factory"
	"ctl/pkg/adapter/llmgateway"
	tradeadapter "ctl/pkg/adapter/trade"
	"ctl/pkg/authcode"
	"ctl/pkg/config"
	"ctl/pkg/errcode"
	bundlelogic "ctl/pkg/logic/bundle"
	"ctl/pkg/logic/gatewayroute"
	"ctl/pkg/logic/objectid"
	bundlemodel "ctl/pkg/model/bundle"
	modelfactory "ctl/pkg/model/factory"
	passmodel "ctl/pkg/model/pass"
	passmigrationmodel "ctl/pkg/model/passbillingmigration"
	"ctl/pkg/resource"
	"ctl/pkg/transport"

	"go.uber.org/zap"
	"gorm.io/gorm"
)

func trialSubscriptionIdempotencyKey(userID, bundleID string) string {
	return "trial:" + strings.TrimSpace(userID) + ":" + strings.TrimSpace(bundleID)
}

func tradeSubscriptionIdempotencyKey(dealName string) string {
	return "trade:" + strings.TrimSpace(dealName)
}

const (
	freeCreditSubscriptionNamePrefix = "free-credit:"
	// International payment URL generation can include auth credential
	// exchange, card lookup, order lookup, and CreatePayUrl. Keep the budget
	// below the common 60-second edge timeout while leaving room for fallback.
	payURLRequestTimeout = 50 * time.Second
)

func packageSubscriptionName(userID, passID string) string {
	return "package:" + strings.TrimSpace(userID) + ":" + strings.TrimSpace(passID)
}

func freeCreditSubscriptionName(source, idempotencyKey string) string {
	source = strings.TrimSpace(source)
	if source == "" {
		source = "manual"
	}
	return freeCreditSubscriptionNamePrefix + source + ":" + strings.TrimSpace(idempotencyKey)
}

type newPassSubscriptionRequest struct {
	IdempotencyKey   string
	UserID           string
	PlanID           string
	SubscriptionName string
	PeriodValue      int
	PeriodUnit       string
	IsUnique         bool
}

type newPassSubscription struct {
	ID      string
	PlanID  string
	Gateway gatewayroute.Gateway
}

func ensureNewPassGatewayUser(ctx context.Context, userID, nickname string) (bool, error) {
	if gatewayroute.NewAllocationGateway(userID) == gatewayroute.GatewayLLMGateway {
		resp, err := adapterfactory.DefaultAdapterFactory.LLMGatewayAdapter().EnsureUser(ctx, userID, nickname)
		if err != nil {
			return false, errcode.Wrap(errcode.ErrPassGatewaySubscriptionFailed, "ensure llmgateway user: %v", err)
		}
		return resp != nil && resp.Result == "created", err
	}
	resp, err := adapterfactory.DefaultAdapterFactory.AiGatewayAdapter().EnsureUser(ctx, userID, nickname)
	return resp != nil && resp.Result == "created", err
}

func applyNewPassGatewaySubscription(ctx context.Context, req newPassSubscriptionRequest) (*newPassSubscription, error) {
	if gatewayroute.NewAllocationGateway(req.UserID) == gatewayroute.GatewayLLMGateway {
		sub, err := adapterfactory.DefaultAdapterFactory.LLMGatewayAdapter().ApplySubscription(ctx, &llmgateway.ApplySubscriptionRequest{
			IdempotencyKey:   req.IdempotencyKey,
			UserID:           req.UserID,
			PlanID:           req.PlanID,
			SubscriptionName: req.SubscriptionName,
			IsUnique:         req.IsUnique,
		})
		if err != nil {
			return nil, errcode.Wrap(errcode.ErrPassGatewaySubscriptionFailed, "apply llmgateway subscription: %v", err)
		}
		if sub == nil {
			return nil, errcode.Wrap(errcode.ErrPassGatewaySubscriptionFailed, "apply llmgateway subscription returned empty subscription")
		}
		return &newPassSubscription{ID: sub.ID, PlanID: sub.PlanID, Gateway: gatewayroute.GatewayLLMGateway}, nil
	}

	sub, err := adapterfactory.DefaultAdapterFactory.AiGatewayAdapter().ApplySubscription(ctx, &aigateway.ApplySubscriptionRequest{
		IdempotencyKey: req.IdempotencyKey,
		UserID:         req.UserID,
		PlanID:         req.PlanID,
		PeriodValue:    req.PeriodValue,
		PeriodUnit:     req.PeriodUnit,
	})
	if err != nil {
		return nil, errcode.Wrap(errcode.ErrPassGatewaySubscriptionFailed, "apply ai-gateway subscription: %v", err)
	}
	if sub == nil {
		return nil, errcode.Wrap(errcode.ErrPassGatewaySubscriptionFailed, "apply ai-gateway subscription returned empty subscription")
	}
	return &newPassSubscription{ID: sub.ID, PlanID: sub.PlanID, Gateway: gatewayroute.GatewayAIGateway}, nil
}

// PassDetail 权益详情
type PassDetail struct {
	PassID       string
	UserID       string
	BundleID     string
	Uin          int64
	AppID        int64
	CreatedTime  time.Time
	ExpiredTime  time.Time
	IsolatedTime *time.Time
	DeletedTime  *time.Time
	UpdatedTime  time.Time

	// Status pass 状态机字段（trade-pass-isolate 引入；与 model/pass.Entity.Status 同源）。
	// 值域：active / isolating / isolated / deleting（详见 pass_handler.go DescribePass 文档）。
	// 用于前端展示 / trade 反查 / jifei 隔离状态联动。
	Status string

	// 以下字段运行时从 Bundle / ai-gateway / user_resource_quota 拉取填充，不持久化
	BundleName          string // 套餐名称（= bundle.bundle_name）
	CreditTotal         int64  // 套餐积分总量（active 且存在套餐订阅时 = bundle.credit）
	CreditAvailable     int64  // 积分余量（= token_balance / credit_token_ratio）
	FreeCreditTotal     int64  // 免费/额外积分总量（LLMGateway subscription_name=free-credit:*）
	FreeCreditAvailable int64  // 免费/额外积分余量（LLMGateway subscription_name=free-credit:*）

	// AgentQuotaTotal / AgentQuotaAvailable 是 Agent 席位配额（v1.7.23 B18 新增,
	// v1.7.24 B19 修订: 两值都从 user_resource_quota 表同一行取, 不再用 bundle.agent_quota）。
	//
	// AgentQuotaTotal     = user_resource_quota{resource_name=OPENCLAW_INSTANCE}.total
	//                       (CreatePassWithQuota 写入时 = bundle.agent_quota; 后台 ModifyBundle
	//                       改 agent_quota 不会反向同步刷 quota 表 — 以 quota 表为最终真源)
	// AgentQuotaAvailable = user_resource_quota{resource_name=OPENCLAW_INSTANCE}.available
	//                       (已扣减 Instance 占用后的剩余席位)
	//
	// 与 CreditTotal/CreditAvailable 同范式, 均由 fillCredit 实时拉取 (DB 不持久化到 pass 表)。
	AgentQuotaTotal     int64
	AgentQuotaAvailable int64

	// RenewFlag 续费标记（billing-integration B11A 新增；§11 Q10 拍板 2026-05-11）
	// 取值：MANUAL_RENEW / AUTO_RENEW；空字符串视为 MANUAL_RENEW
	RenewFlag string
}

// ModifyPassFields 可修改字段
type ModifyPassFields struct {
	BundleID    *string    `json:"bundle_id,omitempty"`
	ExpiredTime *time.Time `json:"expired_time,omitempty"`
}

// Logic Pass 业务逻辑接口
type Logic interface {
	// CreateTrialPass 为用户创建试用权益
	// 有效期由 Bundle 的 time_span + time_unit 决定，调用方不指定
	CreateTrialPass(userID string, bundleID string) (*PassDetail, error)

	// CompletePass 由 trade 服务在 jifei createResource 回调后反向调用 ctl，完成付费 pass 发货
	//
	// v4 收敛（billing-integration B3 新增）：
	//   - 入参 time_span / time_unit 由 trade 透传（来源于下单时的 trade_order，而非 bundle 字段）
	//   - 入参 uin / app_id 由 trade 透传，写入 ctl_pass 表（取代 CreateTrialPass 中的 TODO=0）
	//   - 入参 deal_name 仅日志记录用于排障，ctl_pass 表不持久化（归 trade_order 反查）
	//   - renew_flag 仅接受 AUTO_RENEW；缺失或其它值兜底 MANUAL_RENEW
	//   - 兜底防御：用户已有 active pass 直接报 ErrPassAlreadyExists（不做幂等，不依赖 pass_pending_order）
	CompletePass(req *transport.CompletePassRequest) (*PassDetail, error)

	// MigrateFreeTrialPassToBilling 尝试把存量 bundle_free_trial_01 pass 迁移成计费 bundle_launch_01。
	MigrateFreeTrialPassToBilling(req *transport.PassBillingMigrationRequest) (*transport.PassBillingMigrationResult, error)
	// TransferPassFromBilling 在 jifei transferResource 回调到达后绑定既有 pass 的计费归属。
	TransferPassFromBilling(req *transport.TransferPassRequest) (*PassDetail, error)

	// GrantFreeCredit 给用户发放免费/额外积分。实际落到 LLMGateway named subscription，
	// 过期时间跟随用户当前 active pass，不走 AI Gateway。
	GrantFreeCredit(req *transport.GrantFreeCreditRequest) (*transport.GrantFreeCreditResponse, error)

	// CreatePassOrder 创建付费 pass 订单（v1.7.31 拆分：仅下单，不再拉支付 URL）
	//
	// 用途：用户选择付费 bundle 后调本接口，由 ctl 反查 shadow 拿到 uin/appID，
	// 然后调 trade.PlaceOrder 下一笔 jifei 订单，返回 deal_names。
	// **本接口不创建本地 pass**：实际 pass 发货发生在 jifei 计费回调链路。
	CreatePassOrder(userID string, req *transport.CreatePassOrderRequest) (*transport.CreatePassOrderResult, error)

	// CreatePassOrderUrl 拉取支付 URL（v1.7.31 接口拆分新增）
	//
	// 用途：前端拿到 deal_names 后调本接口获取支付页 URL。
	// 支持透传 platform / wx_open_id 给 jifei getMidasEarmarking。
	CreatePassOrderUrl(userID string, req *transport.CreatePassOrderUrlRequest) (*transport.CreatePassOrderUrlResult, error)

	// CreatePassOrderAndPay 一体化创建付费 pass 订单 + 自动支付（billing-integration B2 新增）
	//
	// **仅用于联调测试 / 自动化 e2e，现网控制台禁止暴露给真实用户**。
	//
	// 与 CreatePassOrder 的差异：
	//   - CreatePassOrder：调 trade.PlaceOrder + trade.GeneratePayURL，返支付 URL，
	//     用户在浏览器付款后由 jifei 异步回调触发发货
	//   - CreatePassOrderAndPay：调 trade.PlaceOrderAndPay 一次完成 "下单 + 支付 +
	//     触发 createResource 回调"，跳过支付 URL；适合测试代金券充足的环境跑通
	//     trade ↔ jifei ↔ ctl.createResource 端到端链路，无需真人浏览器付款
	//
	// 与 CreatePassOrder 一致：**本接口不创建本地 pass**，pass 发货走相同的回调链路。
	CreatePassOrderAndPay(userID string, req *transport.CreatePassOrderRequest) (*transport.CreatePassOrderAndPayResult, error)

	// GetPasses 查询所有 Pass（后台管理用）
	GetPasses(userID *string, bundleID *string) ([]*PassDetail, error)
	GetPassesPage(userID *string, bundleID *string, status *string, page, pageSize int) ([]*PassDetail, int64, error)

	// ModifyPass 修改 Pass（如延期、换绑套餐）
	ModifyPass(passID string, req *ModifyPassFields) (*PassDetail, error)

	// DescribePasses 查询当前用户的 Pass 列表
	DescribePasses(userID string) ([]*PassDetail, error)

	// === jifei 反查接口三件套（billing-integration B11A 新增）===
	// 设计稿：.tmp/trade-resource-query-design.md §4.1
	//
	// 共同约定：
	//   - 反查链路不调 ai-gateway / bundle 填充 credit / bundle_name（jifei 协议不需要）
	//   - bundleIDs 入参为 nil 或空切片时 DAO 省略 IN 子句（Q2 拍板）
	//   - SLA：≤ 1.5s（§11 Q14 拍板）
	//   - 鉴权：仍走 CTL_INTERNAL_TOKEN bearer（与现有 /internal/ctl/passes 一致）

	// ListPassAppIDs 反查 jifei.getAllAppIds 所需 app_id 列表
	//
	// 入参：
	//   - bundleIDs：可空；trade 把 jifei 的 subProductCode 解析为 bundle_id 集合传入
	//   - pageNo：0-based
	//   - pageSize：1..20000（caller 已校验）
	ListPassAppIDs(bundleIDs []string, pageNo, pageSize int) (appIDs []int64, total int64, err error)

	// ListPassesByAppID 反查 jifei.getUserResources 所需 pass 列表（按 app_id 维度）
	//
	// 入参：
	//   - appID：> 0
	//   - bundleIDs：可空（同上）
	//   - pageNo：0-based
	//   - pageSize：1..1000（caller 已校验）
	ListPassesByAppID(appID int64, bundleIDs []string, pageNo, pageSize int) (details []*PassDetail, total int64, err error)

	// ListPassesByResourceIDs 反查 jifei.queryResource 所需 pass 列表（按 pass_id 集合）
	//
	// 入参：
	//   - appID：> 0
	//   - passIDs：1..100（caller 已校验非空 + 上限）
	ListPassesByResourceIDs(appID int64, passIDs []string) ([]*PassDetail, error)

	// DescribePassByCloudAccount 供云 API DescribePass 按影子账号 + pass_id 精确反查 pass。
	//
	// 入参：
	//   - uin / appID：影子账号归属，必须与 pass 表记录一致
	//   - passID：pass 业务主键
	//
	// 归属不匹配按 ErrPassNotFound 处理，避免对外暴露 pass 是否存在。
	DescribePassByCloudAccount(uin, appID int64, passID string) (*PassDetail, error)

	// IsolatePass 受 trade 反向调用，把 pass 推入 isolating 状态并派发后台 task 完成实际隔离。
	//
	// 设计稿：.tmp/trade-pass-isolate-design.md §10 Q22-I-E / Q23 / Q35
	//   + .tmp/jifei_pdf_txt/预付费资源隔离接口+-+isolateResource.md §2.2 退费场景（v1.7.30 BUG-35）
	//
	// 行为：
	//   1. CAS pass.status active → isolating（已是 isolating/isolated 时返回 ErrPassAlreadyIsolating/Isolated）
	//   2. 退费分支校验：newDeadline != nil 时，pass.expired_time 必须严格 > *newDeadline
	//      （退费只能压缩到期时间，不可拉长）→ 不满足返 ErrPassNewDeadlineInvalid
	//   3. enqueue 父 task IsolatePass 异步推进（透传 newDeadline + dealName 给父 task）
	//
	// 入参：
	//   - passID：pass 业务主键
	//   - tradeFlowID：trade 侧 trade_flow.id PK（端到端闭环 2026-05-15）；
	//     > 0 时父 task 终态会 best-effort 反向调 trade `/internal/trade/flows/{flow_id}/complete`；
	//     == 0 时父 task 终态不发 callback（兼容 dev/test / 直连场景）。
	//   - newDeadline：jifei 退费场景传入的"新到期时间"（UTC time.Time，trade 侧已从北京时间字面值解析）；
	//     nil = 生命周期隔离（父 task 终态不动 pass.expired_time）；非 nil = 退费隔离（父 task 终态同事务写 pass.expired_time）。
	//   - dealName：jifei 退费场景传入的子订单号（仅日志透传，不参与状态机）。
	//
	// 返回 taskID 让 caller (trade) 串联 trade_flow.task_ref 做后续轮询查询。
	// 鉴权由 transport 层 requireInternalBearer 承担。
	IsolatePass(passID string, tradeFlowID int64, newDeadline *time.Time, dealName string) (taskID string, err error)

	// RenewPass 由 trade 服务在 jifei renewResource 回调后反向调用 ctl，完成续费状态推进。
	// 设计稿：.tmp/trade-pass-renew-design.md §3.1 / §3.4 v3.8
	//
	// 双分支语义（基于 pass.status 路由）：
	//   - status == 'active'   → 分支 A（提前续费同步路径）：
	//       同步计算 newExpiredTime = CalcExpiredTime(pass.expired_time, timeSpan, timeUnit)
	//       并 CAS UPDATE pass.expired_time（status 仍 active），不入队 task。
	//       返回 (taskID="", accepted=true, nil)；trade callback CompleteFlow(flow_id, completed)。
	//   - status == 'isolated' → 分支 B（到期续费异步路径）：
	//       CAS isolated → renewing；不动 expired_time / isolated_time
	//       （new_expired 在父 task all-success 后才用 isolated_time 为基线计算 — Q2=a）。
	//       入队 RenewPassTask 父任务，返回 (taskID, accepted=true, nil)；trade_flow 仍 in_progress。
	//
	// 异常分支：
	//   - status == 'renewing'  → 拒收 ErrPassRenewing（trade 层据此返 returnCode=352014 + DeliveryFailRefund）
	//   - status == 'isolating' → 拒收 ErrPassIsolating（隔离进行中不能续费）
	//   - pass 不存在 / status 不在可续费集合 → 拒收 ErrPassNotFound / ErrPassNotRenewable
	//   - timeSpan/timeUnit 校验失败 → ErrPassInvalidParam
	//
	// tradeFlowID 与 IsolatePass 同语义：> 0 时 task 终态 best-effort 反向 callback；== 0 时不发 callback。
	//
	// 鉴权由 transport 层 requireInternalBearer 承担。
	//
	// R-D-1 起异步分支（pass.status='isolated'）已落地完整闭环：
	//   - CAS isolated → renewing（与 IsolatePass 的 active→isolating 拿锁语义对偶）
	//   - 入队父 task RenewPassTask（30s × 极大兜底，与 IsolatePass 父 task 同节奏）
	//   - 父 task 终态时计算 new_expired = CalcExpiredTime(pass.expired_time, ...)（基线 = expired_time，
	//     v1.7.20 B15 修订；原设计稿 §12 Q2=a 写 isolated_time 已废弃）
	//     一次性 UPDATE status='active' + expired_time + isolated_time=NULL
	RenewPass(passID string, tradeFlowID int64, timeSpan int, timeUnit string) (taskID string, accepted bool, err error)

	// RenewPassOrderUrl 拉取续费支付 URL（v1.7.31 接口拆分改造）
	//
	// 用途：前端拿到 deal_names 后调本接口获取续费支付页 URL。
	// 支持透传 platform / wx_open_id 给 jifei getMidasEarmarking。
	// 需校验 pass 持有人匹配（deal_name 本身不含 pass 归属信息）。
	RenewPassOrderUrl(userID, passID string, req *transport.RenewPassOrderUrlRequest) (*transport.RenewPassOrderUrlResult, error)

	// RenewPassOrder 续费下单（v1.7.31 接口拆分新增）
	//
	// 用途：用户点击"续费"按钮后，前端调本接口仅下单，返回 deal_names。
	// **本接口不修改本地 pass** — pass.status 推进由 jifei → trade.renewResource → ctl.RenewPass 链路触发。
	RenewPassOrder(userID, passID string, req *transport.RenewPassOrderRequest) (*transport.RenewPassOrderResult, error)
	// RenewPassOrderAndPay 一体化创建续费 pass 订单 + 自动支付（trade-pass-renew §3.3 / §4.4 / R-D-7）
	//
	// **仅用于联调测试 / 自动化 e2e，现网控制台禁止暴露给真实用户**。
	//
	// 与 RenewPassOrderUrl 的差异（与 CreatePassOrderAndPay vs CreatePassOrder 同范式）：
	//   - RenewPassOrderUrl     → trade.PlaceRenewOrder + trade.GeneratePayURL，返支付 URL，
	//     用户在浏览器付款后由 jifei 异步回调触发续费推进
	//   - RenewPassOrderAndPay  → trade.PlaceRenewOrderAndPay 一次完成"下单 + 支付 +
	//     触发 checkRenew/renewResource 回调"，跳过支付 URL；适合测试代金券充足的环境
	//     跑通 trade ↔ jifei ↔ ctl.RenewPass 端到端链路，无需真人浏览器付款
	//
	// 复用 transport.RenewPassOrderRequest 作为入参（与 CreatePassOrderAndPay 复用
	// CreatePassOrderRequest 同范式）；不修改本地 pass 表，pass.status 推进由
	// jifei → trade.renewResource → ctl.RenewPass 链路触发。
	//
	// 鉴权：transport 层校验用户是 pass 当前持有人（与 RenewPassOrderUrl 一致）。
	RenewPassOrderAndPay(userID, passID string, req *transport.RenewPassOrderRequest) (*transport.RenewPassOrderAndPayResult, error)

	// RenewPassPrice 续费询价（v1.7.21 B16 / R-C-4）
	//
	// 用途：用户在控制台续费页选择续费时长（如 1 个月 / 3 个月）后，由前端调本接口拿
	// 当前 bundle 的续费价格用于展示，不下单不付款。前端确认价格后再调 RenewPassOrderUrl
	// 走真实下单流程。
	//
	// 与 RenewPassOrderUrl 的对偶关系：
	//   - RenewPassOrderUrl  → trade.PlaceRenewOrder  + trade.GeneratePayURL  (续费下单)
	//   - RenewPassPrice     → trade.InquiryRenew                              (续费询价，本方法)
	//
	// 与 CreatePassOrder / DescribeBundles 询价的对偶关系：
	//   - 新购询价：DescribeBundles → ctl.fillCredits → trade.InquiryBatch (Action="purchase")
	//   - 续费询价：RenewPassPrice                  → trade.InquiryRenew  (Action="renew")
	//
	// 关键约束（用户 2026-05-20 拍板 b）：
	//   - **不允许换 bundle**：续费只能续当前 pass.bundle_id，req 不带 bundle_id
	//   - CurDeadline 由本方法内部从 passEntity.ExpiredTime 拼字符串透传给 trade（与
	//     RenewPassOrderUrl 同源策略：真源严格在 ctl DB pass.expired_time，前端不感知）
	//
	// **本接口不创建/修改本地 pass** — 询价是无副作用 RPC（与 DescribeBundles 同语义）。
	//
	// 鉴权：transport 层校验用户是 pass 当前持有人（与 RenewPassOrderUrl 一致）。
	RenewPassPrice(userID, passID string, req *transport.RenewPassPriceRequest) (*transport.RenewPassPriceResult, error)

	// DeletePass 由前端控制台用户主动触发销毁（trade-pass-destroy 入口 A）
	//
	// 设计稿：.tmp/trade-pass-destroy-design.md §3.5 / §4.5.1 / §11-A Q1 / Q2 / Q26 / Q27
	//
	// 流程（与 IsolatePass 同范式但不派 task）：
	//   1. 校验 pass 存在 + 归属 userID（防越权销毁；前端入口 X-User-Id 鉴权后透传）
	//   2. CAS pass.status: isolated → deleting（同步落 DB）
	//   3. 同步调 trade.DeleteResource(passID, uin, appID, bundleID)
	//      → trade 内部反查 BundleDefinition 取 ProductCode + SubProductCode（Q26 + Q27 修订），
	//        调 jifei.ModifyResourceStatus(operateName=PRE_DESTROY) 通知销毁意图
	//   4. trade 返成功 → 返 PassDetail（含 status='deleting'）；前端按钮可灰化、文案改为"销毁中"
	//   5. trade 调用失败 → pass 留在 deleting 不回滚（设计稿 §4.2 拍板：监控兜底 + 人工干预）
	//
	// **不派任何 task**（Q2 拍板）：销毁主链由 jifei 异步回调 trade.destroyResource → ctl.DestroyPass
	// 启动；本接口仅承担"用户态触发 + 通知 jifei"的前置阶段。
	//
	// 错误码：
	//   - ErrPassInvalidParam：userID/passID 缺失
	//   - ErrPassNotFound：pass 不存在或不归当前用户
	//   - ErrPassNotIsolated：当前 status ≠ isolated（可能是 active/isolating/renewing）
	//   - ErrPassDeleting：CAS 失败因当前 status='deleting'（重复点击销毁按钮，幂等防重）
	//   - ErrPassTerminating：CAS 失败因当前 status='terminating'（销毁主链已启动）
	//   - 5xx：DB / trade adapter 异常
	//
	// 鉴权：transport 层校验用户是 pass 当前持有人（与 RenewPassOrderUrl 一致）。
	DeletePass(userID, passID string) (*PassDetail, error)

	// RefundPass 为指定 pass 发起退款（trade-pass-refund-design.md v0.5 §3 + §11 拍板项汇总）。
	//
	// 链路：admin → ctl.RefundPass → trade.RefundResource → jifei.OnlineRefund → 同步返 dealName/bigDealId。
	//
	// 前置校验（Q1=a/Q2=a 拍板）：
	//   - passID 必填
	//   - pass 必须存在且 status='active'
	//   - pass.expired_time > NOW()（未过期，jifei 仅退在保资源）
	//   - pass.uin > 0 && pass.app_id > 0（付费 pass；试用 pass 不走 jifei OnlineRefund）
	//
	// 关键不变量（Q3=b 拍板）：本接口**不写** pass.status / expired_time / isolated_time；
	// 最终落地由 jifei 异步回 isolateResource(billingIsolateType=refund) 触发现有
	// v1.7.30 BUG-35 退费分支 → IsolatePass 路径 → active→isolating→isolated + 写 expired_time。
	//
	// 错误码：
	//   - ErrPassInvalidParam：passID 缺失
	//   - ErrPassNotFound：pass 不存在
	//   - ErrPassNotActive：status ≠ active（含 isolated/deleting/terminating/renewing 等）
	//   - ErrPassExpired：pass.expired_time <= NOW()
	//   - ErrPassTrialNotRefundable：试用 pass（uin/app_id=0）
	//   - 5xx：trade adapter 异常（含 jifei 业务错 / 上游 502 等）
	//
	// 鉴权：仅 admin 后台入口暴露（Q1=a 拍板，用户面不开）；transport 层走 admin 鉴权而非 user 校验。
	RefundPass(passID string, operatorUin int64, reason string) (*RefundResult, error)

	// DestroyPass 销毁主链入口（trade.destroyResource handler 反向调）— 入口 A 与入口 B 共享
	//
	// 设计稿：.tmp/trade-pass-destroy-design.md §3.5 / §4.5.2 / §4.5.3 / §11-A Q1 / Q2 / Q24
	//
	// 双源 from CAS 推进 pass.status：
	//   - 入口 A（用户主动销毁后续段）：deleting → terminating
	//   - 入口 B（计费侧销毁回调）：     isolated → terminating（跳过 deleting）
	//
	// 行为（与 IsolatePass 同范式）：
	//   1. 入参强校验（passID 必填）
	//   2. CAS 拿锁 deleting∨isolated → terminating（dao.TryAcquireSlotForTerminate）
	//   3. 入队销毁父 task DestroyPassTask 异步推进（30s × 极大兜底，"永不放弃"）
	//   4. 返 taskID 让 trade 串联 trade_flow.task_ref 后续轮询查询
	//
	// 入参：
	//   - passID：pass 业务主键
	//   - tradeFlowID：trade 侧 trade_flow.id PK；> 0 时父 task 终态 best-effort 反向调
	//     `POST /internal/trade/flows/{flow_id}/complete` callback；== 0 兼容 dev/test/直连场景
	//   - destroyReason：jifei `para.source` 透传值（biz/qn/other/空串），父 task 收尾步 5b 写入
	//     history_pass.destroy_reason（设计稿 Q24 ✅ 拍板）；空串视为合法 tombstone（用户控制台
	//     DeletePass 入口未经 jifei 二次回标的兜底场景）。
	//
	// 错误码：
	//   - ErrPassInvalidParam：passID 缺失
	//   - ErrPassNotFound：pass 不存在（CAS 失败后 GetByPassID 也无记录）
	//   - ErrPassTerminating：CAS 失败因当前 status 已是 terminating（幂等成功语义；
	//     trade 侧重投或并发抢占都会命中此分支，让上层视情况返 200/idempotent）
	//   - 其它：用 errcode.Wrap 包成 ErrPassInvalidParam / ErrPassNotFound 由 transport 层映射 5xx
	//
	// 鉴权：transport 层 requireInternalBearer（trade 出向带 CTL_INTERNAL_TOKEN）。
	DestroyPass(passID string, tradeFlowID int64, destroyReason string) (taskID string, err error)
}

type logic struct {
	bundleLogic bundlelogic.Logic
}

const allowedFreeTrialBundleID = "bundle_free_trial_01"
const billingMigrationTargetBundleID = "bundle_launch_01"

// NewLogic 创建 Pass Logic
func NewLogic() Logic {
	return &logic{
		bundleLogic: bundlelogic.NewLogic(),
	}
}

func (l *logic) CreateTrialPass(userID string, bundleID string) (*PassDetail, error) {
	if userID == "" || bundleID == "" {
		return nil, errcode.ErrPassInvalidParam
	}
	if bundleID != allowedFreeTrialBundleID {
		return nil, errcode.ErrPassTrialBundleNotAllowed
	}
	if err := ensureShadowBindingIfRequired(userID, errcode.ErrPassShadowBindingRequired); err != nil {
		return nil, err
	}

	// 步骤 1：校验 Bundle 存在且 ONLINE
	bundle, err := l.bundleLogic.GetBundleByID(bundleID)
	if err != nil {
		return nil, err
	}
	if bundle.BundleState != bundlemodel.StateOnline {
		return nil, errcode.ErrPassBundleOffline
	}

	// 步骤 2：静态售罄校验
	if bundle.StaticSoldOut {
		return nil, errcode.ErrPassBundleSoldOut
	}

	agentQuota := bundle.AgentQuota

	// 步骤 3：用户唯一 Pass 校验
	passDao := modelfactory.DefaultDaoFactory.PassDao(nil)
	existing, err := passDao.ListByUserID(userID)
	if err != nil {
		return nil, fmt.Errorf("check existing pass: %w", err)
	}
	if len(existing) > 0 {
		return nil, errcode.ErrPassAlreadyExists
	}

	// 步骤 4：配额校验
	quotaDao := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(nil)
	quotaEntity, err := quotaDao.SelectQuota(userID, "OPENCLAW_INSTANCE", "")
	if err != nil {
		return nil, fmt.Errorf("check quota: %w", err)
	}
	if quotaEntity != nil {
		consumed := quotaEntity.ResourceQuotaTotal - quotaEntity.ResourceQuotaAvailable
		if consumed > agentQuota {
			return nil, errcode.ErrPassQuotaExceeded
		}
	}

	// 步骤 5：在当前环境选定的网关中确保业务用户存在。
	ensureCtx, ensureCancel := context.WithTimeout(context.Background(), 10*time.Second)
	resource.ZapLogger.Info("pass ensure-user started",
		zap.String("user_id", userID),
		zap.String("bundle_id", bundleID),
	)
	created, ensureErr := ensureNewPassGatewayUser(ensureCtx, userID, "")
	ensureCancel()
	if ensureErr != nil {
		resource.ZapLogger.Warn("pass ensure-user failed",
			zap.String("user_id", userID),
			zap.String("bundle_id", bundleID),
			zap.Error(ensureErr),
		)
		return nil, fmt.Errorf("ensure gateway user: %w", ensureErr)
	}
	resource.ZapLogger.Info("pass ensure-user succeeded",
		zap.String("user_id", userID),
		zap.String("bundle_id", bundleID),
		zap.Bool("created", created),
	)

	// 步骤 6：扣减 bundle 可售卖余量（原子操作，并发安全）
	bundleDao := modelfactory.DefaultDaoFactory.BundleDao(nil)
	ok, err := bundleDao.DecrementAvailCount(bundleID, 1)
	if err != nil {
		return nil, fmt.Errorf("decrement bundle avail count: %w", err)
	}
	if !ok {
		return nil, errcode.ErrBundleSalesQuotaEmpty
	}
	// 后续流程失败时回滚 available_count
	bundleQuotaDeducted := true
	defer func() {
		if bundleQuotaDeducted {
			_ = bundleDao.IncrementAvailCount(bundleID, 1)
		}
	}()

	// 步骤 7：生成 pass_id
	idGenDao := modelfactory.DefaultDaoFactory.IdGenDao(nil)
	autoID, err := idGenDao.GenId("pass")
	if err != nil {
		return nil, fmt.Errorf("generate pass auto id: %w", err)
	}
	password := "passmon" + config.ServerConf.MiscConfig.ObjectIdPasswordSuffix
	region := config.ServerConf.MiscConfig.Region
	passID, err := objectid.GeneratePassID(autoID, password, region)
	if err != nil {
		return nil, fmt.Errorf("generate pass id: %w", err)
	}

	// 步骤 8：计算 expired_time（由 bundle.time_span + time_unit 决定）
	now := time.Now().UTC()
	expiredTime, err := CalcExpiredTime(now, bundle.TimeSpan, bundle.TimeUnit)
	if err != nil {
		return nil, fmt.Errorf("calc expired_time: %w", err)
	}

	// 步骤 9：确保 AI 权益存在。LLMGateway 使用长期订阅，业务有效期只由 ctl
	// 的 pass 管理；legacy ai-gateway 在迁移期仍接收原周期。
	subscriptionEnsured := false
	if bundle.Credit > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		sub, subErr := applyNewPassGatewaySubscription(ctx, newPassSubscriptionRequest{
			IdempotencyKey:   trialSubscriptionIdempotencyKey(userID, bundleID),
			UserID:           userID,
			PlanID:           bundle.AiGatewayPlanID,
			SubscriptionName: packageSubscriptionName(userID, passID),
			PeriodValue:      bundle.TimeSpan,
			PeriodUnit:       bundle.TimeUnit,
			IsUnique:         true,
		})
		cancel()
		if subErr != nil {
			return nil, fmt.Errorf("apply gateway subscription: %w", subErr)
		}
		subscriptionEnsured = true
		if sub != nil {
			gatewayroute.RecordBestEffort(resource.ZapLogger, userID, sub.Gateway, sub.ID, sub.PlanID, gatewayroute.SourceApplySubscription)
			resource.ZapLogger.Info("pass subscription applied",
				zap.String("pass_id", passID),
				zap.String("user_id", userID),
				zap.String("plan_id", bundle.AiGatewayPlanID),
				zap.String("subscription_id", sub.ID),
			)
		}
	}

	// 步骤 10：事务写入 pass + quota
	entity := &passmodel.Entity{
		PassID:      passID,
		UserID:      userID,
		BundleID:    bundleID,
		Uin:         0, // TODO: 后续从 shadow binding 获取（试用 pass）
		AppID:       0, // TODO: 后续从 shadow binding 获取（试用 pass）
		ExpiredTime: expiredTime,
		RenewFlag:   passmodel.RenewFlagManual, // v4 收敛：试用 pass 默认手动续费
		Status:      passmodel.StatusActive,    // v1.7.28 BUG-17 修复：显式写 active，避免 gorm 用 Go zero value 覆盖 DB DEFAULT
	}

	if err := passDao.CreatePassWithQuota(entity, userID, agentQuota); err != nil {
		return nil, compensateEnsuredEntitlement(
			resource.ZapLogger,
			userID,
			subscriptionEnsured,
			fmt.Errorf("create pass with quota: %w", err),
		)
	}

	// 步骤 11：创建成功，取消回滚
	bundleQuotaDeducted = false

	// 步骤 12：返回（首次创建，credit_available = credit_total）
	saved, err := passDao.GetByPassID(passID)
	if err != nil {
		return nil, fmt.Errorf("read back pass: %w", err)
	}
	detail := entityToDetail(saved)
	detail.BundleName = bundle.BundleName
	detail.CreditTotal = bundle.Credit
	detail.CreditAvailable = bundle.Credit
	return detail, nil
}

func (l *logic) MigrateFreeTrialPassToBilling(req *transport.PassBillingMigrationRequest) (*transport.PassBillingMigrationResult, error) {
	if req == nil || strings.TrimSpace(req.UserID) == "" || req.Uin <= 0 || req.AppID <= 0 {
		return nil, errcode.ErrPassInvalidParam
	}

	userID := strings.TrimSpace(req.UserID)
	passDao := modelfactory.DefaultDaoFactory.PassDao(nil)
	passes, err := passDao.ListByUserID(userID)
	if err != nil {
		return nil, fmt.Errorf("pass billing migration list passes: %w", err)
	}
	if len(passes) == 0 {
		return &transport.PassBillingMigrationResult{Status: "skipped_no_pass", Message: "user has no pass"}, nil
	}

	candidate, skipped := selectPassForBillingMigration(passes)
	if candidate == nil {
		return skipped, nil
	}

	migrationDao := passmigrationmodel.NewDao()
	migration, err := migrationDao.GetByPassAndTarget(candidate.PassID, billingMigrationTargetBundleID)
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, fmt.Errorf("pass billing migration get state: %w", err)
	}
	if err == nil && migration != nil && migration.Status == passmigrationmodel.StatusCompleted {
		return &transport.PassBillingMigrationResult{
			Status:     "already_migrated",
			PassID:     candidate.PassID,
			BundleID:   billingMigrationTargetBundleID,
			DealName:   stringValue(migration.DealName),
			BigOrderID: stringValue(migration.BigOrderID),
		}, nil
	}
	if err == nil && migration != nil && migration.Status == passmigrationmodel.StatusPendingTransfer {
		return &transport.PassBillingMigrationResult{
			Status:     passmigrationmodel.StatusPendingTransfer,
			PassID:     candidate.PassID,
			BundleID:   billingMigrationTargetBundleID,
			DealName:   stringValue(migration.DealName),
			BigOrderID: stringValue(migration.BigOrderID),
		}, nil
	}

	if candidate.BundleID != allowedFreeTrialBundleID {
		if err == nil && migration != nil && migration.Status == passmigrationmodel.StatusFailed {
			return l.callTradeMoveIn(candidate, req, migrationDao)
		}
		return &transport.PassBillingMigrationResult{
			Status:   "already_migrated",
			PassID:   candidate.PassID,
			BundleID: candidate.BundleID,
			Message:  "pass is not free trial",
		}, nil
	}

	if _, err := l.bundleLogic.GetBundleByID(billingMigrationTargetBundleID); err != nil {
		return nil, err
	}
	record := passmigrationmodel.New(candidate.PassID, userID, allowedFreeTrialBundleID, billingMigrationTargetBundleID, req.Uin, req.AppID, passmigrationmodel.StatusPendingTransfer)
	if err := migrationDao.Upsert(record); err != nil {
		return nil, fmt.Errorf("pass billing migration persist state: %w", err)
	}

	return l.callTradeMoveIn(candidate, req, migrationDao)
}

func selectPassForBillingMigration(passes []*passmodel.Entity) (*passmodel.Entity, *transport.PassBillingMigrationResult) {
	var free, target, paid *passmodel.Entity
	for _, p := range passes {
		if p == nil {
			continue
		}
		switch {
		case p.BundleID == allowedFreeTrialBundleID && p.Status == passmodel.StatusActive:
			if free == nil {
				free = p
			}
		case p.BundleID == billingMigrationTargetBundleID:
			if target == nil {
				target = p
			}
		case p.BundleID != allowedFreeTrialBundleID:
			if paid == nil {
				paid = p
			}
		}
	}
	if free != nil {
		return free, nil
	}
	if target != nil {
		return target, nil
	}
	if paid != nil {
		return nil, &transport.PassBillingMigrationResult{Status: "skipped_paid_pass", PassID: paid.PassID, BundleID: paid.BundleID, Message: "user already has paid pass"}
	}
	return nil, &transport.PassBillingMigrationResult{Status: "skipped_no_active_free_pass", Message: "user has no active free trial pass"}
}

func (l *logic) callTradeMoveIn(candidate *passmodel.Entity, req *transport.PassBillingMigrationRequest, migrationDao passmigrationmodel.Dao) (*transport.PassBillingMigrationResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tradeAdapter := adapterfactory.DefaultAdapterFactory.TradeAdapter()
	resp, err := tradeAdapter.MoveInOrderAndPay(ctx, &tradeadapter.MoveInOrderRequest{
		ExternalUserID: req.UserID,
		Uin:            strconv.FormatInt(req.Uin, 10),
		AppID:          strconv.FormatInt(req.AppID, 10),
		BundleID:       billingMigrationTargetBundleID,
		ResourceID:     candidate.PassID,
		CurDeadline:    formatCurDeadlineForJifei(candidate.ExpiredTime),
	})
	if err != nil {
		msg := truncateString(err.Error(), 1024)
		_ = migrationDao.DeleteByPassAndTargetAndStatus(candidate.PassID, billingMigrationTargetBundleID, passmigrationmodel.StatusPendingTransfer)
		resource.ZapLogger.Warn("pass billing migration move-in failed",
			zap.String("user_id", req.UserID),
			zap.String("pass_id", candidate.PassID),
			zap.Error(err),
		)
		return &transport.PassBillingMigrationResult{Status: "failed", PassID: candidate.PassID, BundleID: billingMigrationTargetBundleID, Message: msg}, nil
	}

	return &transport.PassBillingMigrationResult{Status: passmigrationmodel.StatusPendingTransfer, PassID: candidate.PassID, BundleID: billingMigrationTargetBundleID, DealName: resp.DealName, BigOrderID: resp.BigOrderID}, nil
}

func (l *logic) TransferPassFromBilling(req *transport.TransferPassRequest) (*PassDetail, error) {
	if err := validateTransferPassRequest(req); err != nil {
		return nil, err
	}

	passID := strings.TrimSpace(req.PassID)
	userID := strings.TrimSpace(req.UserID)
	sourceBundleID := strings.TrimSpace(req.SourceBundleID)
	if sourceBundleID == "" {
		sourceBundleID = allowedFreeTrialBundleID
	}
	targetBundleID := strings.TrimSpace(req.TargetBundleID)
	dealName := strings.TrimSpace(req.DealName)
	bigOrderID := strings.TrimSpace(req.BigOrderID)

	var saved passmodel.Entity
	if err := resource.GormDB.Transaction(func(tx *gorm.DB) error {
		var passEntity passmodel.Entity
		if err := tx.Table(passmodel.TableName).
			Where(passmodel.ColumnPassID+" = ?", passID).
			Take(&passEntity).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return errcode.ErrPassNotFound
			}
			return fmt.Errorf("pass billing transfer get pass: %w", err)
		}
		if userID != "" && passEntity.UserID != userID {
			return errcode.Wrap(errcode.ErrPassInvalidParam, "pass %s does not belong to user %s", passID, userID)
		}

		var migration passmigrationmodel.Entity
		if err := tx.Table(passmigrationmodel.TableName).
			Where(passmigrationmodel.ColumnPassID+" = ? AND "+passmigrationmodel.ColumnTargetBundleID+" = ?", passID, targetBundleID).
			Take(&migration).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return errcode.Wrap(errcode.ErrPassInvalidParam, "pass billing migration state not found")
			}
			return fmt.Errorf("pass billing transfer get migration state: %w", err)
		}
		if migration.Status != passmigrationmodel.StatusPendingTransfer &&
			migration.Status != passmigrationmodel.StatusPendingOrder &&
			migration.Status != passmigrationmodel.StatusCompleted {
			return errcode.Wrap(errcode.ErrPassInvalidParam, "pass billing migration status %s is not transferable", migration.Status)
		}

		if passEntity.BundleID == targetBundleID && passEntity.Uin == req.NewUin && passEntity.AppID == req.NewAppID {
			if err := markBillingMigrationCompleted(tx, passID, targetBundleID, dealName, bigOrderID); err != nil {
				return err
			}
			saved = passEntity
			return nil
		}
		if passEntity.BundleID != sourceBundleID {
			return errcode.Wrap(errcode.ErrPassInvalidParam, "pass bundle mismatch: got %s, want %s", passEntity.BundleID, sourceBundleID)
		}
		if passEntity.Status != passmodel.StatusActive {
			return errcode.Wrap(errcode.ErrPassInvalidParam, "pass status must be active, got %s", passEntity.Status)
		}

		updates := map[string]interface{}{
			passmodel.ColumnBundleID: targetBundleID,
			passmodel.ColumnUin:      req.NewUin,
			passmodel.ColumnAppID:    req.NewAppID,
		}
		result := tx.Table(passmodel.TableName).
			Where(passmodel.ColumnPassID+" = ?", passID).
			Updates(updates)
		if result.Error != nil {
			return fmt.Errorf("pass billing transfer update pass: %w", result.Error)
		}
		if result.RowsAffected == 0 {
			return errcode.ErrPassNotFound
		}
		if err := markBillingMigrationCompleted(tx, passID, targetBundleID, dealName, bigOrderID); err != nil {
			return err
		}

		passEntity.BundleID = targetBundleID
		passEntity.Uin = req.NewUin
		passEntity.AppID = req.NewAppID
		saved = passEntity
		return nil
	}); err != nil {
		return nil, err
	}

	return entityToDetail(&saved), nil
}

func (l *logic) GrantFreeCredit(req *transport.GrantFreeCreditRequest) (*transport.GrantFreeCreditResponse, error) {
	if req == nil {
		return nil, errcode.Wrap(errcode.ErrPassInvalidParam, "request is nil")
	}
	userID := strings.TrimSpace(req.UserID)
	planID := strings.TrimSpace(req.PlanID)
	idempotencyKey := strings.TrimSpace(req.IdempotencyKey)
	if userID == "" {
		return nil, errcode.Wrap(errcode.ErrPassInvalidParam, "user_id is required")
	}
	if planID == "" {
		return nil, errcode.Wrap(errcode.ErrPassInvalidParam, "plan_id is required")
	}
	if idempotencyKey == "" {
		return nil, errcode.Wrap(errcode.ErrPassInvalidParam, "idempotency_key is required")
	}
	if !config.LLMGatewayEnabled() {
		return nil, errcode.Wrap(errcode.ErrPassGatewaySubscriptionFailed, "llmgateway is disabled")
	}

	activePass, err := findActivePassForFreeCredit(userID, time.Now().UTC())
	if err != nil {
		return nil, err
	}
	periodEnd := activePass.ExpiredTime.UTC()
	subscriptionName := freeCreditSubscriptionName(req.Source, idempotencyKey)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	sub, err := adapterfactory.DefaultAdapterFactory.LLMGatewayAdapter().ApplySubscription(ctx, &llmgateway.ApplySubscriptionRequest{
		IdempotencyKey:   idempotencyKey,
		UserID:           userID,
		PlanID:           planID,
		SubscriptionName: subscriptionName,
		IsUnique:         false,
	})
	if err != nil {
		return nil, errcode.Wrap(errcode.ErrPassGatewaySubscriptionFailed, "apply llmgateway free credit subscription: %v", err)
	}
	if sub == nil {
		return nil, errcode.Wrap(errcode.ErrPassGatewaySubscriptionFailed, "apply llmgateway free credit subscription returned empty subscription")
	}
	gatewayroute.RecordBestEffort(resource.ZapLogger, userID, gatewayroute.GatewayLLMGateway, sub.ID, sub.PlanID, gatewayroute.SourceApplySubscription)
	return &transport.GrantFreeCreditResponse{
		UserID:           userID,
		PlanID:           sub.PlanID,
		SubscriptionID:   sub.ID,
		SubscriptionName: subscriptionName,
		PeriodEnd:        periodEnd,
	}, nil
}

func findActivePassForFreeCredit(userID string, now time.Time) (*passmodel.Entity, error) {
	passDao := modelfactory.DefaultDaoFactory.PassDao(nil)
	passes, err := passDao.ListByUserID(userID)
	if err != nil {
		return nil, fmt.Errorf("list user passes: %w", err)
	}
	for _, p := range passes {
		if p == nil {
			continue
		}
		if p.DeletedTime != nil || p.Status != passmodel.StatusActive || !p.ExpiredTime.After(now) {
			continue
		}
		return p, nil
	}
	return nil, errcode.ErrPassNotFound
}

func validateTransferPassRequest(req *transport.TransferPassRequest) error {
	if req == nil {
		return errcode.ErrPassInvalidParam
	}
	if strings.TrimSpace(req.PassID) == "" {
		return errcode.Wrap(errcode.ErrPassInvalidParam, "pass_id is required")
	}
	if strings.TrimSpace(req.TargetBundleID) == "" {
		return errcode.Wrap(errcode.ErrPassInvalidParam, "target_bundle_id is required")
	}
	if req.NewUin <= 0 {
		return errcode.Wrap(errcode.ErrPassInvalidParam, "new_uin is required")
	}
	if req.NewAppID <= 0 {
		return errcode.Wrap(errcode.ErrPassInvalidParam, "new_app_id is required")
	}
	return nil
}

func markBillingMigrationCompleted(tx *gorm.DB, passID, targetBundleID, dealName, bigOrderID string) error {
	updates := map[string]interface{}{
		passmigrationmodel.ColumnStatus:    passmigrationmodel.StatusCompleted,
		passmigrationmodel.ColumnLastError: nil,
	}
	if dealName != "" {
		updates[passmigrationmodel.ColumnDealName] = dealName
	}
	if bigOrderID != "" {
		updates[passmigrationmodel.ColumnBigOrderID] = bigOrderID
	}
	result := tx.Table(passmigrationmodel.TableName).
		Where(passmigrationmodel.ColumnPassID+" = ? AND "+passmigrationmodel.ColumnTargetBundleID+" = ?", passID, targetBundleID).
		Updates(updates)
	if result.Error != nil {
		return fmt.Errorf("pass billing transfer complete migration state: %w", result.Error)
	}
	if result.RowsAffected == 0 {
		return errcode.Wrap(errcode.ErrPassInvalidParam, "pass billing migration state not found")
	}
	return nil
}

func stringValue(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

func truncateString(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

func (l *logic) GetPasses(userID *string, bundleID *string) ([]*PassDetail, error) {
	dao := modelfactory.DefaultDaoFactory.PassDao(nil)
	entities, err := dao.ListByFilters(userID, bundleID)
	if err != nil {
		return nil, fmt.Errorf("get passes: %w", err)
	}
	details := entitiesToDetails(entities)
	l.fillCredits(details)
	return details, nil
}

func (l *logic) GetPassesPage(userID *string, bundleID *string, status *string, page, pageSize int) ([]*PassDetail, int64, error) {
	if page <= 0 || pageSize <= 0 {
		return nil, 0, errcode.Wrap(errcode.ErrInvalidParam, "page and page_size must be positive")
	}
	dao := modelfactory.DefaultDaoFactory.PassDao(nil)
	entities, total, err := dao.ListByFiltersPage(userID, bundleID, status, pageSize, (page-1)*pageSize)
	if err != nil {
		return nil, 0, fmt.Errorf("get passes page: %w", err)
	}
	details := entitiesToDetails(entities)
	l.fillCredits(details)
	return details, total, nil
}

func (l *logic) ModifyPass(passID string, req *ModifyPassFields) (*PassDetail, error) {
	if passID == "" {
		return nil, errcode.ErrPassInvalidParam
	}
	if req == nil {
		return nil, errcode.ErrPassNoFieldToUpdate
	}

	updates := make(map[string]interface{})
	if req.BundleID != nil {
		updates[passmodel.ColumnBundleID] = *req.BundleID
	}
	if req.ExpiredTime != nil {
		updates[passmodel.ColumnExpiredTime] = *req.ExpiredTime
	}
	if len(updates) == 0 {
		return nil, errcode.ErrPassNoFieldToUpdate
	}

	dao := modelfactory.DefaultDaoFactory.PassDao(nil)

	_, err := dao.GetByPassID(passID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, errcode.ErrPassNotFound
		}
		return nil, fmt.Errorf("modify pass: %w", err)
	}

	if err := dao.UpdateByPassID(passID, updates); err != nil {
		return nil, fmt.Errorf("modify pass: %w", err)
	}

	saved, err := dao.GetByPassID(passID)
	if err != nil {
		return nil, fmt.Errorf("modify pass: read back: %w", err)
	}
	detail := entityToDetail(saved)
	l.fillCredit(detail)
	return detail, nil
}

func (l *logic) DescribePasses(userID string) ([]*PassDetail, error) {
	if userID == "" {
		return nil, errcode.ErrPassInvalidParam
	}
	dao := modelfactory.DefaultDaoFactory.PassDao(nil)
	entities, err := dao.ListByUserID(userID)
	if err != nil {
		return nil, fmt.Errorf("describe passes: %w", err)
	}
	details := entitiesToDetails(entities)
	l.fillCredits(details)
	return details, nil
}

// fillCredits 批量为 PassDetail 填充 credit_total / credit_available
func (l *logic) fillCredits(details []*PassDetail) {
	for _, d := range details {
		l.fillCredit(d)
	}
}

// fillCredit 为单个 PassDetail 填充 bundle / 配额 / ai-gateway 相关字段
//   - bundle_name 从 bundle 读取
//   - credit_total 从 bundle.credit 读取；pass 非 active 或无套餐订阅时返回 0
//   - credit_available 实时调 ai-gateway 查 subscription 换算；失败时返回 0 + 日志告警
//   - agent_quota_total / agent_quota_available 从 user_resource_quota 表读取（v1.7.23 B18 新增,
//     v1.7.24 B19 修订: 两值都从同一行取, 强一致, 不再混用 bundle.agent_quota）
func (l *logic) fillCredit(d *PassDetail) {
	if d == nil {
		return
	}
	bundle, err := l.bundleLogic.GetBundleByID(d.BundleID)
	if err != nil {
		resource.ZapLogger.Warn("fill credit: get bundle failed",
			zap.String("pass_id", d.PassID),
			zap.String("bundle_id", d.BundleID),
			zap.Error(err),
		)
		return
	}
	d.BundleName = bundle.BundleName
	d.CreditTotal = bundle.Credit

	// v1.7.24 B19: agent_quota_total / agent_quota_available 都从 user_resource_quota
	// 同一行读取 (resource_name=OPENCLAW_INSTANCE, resource_key="" — 与 Instance 模块共享
	// 同一配额行).
	//
	// 设计理由:
	//   - 强一致: total/available 同源同行 -- 避免 bundle.agent_quota 改了但 quota 表
	//     还没同步的窗口期 (CreatePassWithQuota 是事务原子写, 但 ModifyBundle 改 agent_quota
	//     不会同步刷 quota 表)
	//   - 单次 DB 查询: 不用再额外用 bundle.agent_quota
	//   - 真源唯一: quota 表是配额的最终权威 (Instance 占用 / Pass 续费 / 后台调整都改这张表)
	quotaDao := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(nil)
	if quotaEntity, qErr := quotaDao.SelectQuota(d.UserID, "OPENCLAW_INSTANCE", ""); qErr != nil {
		resource.ZapLogger.Warn("fill credit: select agent quota failed",
			zap.String("pass_id", d.PassID),
			zap.String("user_id", d.UserID),
			zap.Error(qErr),
		)
		// 失败不阻塞 — 降级 total/available=0 + 继续填 credit 字段
	} else if quotaEntity != nil {
		d.AgentQuotaTotal = quotaEntity.ResourceQuotaTotal
		d.AgentQuotaAvailable = quotaEntity.ResourceQuotaAvailable
	}
	// quotaEntity == nil（用户从未购买过 pass，无配额行）→ total/available 保持零值

	if d.Status != "" && d.Status != passmodel.StatusActive {
		d.CreditTotal = 0
		d.CreditAvailable = 0
		return
	}

	// 即使套餐积分为 0，也要查询 LLMGateway 的免费/额外积分订阅。
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	balances, err := getCompatibleCreditBalances(ctx, d.UserID)
	if err != nil {
		resource.ZapLogger.Warn("fill credit: get active subscription failed",
			zap.String("pass_id", d.PassID),
			zap.String("user_id", d.UserID),
			zap.Error(err),
		)
		d.CreditAvailable = 0
		return
	}
	if bundle.Credit == 0 || !balances.PackageFound {
		d.CreditTotal = 0
		d.CreditAvailable = 0
	} else {
		d.CreditAvailable = bundlelogic.TokensToCredit(balances.PackageTokenBalance)
	}
	d.FreeCreditTotal = bundlelogic.TokensToCredit(balances.FreeTokenTotal)
	d.FreeCreditAvailable = bundlelogic.TokensToCredit(balances.FreeTokenBalance)
}

type creditBalances struct {
	PackageTokenBalance int64
	PackageFound        bool
	FreeTokenTotal      int64
	FreeTokenBalance    int64
}

func getCompatibleCreditBalances(ctx context.Context, userID string) (creditBalances, error) {
	if gateway, ok, err := gatewayroute.Get(userID); err != nil {
		resource.ZapLogger.Warn("get recorded subscription gateway failed, fallback to probe",
			zap.String("user_id", userID),
			zap.Error(err))
	} else if ok {
		switch gateway {
		case gatewayroute.GatewayAIGateway:
			legacyAdapter := adapterfactory.DefaultAdapterFactory.AiGatewayAdapter()
			if legacyAdapter == nil {
				return creditBalances{}, fmt.Errorf("recorded ai-gateway subscription but ai-gateway adapter is nil")
			}
			sub, err := legacyAdapter.GetActiveSubscription(ctx, userID)
			if err != nil {
				return creditBalances{}, err
			}
			if sub == nil {
				return creditBalances{}, nil
			}
			gatewayroute.RecordBestEffort(resource.ZapLogger, userID, gatewayroute.GatewayAIGateway, sub.ID, sub.PlanID, gatewayroute.SourceDetectActiveSubscription)
			return creditBalances{PackageTokenBalance: sub.TokenBalance, PackageFound: true}, nil
		case gatewayroute.GatewayLLMGateway:
			if !config.LLMGatewayEnabled() {
				resource.ZapLogger.Warn("recorded llmgateway subscription ignored because llmgateway is disabled",
					zap.String("user_id", userID))
				break
			}
			list, err := adapterfactory.DefaultAdapterFactory.LLMGatewayAdapter().ListActiveSubscriptions(ctx, userID)
			if err != nil {
				return creditBalances{}, err
			}
			balances := creditBalancesFromLLMSubscriptions(list.Subscriptions)
			if len(list.Subscriptions) > 0 {
				sub := firstPackageSubscription(list.Subscriptions)
				gatewayroute.RecordBestEffort(resource.ZapLogger, userID, gatewayroute.GatewayLLMGateway, sub.ID, sub.PlanID, gatewayroute.SourceDetectActiveSubscription)
			}
			return balances, nil
		default:
			resource.ZapLogger.Warn("unknown recorded subscription gateway, fallback to probe",
				zap.String("user_id", userID),
				zap.String("gateway", gateway))
		}
	}

	var legacyErr error
	if legacyAdapter := adapterfactory.DefaultAdapterFactory.AiGatewayAdapter(); legacyAdapter != nil {
		legacySub, err := legacyAdapter.GetActiveSubscription(ctx, userID)
		legacyErr = err
		if legacyErr == nil {
			if legacySub != nil {
				gatewayroute.RecordBestEffort(resource.ZapLogger, userID, gatewayroute.GatewayAIGateway, legacySub.ID, legacySub.PlanID, gatewayroute.SourceDetectActiveSubscription)
				return creditBalances{PackageTokenBalance: legacySub.TokenBalance, PackageFound: true}, nil
			}
		} else if !isLegacyGatewayDisabled(legacyErr) {
			resource.ZapLogger.Warn("get active subscription from ai-gateway failed, try llmgateway",
				zap.String("user_id", userID),
				zap.Error(legacyErr),
			)
		}
	}

	if !config.LLMGatewayEnabled() {
		if legacyErr != nil && !isLegacyGatewayDisabled(legacyErr) {
			return creditBalances{}, legacyErr
		}
		return creditBalances{}, nil
	}

	llmList, llmErr := adapterfactory.DefaultAdapterFactory.LLMGatewayAdapter().ListActiveSubscriptions(ctx, userID)
	if llmErr == nil {
		if llmList != nil && len(llmList.Subscriptions) > 0 {
			sub := firstPackageSubscription(llmList.Subscriptions)
			gatewayroute.RecordBestEffort(resource.ZapLogger, userID, gatewayroute.GatewayLLMGateway, sub.ID, sub.PlanID, gatewayroute.SourceDetectActiveSubscription)
			return creditBalancesFromLLMSubscriptions(llmList.Subscriptions), nil
		}
		if legacyErr != nil && !isLegacyGatewayDisabled(legacyErr) {
			return creditBalances{}, legacyErr
		}
		return creditBalances{}, nil
	}
	if legacyErr != nil && !isLegacyGatewayDisabled(legacyErr) {
		return creditBalances{}, fmt.Errorf("ai-gateway: %v; llmgateway: %w", legacyErr, llmErr)
	}
	return creditBalances{}, llmErr
}

func creditBalancesFromLLMSubscriptions(subs []llmgateway.Subscription) creditBalances {
	var balances creditBalances
	for _, sub := range subs {
		if strings.HasPrefix(strings.TrimSpace(sub.Name), freeCreditSubscriptionNamePrefix) {
			tokenTotal := sub.TokenTotal
			if tokenTotal == 0 && sub.TokenBalance > 0 {
				tokenTotal = sub.TokenBalance
			}
			balances.FreeTokenTotal += tokenTotal
			balances.FreeTokenBalance += sub.TokenBalance
			continue
		}
		balances.PackageFound = true
		balances.PackageTokenBalance += sub.TokenBalance
	}
	return balances
}

func firstPackageSubscription(subs []llmgateway.Subscription) llmgateway.Subscription {
	for _, sub := range subs {
		if !strings.HasPrefix(strings.TrimSpace(sub.Name), freeCreditSubscriptionNamePrefix) {
			return sub
		}
	}
	return subs[0]
}

func isLegacyGatewayDisabled(err error) bool {
	return errors.Is(err, aigateway.ErrAiGatewayNotConfigured)
}

// jifeiCurDeadlineLocation 是 jifei 协议层时间字面值的固定时区（北京时间 UTC+8）。
//
// 真源契约位于 trade/internal/jifei/timezone.go::CurDeadlineLocation —— jifei 所有
// 协议层 "YYYY-MM-DD HH:MM:SS" 字符串字段（curDeadline / newDeadline / startTime / endTime
// 等）一律按北京时间字面值解析，trade.checkRenew 也用同一时区做严格字符串比对。
//
// ctl 这边历史上用 ExpiredTime.Format("2006-01-02 15:04:05") 不指定 location，
// 输出会跟容器 TZ env 走（ctl-api 容器默认 Asia/Shanghai，但 trade 容器是 UTC，
// 不同环境时区错配时会让相同 time.Time 产生不同字面值）；表现为续费下单 jifei
// 返 600404 CurDeadlineMismatch（v1.7.32 BUG 修复，2026-05-23）。
var jifeiCurDeadlineLocation = time.FixedZone("CST", 8*3600)

// formatCurDeadlineForJifei 把 pass.expired_time 转换成 jifei 协议层北京时间字面值。
//
// 等价于 trade jifeiproto.FormatCurDeadline(t)，但 ctl 不依赖 trade 内部包，
// 这里就地维持一份字面常量（CST/UTC+8 与 layout）保持解耦；如未来契约调整，
// trade 与 ctl 必须同步修改。
func formatCurDeadlineForJifei(t time.Time) string {
	return t.In(jifeiCurDeadlineLocation).Format("2006-01-02 15:04:05")
}

// CalcExpiredTime 按 Bundle 的 time_span + time_unit 计算 Pass 到期时间
//   - time_unit="m" → 按自然月累加（月末溢出：3月31 + 1月 = 4月30）
//   - time_unit="d" → 按自然天累加
//   - time_unit="y" → 按自然年累加（trade-pass-renew §12 Q19=b 落地，2026-05-15 v3.8；
//     time.AddDate(years,0,0) 自带闰年边界处理：2024-02-29 + 1y → 2025-02-28）
func CalcExpiredTime(start time.Time, timeSpan int, timeUnit string) (time.Time, error) {
	if timeSpan <= 0 {
		return time.Time{}, fmt.Errorf("invalid time_span: %d", timeSpan)
	}
	switch timeUnit {
	case bundlemodel.TimeUnitMonth:
		return addMonthsNatural(start, timeSpan), nil
	case bundlemodel.TimeUnitDay:
		return start.AddDate(0, 0, timeSpan), nil
	case bundlemodel.TimeUnitYear:
		return start.AddDate(timeSpan, 0, 0), nil
	default:
		return time.Time{}, fmt.Errorf("invalid time_unit: %q", timeUnit)
	}
}

// addMonthsNatural 按自然月累加，目标月无对应日期时取该月最后一天
func addMonthsNatural(start time.Time, months int) time.Time {
	y, m, d := start.Date()
	targetYear, targetMonth := y, m+time.Month(months)
	for targetMonth > 12 {
		targetMonth -= 12
		targetYear++
	}
	maxDay := daysInMonth(targetYear, targetMonth)
	if d > maxDay {
		d = maxDay
	}
	return time.Date(targetYear, targetMonth, d,
		start.Hour(), start.Minute(), start.Second(), start.Nanosecond(), start.Location())
}

func daysInMonth(year int, month time.Month) int {
	return time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

func entityToDetail(e *passmodel.Entity) *PassDetail {
	detail := &PassDetail{
		PassID:       e.PassID,
		UserID:       e.UserID,
		BundleID:     e.BundleID,
		Uin:          e.Uin,
		AppID:        e.AppID,
		ExpiredTime:  e.ExpiredTime,
		IsolatedTime: e.IsolatedTime,
		DeletedTime:  e.DeletedTime,
		Status:       e.Status,
		RenewFlag:    e.RenewFlag,
	}
	if e.CreatedTime != nil {
		detail.CreatedTime = *e.CreatedTime
	}
	if e.UpdatedTime != nil {
		detail.UpdatedTime = *e.UpdatedTime
	}
	return detail
}

func entitiesToDetails(entities []*passmodel.Entity) []*PassDetail {
	details := make([]*PassDetail, 0, len(entities))
	for _, e := range entities {
		details = append(details, entityToDetail(e))
	}
	return details
}

// CompletePass v4 收敛：trade 反向调 ctl 完成付费 pass 发货。
//
// 与 CreateTrialPass 的差异：
//  1. 入参从 (userID, bundleID) 升级为完整 *transport.CompletePassRequest（透传 jifei 协议字段）
//  2. expired_time 计算用 req.TimeSpan/TimeUnit（trade 持有的下单参数），不再读 bundle.TimeSpan/TimeUnit
//  3. entity.Uin / AppID 从 req 透传写入（不再 TODO=0）
//  4. RenewFlag 接受 trade 映射后的 AUTO_RENEW；缺失或非法值兜底 MANUAL_RENEW
//  5. deal_name 仅日志记录用于排障，pass 表不持久化
//
// 复用 CreateTrialPass 步骤 5-12 的核心逻辑（EnsureUser → DecrementAvailCount →
// GeneratePassID → ApplySubscription → CreatePassWithQuota）。
func (l *logic) CompletePass(req *transport.CompletePassRequest) (*PassDetail, error) {
	// 步骤 0：入参强校验（v4：trade 透传字段必须齐全，缺失即拒）
	if err := validateCompletePassRequest(req); err != nil {
		return nil, err
	}

	logger := resource.ZapLogger.With(
		zap.String("user_id", req.UserID),
		zap.String("bundle_id", req.BundleID),
		zap.String("deal_name", req.DealName),
		zap.Int64("uin", req.Uin),
		zap.Int64("app_id", req.AppID),
	)
	logger.Info("complete pass started")

	// 步骤 1：校验 Bundle 存在且 ONLINE
	bundle, err := l.bundleLogic.GetBundleByID(req.BundleID)
	if err != nil {
		return nil, err
	}
	if bundle.BundleState != bundlemodel.StateOnline {
		return nil, errcode.ErrPassBundleOffline
	}

	// 步骤 2：静态售罄校验
	if bundle.StaticSoldOut {
		return nil, errcode.ErrPassBundleSoldOut
	}

	agentQuota := bundle.AgentQuota

	// 步骤 3：用户唯一 Pass 兜底防御（v4 收敛：不做幂等，存在即拒）
	passDao := modelfactory.DefaultDaoFactory.PassDao(nil)
	existing, err := passDao.ListByUserID(req.UserID)
	if err != nil {
		return nil, fmt.Errorf("check existing pass: %w", err)
	}
	if len(existing) > 0 {
		// 等价于 v4 设计稿中的 USER_HAS_ACTIVE_PASS
		return nil, errcode.ErrPassAlreadyExists
	}

	// 步骤 4：配额校验
	quotaDao := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(nil)
	quotaEntity, err := quotaDao.SelectQuota(req.UserID, "OPENCLAW_INSTANCE", "")
	if err != nil {
		return nil, fmt.Errorf("check quota: %w", err)
	}
	if quotaEntity != nil {
		consumed := quotaEntity.ResourceQuotaTotal - quotaEntity.ResourceQuotaAvailable
		if consumed > agentQuota {
			return nil, errcode.ErrPassQuotaExceeded
		}
	}

	// 步骤 5：在当前环境选定的网关中确保业务用户存在。
	ensureCtx, ensureCancel := context.WithTimeout(context.Background(), 10*time.Second)
	logger.Info("complete pass ensure-user started")
	created, ensureErr := ensureNewPassGatewayUser(ensureCtx, req.UserID, "")
	ensureCancel()
	if ensureErr != nil {
		logger.Warn("complete pass ensure-user failed", zap.Error(ensureErr))
		return nil, fmt.Errorf("ensure gateway user: %w", ensureErr)
	}
	logger.Info("complete pass ensure-user succeeded",
		zap.Bool("created", created),
	)

	// 步骤 6：扣减 bundle 可售卖余量（原子操作，并发安全）
	bundleDao := modelfactory.DefaultDaoFactory.BundleDao(nil)
	ok, err := bundleDao.DecrementAvailCount(req.BundleID, 1)
	if err != nil {
		return nil, fmt.Errorf("decrement bundle avail count: %w", err)
	}
	if !ok {
		return nil, errcode.ErrBundleSalesQuotaEmpty
	}
	bundleQuotaDeducted := true
	defer func() {
		if bundleQuotaDeducted {
			_ = bundleDao.IncrementAvailCount(req.BundleID, 1)
		}
	}()

	// 步骤 7：生成 pass_id
	idGenDao := modelfactory.DefaultDaoFactory.IdGenDao(nil)
	autoID, err := idGenDao.GenId("pass")
	if err != nil {
		return nil, fmt.Errorf("generate pass auto id: %w", err)
	}
	password := "passmon" + config.ServerConf.MiscConfig.ObjectIdPasswordSuffix
	region := config.ServerConf.MiscConfig.Region
	passID, err := objectid.GeneratePassID(autoID, password, region)
	if err != nil {
		return nil, fmt.Errorf("generate pass id: %w", err)
	}

	// 步骤 8：计算 expired_time（v4 收敛：用 req 透传的 TimeSpan/TimeUnit，trade_order 已持有）
	now := time.Now().UTC()
	expiredTime, err := CalcExpiredTime(now, req.TimeSpan, req.TimeUnit)
	if err != nil {
		return nil, fmt.Errorf("calc expired_time: %w", err)
	}

	// 步骤 9：确保 AI 权益存在。LLMGateway 使用长期订阅，订单购买时长不下沉；
	// legacy ai-gateway 在迁移期仍接收原周期。
	subscriptionEnsured := false
	if bundle.Credit > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		sub, subErr := applyNewPassGatewaySubscription(ctx, newPassSubscriptionRequest{
			IdempotencyKey:   tradeSubscriptionIdempotencyKey(req.DealName),
			UserID:           req.UserID,
			PlanID:           bundle.AiGatewayPlanID,
			SubscriptionName: packageSubscriptionName(req.UserID, passID),
			PeriodValue:      req.TimeSpan,
			PeriodUnit:       req.TimeUnit,
			IsUnique:         true,
		})
		cancel()
		if subErr != nil {
			return nil, fmt.Errorf("apply gateway subscription: %w", subErr)
		}
		subscriptionEnsured = true
		if sub != nil {
			gatewayroute.RecordBestEffort(logger, req.UserID, sub.Gateway, sub.ID, sub.PlanID, gatewayroute.SourceApplySubscription)
			logger.Info("complete pass subscription applied",
				zap.String("pass_id", passID),
				zap.String("plan_id", bundle.AiGatewayPlanID),
				zap.String("subscription_id", sub.ID),
			)
		}
	}

	// 步骤 10：事务写入 pass + quota（uin/app_id 与 renew_flag 从 trade 透传）
	entity := &passmodel.Entity{
		PassID:      passID,
		UserID:      req.UserID,
		BundleID:    req.BundleID,
		Uin:         req.Uin,
		AppID:       req.AppID,
		ExpiredTime: expiredTime,
		RenewFlag:   normalizeCompletePassRenewFlag(req.RenewFlag),
		Status:      passmodel.StatusActive, // v1.7.28 BUG-17 修复：显式写 active，避免 gorm 用 Go zero value 覆盖 DB DEFAULT
	}
	if err := passDao.CreatePassWithQuota(entity, req.UserID, agentQuota); err != nil {
		return nil, compensateEnsuredEntitlement(
			logger,
			req.UserID,
			subscriptionEnsured,
			fmt.Errorf("create pass with quota: %w", err),
		)
	}

	// 步骤 11：创建成功，取消回滚
	bundleQuotaDeducted = false

	// 步骤 12：读回返回
	saved, err := passDao.GetByPassID(passID)
	if err != nil {
		return nil, fmt.Errorf("read back pass: %w", err)
	}
	detail := entityToDetail(saved)
	detail.BundleName = bundle.BundleName
	detail.CreditTotal = bundle.Credit
	detail.CreditAvailable = bundle.Credit

	logger.Info("complete pass succeeded", zap.String("pass_id", passID))
	return detail, nil
}

// normalizeCompletePassRenewFlag 只放行内部自动续费枚举。trade 旧版本、国内站回调或异常
// 调用没有传入合法值时统一回落手动续费，避免改变既有 pass 的续费语义。
func normalizeCompletePassRenewFlag(flag string) string {
	if flag == passmodel.RenewFlagAuto {
		return passmodel.RenewFlagAuto
	}
	return passmodel.RenewFlagManual
}

// validateCompletePassRequest v4 收敛：CompletePass 入参强校验
//
// trade 反向调时除可选 RenewFlag 外的业务字段必填，缺失即报 ErrPassInvalidParam
// （trade 侧应已校验，ctl 侧仅做防御性校验避免脏数据进入业务流程）。
func validateCompletePassRequest(req *transport.CompletePassRequest) error {
	if req == nil {
		return errcode.Wrap(errcode.ErrPassInvalidParam, "request is nil")
	}
	if req.UserID == "" {
		return errcode.Wrap(errcode.ErrPassInvalidParam, "user_id is required")
	}
	if req.BundleID == "" {
		return errcode.Wrap(errcode.ErrPassInvalidParam, "bundle_id is required")
	}
	if req.TimeSpan <= 0 {
		return errcode.Wrap(errcode.ErrPassInvalidParam, "time_span must be > 0")
	}
	if req.TimeUnit != bundlemodel.TimeUnitMonth && req.TimeUnit != bundlemodel.TimeUnitDay && req.TimeUnit != bundlemodel.TimeUnitYear {
		return errcode.Wrap(errcode.ErrPassInvalidParam, "time_unit must be 'm', 'd' or 'y'")
	}
	if req.Uin <= 0 {
		return errcode.Wrap(errcode.ErrPassInvalidParam, "uin must be > 0")
	}
	if req.AppID <= 0 {
		return errcode.Wrap(errcode.ErrPassInvalidParam, "app_id must be > 0")
	}
	if req.DealName == "" {
		return errcode.Wrap(errcode.ErrPassInvalidParam, "deal_name is required")
	}
	return nil
}

// trade ↔ ctl 透传约束（与 trade-purchase-flow-design.md §4.2.1 对齐）：
//
//   - lighthousePassPayMode  = 1    包年包月（PayMode=1）
//   - lighthousePassGoodsNum = 1    本期固定单件（Q41 拍板）
//
// 这些值都是 jifei 协议要求字段，ctl 侧从用户面看不到，由调用层兜底；
// trade 内部也按这套兜底自校验。
//
// **Q41 修订 2026-05-11**：删除 lighthousePassRegionID 常量。region/zone 完全由 trade 内部
// 固定（trade fixedRegionID=1, fixedZoneID=100001 = 广州 / 广州一区），ctl 不再透传 regionId
// 字段，与 user-facing 接口 schema 一致。
const (
	lighthousePassPayMode  = 1
	lighthousePassGoodsNum = 1
)

// CreatePassOrder billing-integration B2：创建付费 pass 订单。
//
// 流程概览：
//
//  1. 入参强校验（userID / BundleID / Period / TimeUnit）
//  2. 校验 Bundle 存在且 ONLINE，且非售罄
//  3. 用户唯一 pass 兜底防御（与 CreateTrialPass / CompletePass 一致）
//  4. 调 trade.PlaceOrder 创建 jifei 订单（trade 内部 ShadowClient 反查 uin/appId,
//     ctl 仅透传 ExternalUserID, Q30 拍板）
//  5. 调 trade.GeneratePayURL 拿支付 URL
//  6. 返回 (DealName, PayURL) 给上层
//
// **不写本地 pass 表** — pass 发货由 jifei 回调链路触发 ctl.CompletePass 完成。
func (l *logic) CreatePassOrder(userID string, req *transport.CreatePassOrderRequest) (*transport.CreatePassOrderResult, error) {
	// 步骤 1 ~ 4：共享前置（参数校验 / bundle 校验 / 用户唯一性 / 反查 shadow / 构建 trade 入参）
	placeReq, logger, err := l.prepareCreatePassOrder(userID, req, "create_pass_order")
	if err != nil {
		return nil, err
	}

	// 步骤 5：调 trade.PlaceOrder
	placeCtx, placeCancel := context.WithTimeout(context.Background(), 15*time.Second)
	placeResp, placeErr := adapterfactory.DefaultAdapterFactory.TradeAdapter().PlaceOrder(placeCtx, placeReq)
	placeCancel()
	if placeErr != nil {
		logger.Warn("create pass order: trade.PlaceOrder failed", zap.Error(placeErr))
		if err := mapTradePlaceOrderError(placeErr); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("trade place order: %w", placeErr)
	}
	if placeResp == nil || placeResp.DealName == "" {
		return nil, fmt.Errorf("trade place order: empty deal_name")
	}
	logger.Info("create pass order: trade.PlaceOrder ok",
		zap.String("deal_name", placeResp.DealName),
		zap.String("big_order_id", placeResp.BigOrderID),
	)

	// 步骤 6：返回 deal_names（v1.7.31 拆分：不再调 GeneratePayURL，由前端二次调 CreatePassOrderUrl 拉 URL）
	result := &transport.CreatePassOrderResult{
		DealNames: []string{placeResp.DealName},
	}

	// v1.7.32 新增：签发 auth_code ticket（设计稿 .tmp/ctl-authcode-codebuddy-design.md
	// §4.6 + A8 不变量）。签发失败仅记警告，不阻断主链路；auth_code="" 走前端降级
	// （回退 Bearer 中转页、不走中转页下单）。
	if store := authcode.DefaultStore; store != nil {
		issueCtx, issueCancel := context.WithTimeout(context.Background(), 2*time.Second)
		code, issueErr := store.Issue(issueCtx, &authcode.Ticket{
			UserID:    userID,
			DealNames: result.DealNames,
		})
		issueCancel()
		if issueErr != nil {
			logger.Warn("create pass order: issue auth_code failed, fallback to empty",
				zap.Error(issueErr))
		} else {
			result.AuthCode = code
		}
	}

	return result, nil
}

func mapTradePlaceOrderError(err error) error {
	var tradeErr *tradeadapter.Error
	if errors.As(err, &tradeErr) {
		switch tradeErr.Code {
		case "BindingNotFound":
			return errcode.ErrPassShadowBindingRequired
		case "BillingAccountOpenFailed":
			return errcode.ErrPassBillingAccountOpenFailed
		}
	}
	return nil
}

// CreatePassOrderUrl v1.7.31 接口拆分：拉取支付 URL。
//
// 流程概览：
//
//  1. 入参校验（userID / deal_names 非空）
//  2. 调 trade.GeneratePayURL（透传 platform / wx_open_id / wx_app_id / cancel_url / return_url）
//  3. 返回支付 URL + 协议外字段
//
// **不写本地 pass 表**。
func (l *logic) CreatePassOrderUrl(userID string, req *transport.CreatePassOrderUrlRequest) (*transport.CreatePassOrderUrlResult, error) {
	if userID == "" {
		return nil, errcode.Wrap(errcode.ErrPassInvalidParam, "user_id is required")
	}
	if req == nil || len(req.DealNames) == 0 {
		return nil, errcode.Wrap(errcode.ErrPassInvalidParam, "deal_names is required")
	}

	logger := resource.ZapLogger.With(
		zap.String("flow", "create_pass_order_url"),
		zap.String("user_id", userID),
		zap.Strings("deal_names", req.DealNames),
	)
	logger.Info("create pass order url: started")

	// 当前单元素，遍历 deal_names[0]
	dealName := req.DealNames[0]
	var opts *tradeadapter.GeneratePayURLOptions
	if req.Platform != "" || req.WxOpenID != "" || req.CancelURL != "" || req.ReturnURL != "" {
		opts = &tradeadapter.GeneratePayURLOptions{
			Platform:  req.Platform,
			WxOpenID:  req.WxOpenID,
			CancelURL: req.CancelURL,
			ReturnURL: req.ReturnURL,
		}
		// wx_app_id：当 wx_open_id 非空（微信公众号 / 小程序场景）时透传给 trade
		// → jifei.getMidasEarmarking.wxAppId。
		// TODO(billing-integration): 当前快速修复阶段先在代码中硬编码 AppID，
		// 后续通过 ctl 进程级配置（toml [jifei] wx_pay_app_id 基线 +
		// CTL_JIFEI_WX_PAY_APP_ID env 覆盖，与 CTL_REDIS_PASS / CTL_SHADOW_TOKEN
		// 等敏感配置同范式）注入。
		if req.WxOpenID != "" {
			opts.WxAppID = "wxf95ea3ae45d5304f"
		}
	}

	urlCtx, urlCancel := context.WithTimeout(context.Background(), payURLRequestTimeout)
	urlResp, urlErr := adapterfactory.DefaultAdapterFactory.TradeAdapter().GeneratePayURL(urlCtx, dealName, opts)
	urlCancel()
	if urlErr != nil {
		logger.Warn("create pass order url: trade.GeneratePayURL failed",
			zap.String("deal_name", dealName),
			zap.Error(urlErr),
		)
		return nil, fmt.Errorf("trade generate pay url: %w", urlErr)
	}
	if urlResp == nil {
		return nil, fmt.Errorf("trade generate pay url returned nil response")
	}
	// need_charge=0 表示订单已支付/无需再付（jifei getMidasEarmarking data.needCharge=0
	// 合法终态），此时 jifei 协议允许 PayURL 为空，与 RenewPassOrderUrl 行为对齐：
	// 不报错、透传 NeedCharge=0 给前端，由前端按"已支付"分支跳订单结果页。
	// 仅当 need_charge=1 但 PayURL 仍为空时才视为异常。
	if urlResp.PayURL == "" && urlResp.NeedCharge != 0 {
		return nil, fmt.Errorf("trade generate pay url: empty pay_url (need_charge=%d)", urlResp.NeedCharge)
	}

	logger.Info("create pass order url succeeded",
		zap.String("deal_name", dealName),
		zap.Int("need_charge", urlResp.NeedCharge),
	)

	return &transport.CreatePassOrderUrlResult{
		DealName:   dealName,
		PayURL:     urlResp.PayURL,
		TokenID:    urlResp.TokenID,
		OrderID:    urlResp.OrderID,
		MidasAppID: urlResp.MidasAppID,
		NeedCharge: urlResp.NeedCharge,
		Uin:        urlResp.Uin,
		AppID:      urlResp.AppID,
	}, nil
}

// CreatePassOrderAndPay billing-integration B2：一体化创建付费 pass 订单 + 自动支付。
//
// **仅用于联调测试 / 自动化 e2e，现网控制台禁止暴露给真实用户**。
//
// 流程概览（前 4 步与 CreatePassOrder 完全一致）：
//
//  1. 入参强校验
//  2. 校验 Bundle 存在且 ONLINE / 未售罄
//  3. 用户唯一 pass 兜底防御
//  4. 调 trade.PlaceOrderAndPay 一次完成 "下单 + 支付 + 触发 createResource 回调"，
//     **不再调 GeneratePayURL**（一体化接口跳过支付 URL 概念）
//  5. 返回 (DealName, BigOrderID) 给上层；测试方据此反查 jifei 控制台 / 等待
//     ctl.CompletePass 回调到达
//
// **不写本地 pass 表** — pass 发货由 jifei → trade.checkCreate → trade.createResource
// → ctl.CompletePass 链路触发，与 CreatePassOrder 一致。
func (l *logic) CreatePassOrderAndPay(userID string, req *transport.CreatePassOrderRequest) (*transport.CreatePassOrderAndPayResult, error) {
	// 步骤 1 ~ 4：共享前置
	placeReq, logger, err := l.prepareCreatePassOrder(userID, req, "create_pass_order_and_pay")
	if err != nil {
		return nil, err
	}

	// 步骤 5：调 trade.PlaceOrderAndPay（一次完成下单 + 支付）
	placeCtx, placeCancel := context.WithTimeout(context.Background(), 30*time.Second)
	placeResp, placeErr := adapterfactory.DefaultAdapterFactory.TradeAdapter().PlaceOrderAndPay(placeCtx, placeReq)
	placeCancel()
	if placeErr != nil {
		logger.Warn("create pass order and pay: trade.PlaceOrderAndPay failed", zap.Error(placeErr))
		if err := mapTradePlaceOrderError(placeErr); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("trade place order and pay: %w", placeErr)
	}
	if placeResp == nil || placeResp.DealName == "" {
		return nil, fmt.Errorf("trade place order and pay: empty deal_name")
	}
	logger.Info("create pass order and pay succeeded",
		zap.String("deal_name", placeResp.DealName),
		zap.String("big_order_id", placeResp.BigOrderID),
	)

	// 步骤 6：返回（不写本地 pass，PayURL 一体化接口下永远为空，不返）
	return &transport.CreatePassOrderAndPayResult{
		DealName:   placeResp.DealName,
		BigOrderID: placeResp.BigOrderID,
	}, nil
}

// prepareCreatePassOrder CreatePassOrder / CreatePassOrderAndPay 共享前置流程。
//
// 步骤覆盖：
//
//  1. 入参强校验（userID / BundleID / Period / TimeUnit）
//  2. 校验 Bundle 存在且 ONLINE 且非售罄
//  3. 用户唯一 pass 兜底防御
//  4. 构造 trade.PlaceOrder / PlaceOrderAndPay 入参 (只透传 ExternalUserID)
//
// 返回构造好的 *tradeadapter.PlaceOrderRequest 和带上下文字段的 logger，调用方仅需
// 接力调 trade 端点。
func (l *logic) prepareCreatePassOrder(
	userID string,
	req *transport.CreatePassOrderRequest,
	flow string,
) (*tradeadapter.PlaceOrderRequest, *zap.Logger, error) {
	// 步骤 1：入参强校验
	if userID == "" {
		return nil, nil, errcode.Wrap(errcode.ErrPassInvalidParam, "user_id is required")
	}
	if req == nil {
		return nil, nil, errcode.Wrap(errcode.ErrPassInvalidParam, "request is nil")
	}
	if req.BundleID == "" {
		return nil, nil, errcode.Wrap(errcode.ErrPassInvalidParam, "bundle_id is required")
	}
	if req.Period <= 0 {
		return nil, nil, errcode.Wrap(errcode.ErrPassInvalidParam, "period must be > 0")
	}
	if req.TimeUnit != bundlemodel.TimeUnitMonth && req.TimeUnit != bundlemodel.TimeUnitDay && req.TimeUnit != bundlemodel.TimeUnitYear {
		return nil, nil, errcode.Wrap(errcode.ErrPassInvalidParam, "time_unit must be 'm', 'd' or 'y'")
	}

	logger := resource.ZapLogger.With(
		zap.String("flow", flow),
		zap.String("user_id", userID),
		zap.String("bundle_id", req.BundleID),
		zap.Int("period", req.Period),
		zap.String("time_unit", req.TimeUnit),
	)
	logger.Info("create pass order: prepare started")
	if err := ensureShadowBindingIfRequired(userID, errcode.ErrPassShadowBindingRequired); err != nil {
		return nil, logger, err
	}

	// 步骤 2：校验 Bundle 存在且 ONLINE / 未售罄
	bundle, err := l.bundleLogic.GetBundleByID(req.BundleID)
	if err != nil {
		return nil, logger, err
	}
	if bundle.BundleState != bundlemodel.StateOnline {
		return nil, logger, errcode.ErrPassBundleOffline
	}
	if bundle.StaticSoldOut {
		return nil, logger, errcode.ErrPassBundleSoldOut
	}

	// 步骤 3：用户唯一 pass 兜底防御（与 trade.checkCreate 互斥占用规则保持对齐）
	passDao := modelfactory.DefaultDaoFactory.PassDao(nil)
	existing, err := passDao.ListByUserID(userID)
	if err != nil {
		return nil, logger, fmt.Errorf("check existing pass: %w", err)
	}
	if len(existing) > 0 {
		return nil, logger, errcode.ErrPassAlreadyExists
	}

	// 步骤 4：构造 trade 入参 (Q30 拍板: ctl 不调 shadow, 只透传 ExternalUserID,
	// trade 内部 ShadowClient 反查 (uin, appId) 后再调 jifei. 详见
	// trade-purchase-flow-design.md §3.1.1 节点 1b/3b' + Q30)
	return &tradeadapter.PlaceOrderRequest{
		ExternalUserID: userID,
		BundleID:       req.BundleID,
		Period:         req.Period,
		TimeUnit:       req.TimeUnit,
		GoodsNum:       lighthousePassGoodsNum,
		PayMode:        lighthousePassPayMode,
		AutoRenewFlag:  req.AutoRenewFlag,
		// Q41 修订 2026-05-11：RegionID 不再透传，trade 内部固定 1（广州）
		// Q30 拍板：Uin / AppID 不在 ctl 端反查，由 trade 内部 ShadowClient 反查
	}, logger, nil
}

func ensureShadowBindingIfRequired(userID string, requiredErr error) error {
	if !config.ShadowBindingRequired() {
		return nil
	}
	binding, err := adapterfactory.DefaultAdapterFactory.ShadowAdapter().GetBindingByUserID(userID)
	if err != nil {
		return fmt.Errorf("check shadow binding: %w", err)
	}
	if binding == nil {
		return requiredErr
	}
	return nil
}

// === jifei 反查接口三件套实现（billing-integration B11A 新增）===
// 设计稿：.tmp/trade-resource-query-design.md §4.1 / §11 Q9 Q10 Q14

// ListPassAppIDs 详见 Logic 接口注释
func (l *logic) ListPassAppIDs(bundleIDs []string, pageNo, pageSize int) ([]int64, int64, error) {
	if pageNo < 0 || pageSize <= 0 {
		return nil, 0, errcode.Wrap(errcode.ErrPassInvalidParam, "pageNo/pageSize invalid: pageNo=%d pageSize=%d", pageNo, pageSize)
	}
	dao := modelfactory.DefaultDaoFactory.PassDao(nil)
	offset := pageNo * pageSize
	appIDs, total, err := dao.ListDistinctAppIDsByBundleIDs(bundleIDs, pageSize, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("list pass app_ids: %w", err)
	}
	return appIDs, total, nil
}

// ListPassesByAppID 详见 Logic 接口注释
//
// 反查链路不填充 BundleName / Credit*（jifei 协议不消费这些字段；trade 端拼装
// goodsDetail 时通过 BundleStore 内存缓存反查 bundle 定义，与 ctl 解耦）。
func (l *logic) ListPassesByAppID(appID int64, bundleIDs []string, pageNo, pageSize int) ([]*PassDetail, int64, error) {
	if appID <= 0 {
		return nil, 0, errcode.Wrap(errcode.ErrPassInvalidParam, "app_id must be > 0")
	}
	if pageNo < 0 || pageSize <= 0 {
		return nil, 0, errcode.Wrap(errcode.ErrPassInvalidParam, "pageNo/pageSize invalid: pageNo=%d pageSize=%d", pageNo, pageSize)
	}
	dao := modelfactory.DefaultDaoFactory.PassDao(nil)
	offset := pageNo * pageSize
	entities, total, err := dao.ListByAppIDAndBundleIDs(appID, bundleIDs, pageSize, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("list passes by app_id: %w", err)
	}
	return entitiesToDetails(entities), total, nil
}

// ListPassesByResourceIDs 详见 Logic 接口注释
func (l *logic) ListPassesByResourceIDs(appID int64, passIDs []string) ([]*PassDetail, error) {
	if appID <= 0 {
		return nil, errcode.Wrap(errcode.ErrPassInvalidParam, "app_id must be > 0")
	}
	if len(passIDs) == 0 {
		return nil, errcode.Wrap(errcode.ErrPassInvalidParam, "pass_ids must be non-empty")
	}
	dao := modelfactory.DefaultDaoFactory.PassDao(nil)
	entities, err := dao.ListByAppIDAndPassIDs(appID, passIDs)
	if err != nil {
		return nil, fmt.Errorf("list passes by resource ids: %w", err)
	}
	return entitiesToDetails(entities), nil
}

// DescribePassByCloudAccount 详见 Logic 接口注释。
func (l *logic) DescribePassByCloudAccount(uin, appID int64, passID string) (*PassDetail, error) {
	if uin <= 0 {
		return nil, errcode.Wrap(errcode.ErrPassInvalidParam, "uin must be > 0")
	}
	if appID <= 0 {
		return nil, errcode.Wrap(errcode.ErrPassInvalidParam, "app_id must be > 0")
	}
	passID = strings.TrimSpace(passID)
	if passID == "" {
		return nil, errcode.Wrap(errcode.ErrPassInvalidParam, "pass_id is required")
	}
	dao := modelfactory.DefaultDaoFactory.PassDao(nil)
	entity, err := dao.GetByPassID(passID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) || errors.Is(err, errcode.ErrPassNotFound) {
			return nil, errcode.ErrPassNotFound
		}
		return nil, errcode.Wrap(errcode.ErrPassNotFound, "get pass: %v", err)
	}
	if entity.Uin != uin || entity.AppID != appID {
		return nil, errcode.ErrPassNotFound
	}
	return entityToDetail(entity), nil
}

// === trade-pass-renew RenewPassOrderUrl 实现（设计稿 §3.3 / §4.4 / R-D-5）===

// RenewPassOrderUrl 详见 Logic 接口注释。
//
// 流程概览（与 CreatePassOrder 对偶）：
//
//  1. 入参强校验（userID / passID / period / timeUnit）
//  2. 反查 pass 实体确认存在 + 当前持有人匹配 userID（防越权续费）
//  3. 校验 Bundle 存在（v1.7.22 B17 修订：不校验 BundleState；套餐下架仍可续费）
//  4. 调 trade.PlaceRenewOrder 创建 jifei 续费订单
//  5. 调 trade.GeneratePayURL 拿支付 URL（dealName 已带 order_type 业务语义，端点共享）
//  6. 返回 (DealName, PayURL) 给上层
//
// **不修改本地 pass 表** — pass.status 推进由 jifei → trade.renewResource → ctl.RenewPass
// 链路触发（与 CreatePassOrder 不写本地 pass 同范式）。
func (l *logic) RenewPassOrderUrl(userID, passID string, req *transport.RenewPassOrderUrlRequest) (*transport.RenewPassOrderUrlResult, error) {
	// 步骤 1：入参校验
	if userID == "" {
		return nil, errcode.Wrap(errcode.ErrPassInvalidParam, "user_id is required")
	}
	passID = strings.TrimSpace(passID)
	if passID == "" {
		return nil, errcode.Wrap(errcode.ErrPassInvalidParam, "pass_id is required")
	}
	if req == nil || len(req.DealNames) == 0 {
		return nil, errcode.Wrap(errcode.ErrPassInvalidParam, "deal_names is required")
	}

	logger := resource.ZapLogger.With(
		zap.String("flow", "renew_pass_order_url"),
		zap.String("user_id", userID),
		zap.String("pass_id", passID),
		zap.Strings("deal_names", req.DealNames),
	)
	logger.Info("renew pass order url: started")

	// 步骤 2：校验 pass 持有人匹配（deal_name 本身不含 pass 归属信息）
	passDao := modelfactory.DefaultDaoFactory.PassDao(nil)
	passEntity, err := passDao.GetByPassID(passID)
	if err != nil {
		return nil, errcode.Wrap(errcode.ErrPassNotFound, "get pass: %v", err)
	}
	if passEntity.UserID != userID {
		return nil, errcode.Wrap(errcode.ErrPassNotFound, "pass not owned by user")
	}

	// 步骤 3：调 trade.GeneratePayURL（当前单元素，遍历 deal_names[0]）
	dealName := req.DealNames[0]
	var opts *tradeadapter.GeneratePayURLOptions
	if req.Platform != "" || req.WxOpenID != "" || req.CancelURL != "" || req.ReturnURL != "" {
		opts = &tradeadapter.GeneratePayURLOptions{
			Platform:  req.Platform,
			WxOpenID:  req.WxOpenID,
			CancelURL: req.CancelURL,
			ReturnURL: req.ReturnURL,
		}
		// wx_app_id：当 wx_open_id 非空（微信公众号 / 小程序场景）时透传给 trade
		// → jifei.getMidasEarmarking.wxAppId。
		// TODO(billing-integration): 当前快速修复阶段先在代码中硬编码 AppID，
		// 后续通过 ctl 进程级配置（toml [jifei] wx_pay_app_id 基线 +
		// CTL_JIFEI_WX_PAY_APP_ID env 覆盖，与 CTL_REDIS_PASS / CTL_SHADOW_TOKEN
		// 等敏感配置同范式）注入。
		if req.WxOpenID != "" {
			opts.WxAppID = "wxf95ea3ae45d5304f"
		}
	}
	urlCtx, urlCancel := context.WithTimeout(context.Background(), payURLRequestTimeout)
	urlResp, urlErr := adapterfactory.DefaultAdapterFactory.TradeAdapter().GeneratePayURL(urlCtx, dealName, opts)
	urlCancel()
	if urlErr != nil {
		logger.Warn("renew pass order url: trade.GeneratePayURL failed",
			zap.String("deal_name", dealName),
			zap.Error(urlErr),
		)
		return nil, fmt.Errorf("trade generate pay url: %w", urlErr)
	}
	if urlResp == nil {
		return nil, fmt.Errorf("trade generate pay url returned nil response")
	}

	logger.Info("renew pass order url succeeded", zap.String("deal_name", dealName))

	return &transport.RenewPassOrderUrlResult{
		DealName:   dealName,
		PayURL:     urlResp.PayURL,
		TokenID:    urlResp.TokenID,
		OrderID:    urlResp.OrderID,
		MidasAppID: urlResp.MidasAppID,
		NeedCharge: urlResp.NeedCharge,
		Uin:        urlResp.Uin,
		AppID:      urlResp.AppID,
	}, nil
}

// RenewPassOrder v1.7.31 接口拆分：续费纯下单（不再拉支付 URL）。
//
// 流程概览：
//
//  1. 入参强校验（userID / passID / period / timeUnit）
//  2. 反查 pass 实体确认存在 + 持有人匹配
//  3. 校验 Bundle 存在
//  4. 调 trade.PlaceRenewOrder 创建 jifei 续费订单
//  5. 返回 deal_names
//
// **不修改本地 pass 表** — pass.status 推进由 jifei → trade.renewResource → ctl.RenewPass 链路触发。
func (l *logic) RenewPassOrder(userID, passID string, req *transport.RenewPassOrderRequest) (*transport.RenewPassOrderResult, error) {
	placeReq, logger, err := l.prepareRenewPassOrder(userID, passID, req)
	if err != nil {
		return nil, err
	}

	// 调 trade.PlaceRenewOrder
	placeCtx, placeCancel := context.WithTimeout(context.Background(), 15*time.Second)
	placeResp, placeErr := adapterfactory.DefaultAdapterFactory.TradeAdapter().PlaceRenewOrder(placeCtx, placeReq)
	placeCancel()
	if placeErr != nil {
		logger.Warn("renew pass order: trade.PlaceRenewOrder failed", zap.Error(placeErr))
		if mappedErr := tradeShadowBindingNotFoundError(placeErr); mappedErr != nil {
			return nil, mappedErr
		}
		return nil, fmt.Errorf("trade place renew order: %w", placeErr)
	}
	if placeResp == nil || placeResp.DealName == "" {
		logger.Warn("renew pass order: trade.PlaceRenewOrder returned empty dealName")
		return nil, fmt.Errorf("trade place renew order returned empty dealName")
	}
	logger.Info("renew pass order succeeded",
		zap.String("deal_name", placeResp.DealName),
		zap.String("big_order_id", placeResp.BigOrderID),
	)

	result := &transport.RenewPassOrderResult{
		DealNames: []string{placeResp.DealName},
	}

	// v1.7.32 新增：签发 auth_code ticket（与 CreatePassOrder 同范式 + A3 不变量）。
	// 额外绑定 passID，中转页续费链路中验证 ticket.PassID == path 上的 pass_id，避免
	// 跨 pass 撞 ticket。签发失败返空，前端降级走 Bearer 链路。
	if store := authcode.DefaultStore; store != nil {
		issueCtx, issueCancel := context.WithTimeout(context.Background(), 2*time.Second)
		code, issueErr := store.Issue(issueCtx, &authcode.Ticket{
			UserID:    userID,
			DealNames: result.DealNames,
			PassID:    passID,
		})
		issueCancel()
		if issueErr != nil {
			logger.Warn("renew pass order: issue auth_code failed, fallback to empty",
				zap.Error(issueErr))
		} else {
			result.AuthCode = code
		}
	}

	return result, nil
}

// RenewPassOrderAndPay 详见 Logic 接口注释。
//
// 流程概览（与 CreatePassOrderAndPay 对偶 + 续费独有：复用 prepareRenewPassOrder helper）：
//
//  1. 入参强校验（userID / passID / period / timeUnit）— v1.7.22 B17 删除 bundle_id 校验
//  2. 反查 pass 实体确认存在 + 当前持有人匹配 userID（防越权续费）
//  3. 校验 Bundle 存在（v1.7.22 B17 修订：不校验 BundleState；套餐下架仍可续费）
//  5. 调 trade.PlaceRenewOrderAndPay 一次完成"下单 + 支付 + 触发 renewResource 回调"
//  5. 返回 (DealName, BigOrderID) 给上层（不返 PayURL，一体化跳过支付 URL）
//
// **不修改本地 pass 表** — pass.status 推进由 jifei → trade.renewResource → ctl.RenewPass
// 链路触发（与 RenewPassOrderUrl 不写本地 pass 同范式；与 CreatePassOrderAndPay 不写本地 pass 同范式）。
//
// 与 CreatePassOrderAndPay 的差异（与 RenewPassOrderUrl vs CreatePassOrder 同范式）：
//   - 共享前置 prepareRenewPassOrder（含 pass 反查 + 持有人校验，CreatePass 是反向"用户唯一 pass"防御）
//   - 调 trade.PlaceRenewOrderAndPay（vs CreatePass 的 PlaceOrderAndPay；端点 + 入参 DTO 不同）
func (l *logic) RenewPassOrderAndPay(userID, passID string, req *transport.RenewPassOrderRequest) (*transport.RenewPassOrderAndPayResult, error) {
	// 步骤 1 ~ 5：共享前置（与 RenewPassOrder 复用同一个 prepareRenewPassOrder helper）
	placeReq, logger, err := l.prepareRenewPassOrder(userID, passID, req)
	if err != nil {
		return nil, err
	}

	// 步骤 5：调 trade.PlaceRenewOrderAndPay（一次完成下单 + 支付，与 CreatePassOrderAndPay 30s 超时一致）
	placeCtx, placeCancel := context.WithTimeout(context.Background(), 30*time.Second)
	placeResp, placeErr := adapterfactory.DefaultAdapterFactory.TradeAdapter().PlaceRenewOrderAndPay(placeCtx, placeReq)
	placeCancel()
	if placeErr != nil {
		logger.Warn("renew pass order and pay: trade.PlaceRenewOrderAndPay failed", zap.Error(placeErr))
		if mappedErr := tradeShadowBindingNotFoundError(placeErr); mappedErr != nil {
			return nil, mappedErr
		}
		return nil, fmt.Errorf("trade place renew order and pay: %w", placeErr)
	}
	if placeResp == nil || placeResp.DealName == "" {
		return nil, fmt.Errorf("trade place renew order and pay: empty deal_name")
	}
	logger.Info("renew pass order and pay succeeded",
		zap.String("deal_name", placeResp.DealName),
		zap.String("big_order_id", placeResp.BigOrderID),
	)

	// 步骤 6：返回（不写本地 pass，PayURL 一体化接口下永远为空，不返）
	return &transport.RenewPassOrderAndPayResult{
		DealName:   placeResp.DealName,
		BigOrderID: placeResp.BigOrderID,
	}, nil
}

// === trade-pass-renew RenewPassPrice 实现（v1.7.21 B16 / R-C-4 续费询价）===

// RenewPassPrice 详见 Logic 接口注释。
//
// 流程概览（与 RenewPassOrderUrl 高度对偶；3 处差异）：
//
//  1. 入参强校验（userID / passID / period / timeUnit）— 不校验 bundle_id（用户拍板 b：
//     续费不能换 bundle，body 不带 bundle_id，由 ctl 内部从 passEntity.BundleID 取值）
//  2. 反查 pass 实体（与 RenewPassOrderUrl 步骤 2 同范式）+ 持有人校验防越权
//  3. 校验 passEntity.BundleID 对应 Bundle 存在（v1.7.22 B17 修订：不校验 BundleState；
//     套餐下架仍可续费询价）
//  4. **不调 shadow** — trade.QuoteRenew 已支持 ShadowClient 自动反查（ctl 只透传
//     externalUserId / 与新购询价 DescribeBundles 同范式）；trade 反查失败时，ctl
//     将 BindingNotFound 翻译为 ErrPassShadowBindingRequired，保持新购 / 续费错误语义一致
//  5. 构造 trade.InquiryRenew 入参（含 ResourceID + CurDeadline = passEntity.ExpiredTime.Format(...)）
//  6. 调 trade adapter，把响应的 prices[0] 拍平为 RenewPassPriceResult 返回
//
// **本接口不创建/修改本地 pass**（询价无副作用）。
func (l *logic) RenewPassPrice(userID, passID string, req *transport.RenewPassPriceRequest) (*transport.RenewPassPriceResult, error) {
	// 步骤 1：入参强校验
	if userID == "" {
		return nil, errcode.Wrap(errcode.ErrPassInvalidParam, "user_id is required")
	}
	passID = strings.TrimSpace(passID)
	if passID == "" {
		return nil, errcode.Wrap(errcode.ErrPassInvalidParam, "pass_id is required")
	}
	if req == nil {
		return nil, errcode.Wrap(errcode.ErrPassInvalidParam, "request is nil")
	}
	if req.Period <= 0 {
		return nil, errcode.Wrap(errcode.ErrPassInvalidParam, "period must be > 0")
	}
	if req.TimeUnit != bundlemodel.TimeUnitMonth && req.TimeUnit != bundlemodel.TimeUnitDay && req.TimeUnit != bundlemodel.TimeUnitYear {
		return nil, errcode.Wrap(errcode.ErrPassInvalidParam, "time_unit must be 'm', 'd' or 'y'")
	}

	logger := resource.ZapLogger.With(
		zap.String("flow", "renew_pass_price"),
		zap.String("user_id", userID),
		zap.String("pass_id", passID),
		zap.Int("period", req.Period),
		zap.String("time_unit", req.TimeUnit),
	)
	logger.Info("renew pass price: started")

	// 步骤 2：反查 pass 实体 + 持有人校验
	passDao := modelfactory.DefaultDaoFactory.PassDao(nil)
	passEntity, err := passDao.GetByPassID(passID)
	if err != nil {
		return nil, errcode.Wrap(errcode.ErrPassNotFound, "get pass: %v", err)
	}
	if passEntity.UserID != userID {
		return nil, errcode.Wrap(errcode.ErrPassNotFound, "pass not owned by user")
	}

	// 步骤 3：校验 Bundle 存在 (v1.7.22 B17 修订)
	//
	// 业务语义: BundleState=OFFLINE (套餐已下架) 也允许续费询价 — 套餐下架只阻断
	// 新购询价 / 不阻断续费询价 (老用户对存量 pass 续费畅通无阻; 与续费下单 prepareRenewPassOrder
	// 同范式).
	if _, err := l.bundleLogic.GetBundleByID(passEntity.BundleID); err != nil {
		return nil, err
	}

	// 步骤 4：构造 trade.InquiryRenew 入参
	//
	// CurDeadline (v1.7.21 B16, 与续费下单 v1.7.20 B15 同源): 真源 = passEntity.ExpiredTime
	// (DB 唯一权威, 不接受前端透传避免漂移); 按 jifei PDF §4.4 示例 "2019-02-11 11:49:52" 格式拼字符串.
	//
	// shadow 反查由 trade ShadowClient 自动完成，ctl 只透传 ExternalUserID（与新购询价
	// DescribeBundles → trade.InquiryBatch 同范式）。Uin / AppID 字段留空。
	inqReq := &tradeadapter.InquiryRenewRequest{
		ExternalUserID: userID,
		BundleID:       passEntity.BundleID,
		ResourceID:     passID,
		CurDeadline:    formatCurDeadlineForJifei(passEntity.ExpiredTime),
		Period:         req.Period,
		TimeUnit:       req.TimeUnit,
		GoodsNum:       lighthousePassGoodsNum,
		PayMode:        lighthousePassPayMode,
	}

	// 步骤 5：调 trade.InquiryRenew（询价超时与新购询价同口径 15s，避免 jifei 慢响应阻塞前端）
	inqCtx, inqCancel := context.WithTimeout(context.Background(), 15*time.Second)
	inqResp, inqErr := adapterfactory.DefaultAdapterFactory.TradeAdapter().InquiryRenew(inqCtx, inqReq)
	inqCancel()
	if inqErr != nil {
		logger.Warn("renew pass price: trade.InquiryRenew failed", zap.Error(inqErr))
		if mappedErr := tradeShadowBindingNotFoundError(inqErr); mappedErr != nil {
			return nil, mappedErr
		}
		return nil, fmt.Errorf("trade inquiry renew: %w", inqErr)
	}
	if inqResp == nil || len(inqResp.Prices) == 0 || inqResp.Prices[0] == nil {
		return nil, fmt.Errorf("trade inquiry renew: empty prices")
	}
	q := inqResp.Prices[0]

	logger.Info("renew pass price: succeeded",
		zap.String("price", q.Price),
		zap.String("real_total_cost", q.RealTotalCost),
		zap.Float64("discount", q.Discount),
	)

	// 步骤 6：拍平为 RenewPassPriceResult（仅返价格 6 字段
	// + bundle_id 用于审计；string → float64 与新购 BundlePrice 对齐）
	return renewQuoteToPrice(q), nil
}

func renewQuoteToPrice(q *tradeadapter.BundleQuote) *transport.RenewPassPriceResult {
	return &transport.RenewPassPriceResult{
		BundleID:      q.BundleID,
		Price:         parseQuotePrice(q.Price),
		TotalCost:     parseQuotePrice(q.TotalCost),
		TaxPrice:      parseQuotePrice(q.TaxPrice),
		RealTotalCost: parseQuotePrice(q.RealTotalCost),
		Currency:      q.Currency,
		Discount:      q.Discount,
	}
}

// parseQuotePrice 把 trade adapter BundleQuote 的字符串价格字段解析为 float64。
//
// 与 ctl/main/api/bundle_handler.go bundleQuoteToPrice 的 parse helper 同语义 — 解析失败
// 降级为 0（避免单字段失败让整条 quote 丢弃）；零值降级语义与 BundlePrice 字段集对齐。
//
// 抽出到 logic 包（与 RenewPassPrice 同包）便于续费询价 step 6 复用，避免与 bundle_handler
// 重复逻辑。
func parseQuotePrice(s string) float64 {
	if s == "" {
		return 0
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return v
}

func isTradeShadowBindingNotFound(err error) bool {
	var tradeErr *tradeadapter.Error
	return errors.As(err, &tradeErr) && tradeErr.Code == "BindingNotFound"
}

func tradeShadowBindingNotFoundError(err error) error {
	if isTradeShadowBindingNotFound(err) {
		return errcode.ErrPassShadowBindingRequired
	}
	return nil
}

// prepareRenewPassOrder 是 RenewPassOrderUrl 的共享前置流程（与 prepareCreatePassOrder 对偶）。
//
// 步骤覆盖（与 CreatePassOrder 关键差异在第 2 / 第 3 步）：
//
//  1. 入参强校验（userID / passID / period / timeUnit）— v1.7.22 B17 删除 bundle_id 必填校验
//     （续费不能换 bundle，bundle_id 由 ctl 内部从 passEntity.BundleID 取）
//  2. 反查 pass 实体确认存在 + 当前持有人匹配 userID（防越权续费）—— CreatePassOrder 是
//     "用户唯一 pass 兜底防御"（不应已有 pass）；本接口反向：必须已有该 pass
//  3. 校验 Bundle 存在 — v1.7.22 B17 修订：仅校验存在性，**不再校验 BundleState=ONLINE**
//     （套餐下架不应阻断老用户续费；只阻断新购）
//  4. 构造 trade.PlaceRenewOrder 入参 (只透传 ExternalUserID + ResourceID + CurDeadline)
func (l *logic) prepareRenewPassOrder(
	userID, passID string,
	req *transport.RenewPassOrderRequest,
) (*tradeadapter.PlaceRenewOrderRequest, *zap.Logger, error) {
	// 步骤 1：入参强校验
	if userID == "" {
		return nil, nil, errcode.Wrap(errcode.ErrPassInvalidParam, "user_id is required")
	}
	passID = strings.TrimSpace(passID)
	if passID == "" {
		return nil, nil, errcode.Wrap(errcode.ErrPassInvalidParam, "pass_id is required")
	}
	if req == nil {
		return nil, nil, errcode.Wrap(errcode.ErrPassInvalidParam, "request is nil")
	}
	// v1.7.22 B17 删除: bundle_id 必填校验. 续费不能换 bundle, bundle_id 由 ctl 内部
	// 从 passEntity.BundleID 取 (与续费询价 RenewPassPriceRequest 同范式).
	if req.Period <= 0 {
		return nil, nil, errcode.Wrap(errcode.ErrPassInvalidParam, "period must be > 0")
	}
	if req.TimeUnit != bundlemodel.TimeUnitMonth && req.TimeUnit != bundlemodel.TimeUnitDay && req.TimeUnit != bundlemodel.TimeUnitYear {
		return nil, nil, errcode.Wrap(errcode.ErrPassInvalidParam, "time_unit must be 'm', 'd' or 'y'")
	}

	logger := resource.ZapLogger.With(
		zap.String("flow", "renew_pass_order_url"),
		zap.String("user_id", userID),
		zap.String("pass_id", passID),
		zap.Int("period", req.Period),
		zap.String("time_unit", req.TimeUnit),
	)
	logger.Info("renew pass order: prepare started")

	// 步骤 2：反查 pass 实体（与 CreatePassOrder "用户唯一 pass" 反向：续费必须已有 pass）
	passDao := modelfactory.DefaultDaoFactory.PassDao(nil)
	passEntity, err := passDao.GetByPassID(passID)
	if err != nil {
		return nil, logger, errcode.Wrap(errcode.ErrPassNotFound, "get pass: %v", err)
	}
	if passEntity.UserID != userID {
		// 防越权续费：当前用户不持有此 pass
		return nil, logger, errcode.Wrap(errcode.ErrPassNotFound, "pass not owned by user")
	}

	// 步骤 3：校验 Bundle 存在 (v1.7.22 B17 修订)
	//
	// 业务语义: BundleState=OFFLINE (套餐已下架) 也允许续费 — 套餐下架只阻断新购,
	// 不能阻断老用户续费 (避免业务 / 客服补偿成本). 这里仅做 GetBundleByID 存在性校验
	// (套餐被彻底删除则报错), 不再校验 BundleState=ONLINE.
	//
	// 与新购 (prepareCreatePassOrder) 关键差异:
	//   - 新购: BundleState 必须 ONLINE + 不能 SoldOut (老用户感知不到下架)
	//   - 续费: 仅校验存在性, 状态不限 (老用户对存量 pass 续费畅通无阻)
	if _, err := l.bundleLogic.GetBundleByID(passEntity.BundleID); err != nil {
		return nil, logger, err
	}

	// 步骤 4：构造 trade 入参 (Q30 拍板: ctl 不调 shadow, 只透传 ExternalUserID,
	// trade 内部 ShadowClient 反查 uin/appId)
	//
	// CurDeadline (v1.7.20 B15): 真源 = passEntity.ExpiredTime (DB 唯一权威, 不接受
	// 前端透传避免漂移); 按 jifei PDF §4.4 示例 "2019-02-11 11:49:52" 格式拼字符串.
	// active 续费 → expired_time 是即将到的过期时间; isolated 续费 → expired_time
	// 是已过期时刻 — 都符合 PDF "原资源到期时间" 语义.
	return &tradeadapter.PlaceRenewOrderRequest{
		ExternalUserID: userID,
		BundleID:       passEntity.BundleID, // v1.7.22 B17: 真源 = passEntity.BundleID, 续费不能换 bundle
		ResourceID:     passID,              // 关键差异：续费必带 pass_id 作为 ResourceID
		CurDeadline:    formatCurDeadlineForJifei(passEntity.ExpiredTime),
		Period:         req.Period,
		TimeUnit:       req.TimeUnit,
		GoodsNum:       lighthousePassGoodsNum,
		PayMode:        lighthousePassPayMode,
	}, logger, nil
}
