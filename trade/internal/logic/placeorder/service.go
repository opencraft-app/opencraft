// Package placeorder 实现 trade 服务对外暴露的"下单"业务能力（迭代 8A）。
//
// 设计稿对齐（trade-purchase-flow-design.md §4.2.1 / §4.3 / Q41 / Q42 / Q47 / Q48）：
//   - 入参：externalUserId / bundleId / period / timeUnit / goodsNum / payMode / regionId
//     （**本期折中**：uin / appID 也作为显式入参，shadow 反查留作 8B 或后续迭代接入）
//   - 流程：
//     1) 校验入参
//     2) 反查 ctl bundle（确认存在 + 在售）
//     3) 反查 trade_bundle_definition（拿 jifei 协议元数据 + sv_list / product_info）
//     4) 调 jifei generateDeals 拿 BigDealID / DealName
//     5) 落 trade_order（status='pending_pay'）
//     6) 返回 (DealName, BigOrderID)
//
// 错误分类：
//   - 入参缺失 → ErrInvalidInput
//   - bundle 不存在（ctl 或 trade_bundle_definition 任一返 NotFound）→ ErrBundleNotFound
//   - bundle 已下架 → ErrBundleOffline
//   - jifei generateDeals 失败 → 透传 *jifeiclient.CGWError 或 raw error
//   - trade_order UNIQUE 冲突 → ErrDealNameDuplicate（理论不会发生，dealName 由 jifei 生成）
//
// 不做：
//   - 询价复算（信任入参 period/payMode 即业务层传入语义；如需"防价格不一致" reconcile，
//     由上层 ctl 在调用前自己询价并对比）
//   - 支付 url 生成：拆为独立的 GeneratePayURL 方法（本期未命中 trade_order.pay_url 时返
//     **确定性 mock URL** 占位，jifei "生成支付 url" SDK 接入后再替换为真实 URL）
package placeorder

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/shadowclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// 业务错误哨兵（上层 errors.Is 判定）。
var (
	// ErrInvalidInput 入参校验失败
	ErrInvalidInput = errors.New("placeorder: invalid input")

	// ErrBundleNotFound bundle 在 ctl 或 trade_bundle_definition 任一不存在
	ErrBundleNotFound = errors.New("placeorder: bundle not found")

	// ErrBundleOffline bundle 在 ctl 已下架（bundle_state != ONLINE）
	ErrBundleOffline = errors.New("placeorder: bundle offline")

	// ErrDealNameDuplicate trade_order UNIQUE 冲突（dealName 由 jifei 生成，理论不应发生）
	ErrDealNameDuplicate = errors.New("placeorder: deal_name already exists")

	// ErrJifeiResponseInvalid jifei generateDeals 响应缺失 BigDealID / DealNames
	ErrJifeiResponseInvalid = errors.New("placeorder: jifei generateDeals response invalid")

	// ErrPayURLUnavailable 历史哨兵，迭代 8B-1.5 起 GeneratePayURL 不再主动返此错（未命中
	// trade_order.pay_url 时改为返 mock URL）。保留导出符号以兼容外部 errors.Is 判定。
	ErrPayURLUnavailable = errors.New("placeorder: pay url not available")

	// ErrBindingNotFound externalUserId 在 shadow 没有绑定记录（用户未实名 / 未绑云账号）
	// 上层应映射为引导用户实名 / 绑定的业务错，不上报 5xx
	ErrBindingNotFound = errors.New("placeorder: binding not found")
)

// PlaceOrderRequest 是 PlaceOrder 入参。
//
// 与 §4.2.1 内部 RPC 入参 schema 对齐；ExternalUserID / Uin / AppID 当前都作为显式入参，
// shadow 反查（externalUserId → uin/appId）留作 8B 或后续迭代接入。
type PlaceOrderRequest struct {
	ExternalUserID string
	Uin            string
	AppID          string
	BundleID       string
	Period         int
	TimeUnit       string
	GoodsNum       int
	PayMode        int
	RegionID       int
}

// PlaceOrderResult 是 PlaceOrder 出参（与 trade_order.deal_name / big_order_id 字段对齐）。
//
// PayURL 字段：generateDeals 通常不返回 payUrl（设计稿 §4.2.2 解释了 jifei SDK 拆分 SDK 的
// 设计动机）；本期 PlaceOrder 完成时 PayURL 留空，由 ctl 后续调 GeneratePayURL 单独获取。
type PlaceOrderResult struct {
	DealName   string `json:"deal_name"`
	BigOrderID string `json:"big_order_id"`
	PayURL     string `json:"pay_url,omitempty"` // 本期始终为空字符串，留作向后兼容
	ExpireAt   string `json:"expire_at,omitempty"`
}

// Deps 是 Service 的依赖注入。
//
// 必填项（构造期 New() 校验）：CTLClient / BundleStore / JifeiClient / OrderWriter / OrderStore。
// 可选项：ShadowClient — 8B-1 后接入；非 nil 时 PlaceOrder 自动反查 externalUserId →
// (uin, app_id) 回填；nil 时退化为"由调用方在 PlaceOrderRequest 显式提供 Uin/AppID"
// 的 8A 行为，保持向后兼容。
type Deps struct {
	CTLClient    ctlclient.Client
	BundleStore  store.BundleDefinitionStore
	JifeiClient  jifeiclient.Client
	OrderWriter  store.OrderWriter
	OrderStore   store.OrderStore // GeneratePayURL 反查 trade_order.pay_url 用
	ShadowClient shadowclient.Client // 可选，nil 表示由调用方传 Uin/AppID
}

// Service 实现"业务层下单"能力。
type Service struct {
	deps Deps
}

// New 构造 Service；依赖 nil 时 panic（启动期暴露编程错）。
func New(deps Deps) *Service {
	if deps.CTLClient == nil {
		panic("placeorder.New: CTLClient is required")
	}
	if deps.BundleStore == nil {
		panic("placeorder.New: BundleStore is required")
	}
	if deps.JifeiClient == nil {
		panic("placeorder.New: JifeiClient is required")
	}
	if deps.OrderWriter == nil {
		panic("placeorder.New: OrderWriter is required")
	}
	if deps.OrderStore == nil {
		panic("placeorder.New: OrderStore is required")
	}
	return &Service{deps: deps}
}

// PlaceOrder 执行单次下单。
func (s *Service) PlaceOrder(ctx context.Context, req PlaceOrderRequest) (*PlaceOrderResult, error) {
	if err := s.validatePlaceOrderRequest(&req); err != nil {
		return nil, err
	}

	// 1.5 shadow 反查（8B-1）：当 Uin 未由调用方显式提供时，从 externalUserId 反查云账号身份。
	if strings.TrimSpace(req.Uin) == "" && s.deps.ShadowClient != nil {
		if strings.TrimSpace(req.ExternalUserID) == "" {
			return nil, fmt.Errorf("%w: external_user_id is required when uin is missing", ErrInvalidInput)
		}
		binding, err := s.deps.ShadowClient.GetBindingByExternalUserID(ctx, req.ExternalUserID)
		if err != nil {
			if errors.Is(err, shadowclient.ErrBindingNotFound) {
				return nil, fmt.Errorf("%w: externalUserId=%s", ErrBindingNotFound, req.ExternalUserID)
			}
			return nil, fmt.Errorf("placeorder: shadow GetBindingByExternalUserID: %w", err)
		}
		if strings.TrimSpace(binding.Uin) == "" {
			return nil, fmt.Errorf("%w: shadow returned empty uin for externalUserId=%s",
				ErrBindingNotFound, req.ExternalUserID)
		}
		req.Uin = binding.Uin
		if req.AppID == "" {
			req.AppID = binding.AppID
		}
	}

	// 2. 反查 ctl bundle
	bundle, err := s.deps.CTLClient.GetBundleByID(ctx, req.BundleID)
	if err != nil {
		if errors.Is(err, ctlclient.ErrNotFound) {
			return nil, fmt.Errorf("%w: ctl bundleId=%s", ErrBundleNotFound, req.BundleID)
		}
		return nil, fmt.Errorf("placeorder: ctl GetBundleByID: %w", err)
	}
	if !strings.EqualFold(bundle.BundleState, "ONLINE") {
		return nil, fmt.Errorf("%w: bundleId=%s state=%s",
			ErrBundleOffline, req.BundleID, bundle.BundleState)
	}

	// 3. 反查 trade_bundle_definition
	def, err := s.deps.BundleStore.GetBundleDefinitionByID(ctx, req.BundleID)
	if err != nil {
		if errors.Is(err, store.ErrBundleDefinitionNotFound) {
			return nil, fmt.Errorf("%w: trade_bundle_definition bundleId=%s",
				ErrBundleNotFound, req.BundleID)
		}
		return nil, fmt.Errorf("placeorder: get bundle definition: %w", err)
	}

	categoryID := def.CategoryIDForScene("purchase")
	if categoryID == "" {
		return nil, fmt.Errorf("placeorder: bundle definition missing category_ids[scene=purchase]: bundleId=%s",
			req.BundleID)
	}

	// 4. 拼装 jifei generateDeals 入参
	goodsDetail := buildGoodsDetail(def, req)
	dealsReq := &jifeiclient.GenerateDealsRequest{
		OwnerUin: req.Uin,
		Uin:      req.Uin,
		GoodsInfos: []jifeiclient.GoodsInfo{
			{
				GoodsCategoryID: categoryID,
				RegionID:        req.RegionID,
				GoodsNum:        req.GoodsNum,
				PayMode:         req.PayMode,
				GoodsDetail:     goodsDetail,
			},
		},
	}
	dealsResp, err := s.deps.JifeiClient.GenerateDeals(ctx, dealsReq)
	if err != nil {
		return nil, fmt.Errorf("placeorder: jifei GenerateDeals: %w", err)
	}
	if dealsResp == nil || dealsResp.BigDealID == "" || len(dealsResp.DealNames) == 0 || dealsResp.DealNames[0] == "" {
		return nil, fmt.Errorf("%w: BigDealID=%q DealNames=%v",
			ErrJifeiResponseInvalid,
			func() string {
				if dealsResp == nil {
					return ""
				}
				return dealsResp.BigDealID
			}(),
			func() []string {
				if dealsResp == nil {
					return nil
				}
				return dealsResp.DealNames
			}(),
		)
	}

	dealName := dealsResp.DealNames[0]

	// 5. 落 trade_order（status='pending_pay'）
	in := store.CreateOrderInput{
		BigOrderID:     dealsResp.BigDealID,
		DealName:       dealName,
		ExternalUserID: req.ExternalUserID,
		Uin:            req.Uin,
		AppID:          req.AppID,
		SubProductCode: def.SubProductCode,
		BundleID:       req.BundleID,
		Period:         req.Period,
		TimeUnit:       req.TimeUnit,
		GoodsNum:       req.GoodsNum,
		RegionID:       req.RegionID,
		PayMode:        req.PayMode,
		GoodsDetail:    goodsDetail,
		Status:         "pending_pay",
		ResourceType:   "pass",
		// ExpireTime 由 jifei 控制订单失效（本期 trade 不主动设置；列允许 NULL 但
		// migration 0001 默认为零值 time.Time → MySQL 落 1970-01-01 占位）
		ExpireTime: time.Time{},
	}
	if err := s.deps.OrderWriter.CreateOrder(ctx, in); err != nil {
		if errors.Is(err, store.ErrTradeOrderDuplicate) {
			// dealName 由 jifei 生成、理论唯一；冲突说明状态不一致 — 透传错误，不掩盖
			return nil, fmt.Errorf("%w: dealName=%s", ErrDealNameDuplicate, dealName)
		}
		return nil, fmt.Errorf("placeorder: persist trade_order dealName=%s: %w", dealName, err)
	}

	return &PlaceOrderResult{
		DealName:   dealName,
		BigOrderID: dealsResp.BigDealID,
	}, nil
}

// PlaceOrderAndPay 执行 jifei "下单并支付"一体化流程（迭代 8B-1.5）。
//
// 与 PlaceOrder 的差异：
//   - PlaceOrder：调 jifei `qcloud.Deal.generateDeals` 仅创建订单，落库 status='pending_pay'，
//     由调用方再走 GeneratePayURL 拿支付 URL 引导用户在浏览器付款；jifei 异步收款后回调
//     trade.createResource 完成发货。
//   - PlaceOrderAndPay：调 jifei `qcloud.Deal.generateDealsAndPay` 一体化接口，**一次调用** 完成
//     "创建订单 + 同步支付 + 触发 checkCreate / createResource 回调"，跳过支付 URL；落库
//     status='paid_pending_provision'（已支付，等待 / 已触发发货回调）。
//
// 协议依据：jifei PDF "下单并支付订单 - qcloud.Deal.generateDealsAndPay" §1：
//
//	"接口协议与下单接口 generateDeals 保持一致 ... 是当前唯一可在购买环节即时返回资源 ID 的接口。"
//
// 使用场景：
//   - **联调测试 / 自动化 e2e**：在测试代金券充足的环境里用 autoVoucher=1 自动扣完，让
//     trade ↔ jifei ↔ ctl.createResource 整条链路无需真人浏览器付款即可端到端跑通。
//   - **降配 / 内部代付**（PDF §1 "特殊约束：在执行降配操作时，必须采用'下单并支付'一体化接口"）：
//     未来若 trade 接入降配流程，**必须**走本方法而非 PlaceOrder + GeneratePayURL 双步。
//
// 错误语义：
//   - 入参 / bundle / definition 校验：与 PlaceOrder 完全一致（ErrInvalidInput / ErrBundleNotFound /
//     ErrBundleOffline / ErrBindingNotFound）
//   - jifei 业务失败（含 100207 余额不足、100151 资源锁、100199 拦截、800200 未实名 等 PDF §6
//     列出的错误码）：透传 *jifeiclient.CGWError，调用方按错误码分类处理
//   - jifei 协议失败 / HTTP 失败：与 PlaceOrder 一致透传 ErrJifeiResponseInvalid / 包装 raw err
//   - trade_order 写入失败：raw error 透传（已支付但落库失败属于运维异常）
func (s *Service) PlaceOrderAndPay(ctx context.Context, req PlaceOrderRequest) (*PlaceOrderResult, error) {
	if err := s.validatePlaceOrderRequest(&req); err != nil {
		return nil, err
	}

	// 1.5 shadow 反查（与 PlaceOrder 一致）
	if strings.TrimSpace(req.Uin) == "" && s.deps.ShadowClient != nil {
		if strings.TrimSpace(req.ExternalUserID) == "" {
			return nil, fmt.Errorf("%w: external_user_id is required when uin is missing", ErrInvalidInput)
		}
		binding, err := s.deps.ShadowClient.GetBindingByExternalUserID(ctx, req.ExternalUserID)
		if err != nil {
			if errors.Is(err, shadowclient.ErrBindingNotFound) {
				return nil, fmt.Errorf("%w: externalUserId=%s", ErrBindingNotFound, req.ExternalUserID)
			}
			return nil, fmt.Errorf("placeorder: shadow GetBindingByExternalUserID: %w", err)
		}
		if strings.TrimSpace(binding.Uin) == "" {
			return nil, fmt.Errorf("%w: shadow returned empty uin for externalUserId=%s",
				ErrBindingNotFound, req.ExternalUserID)
		}
		req.Uin = binding.Uin
		if req.AppID == "" {
			req.AppID = binding.AppID
		}
	}

	// 2. 反查 ctl bundle
	bundle, err := s.deps.CTLClient.GetBundleByID(ctx, req.BundleID)
	if err != nil {
		if errors.Is(err, ctlclient.ErrNotFound) {
			return nil, fmt.Errorf("%w: ctl bundleId=%s", ErrBundleNotFound, req.BundleID)
		}
		return nil, fmt.Errorf("placeorder: ctl GetBundleByID: %w", err)
	}
	if !strings.EqualFold(bundle.BundleState, "ONLINE") {
		return nil, fmt.Errorf("%w: bundleId=%s state=%s",
			ErrBundleOffline, req.BundleID, bundle.BundleState)
	}

	// 3. 反查 trade_bundle_definition
	def, err := s.deps.BundleStore.GetBundleDefinitionByID(ctx, req.BundleID)
	if err != nil {
		if errors.Is(err, store.ErrBundleDefinitionNotFound) {
			return nil, fmt.Errorf("%w: trade_bundle_definition bundleId=%s",
				ErrBundleNotFound, req.BundleID)
		}
		return nil, fmt.Errorf("placeorder: get bundle definition: %w", err)
	}

	categoryID := def.CategoryIDForScene("purchase")
	if categoryID == "" {
		return nil, fmt.Errorf("placeorder: bundle definition missing category_ids[scene=purchase]: bundleId=%s",
			req.BundleID)
	}

	// 4. AppID 类型转换：trade 业务层用 string（DB / 跨服务接口都是 string），jifei 协议要 int64
	//    （PDF §4.1 "appId Integer"）。空字符串 → 不传字段（jifei 通常会从 ownerUin 反查）。
	appIDInt, err := parseAppIDForJifei(req.AppID)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid appId=%q: %v", ErrInvalidInput, req.AppID, err)
	}

	// 5. 拼装 jifei generateDealsAndPay 入参
	goodsDetail := buildGoodsDetail(def, req)
	autoVoucher := 1 // 测试链路下默认自动扣代金券；如未来生产场景需要按业务参数化，再加 req 字段
	dealsReq := &jifeiclient.GenerateDealsAndPayRequest{
		OwnerUin:    req.Uin,
		Uin:         req.Uin,
		AppID:       appIDInt,
		AutoVoucher: &autoVoucher,
		GoodsInfos: []jifeiclient.GoodsInfo{
			{
				GoodsCategoryID: categoryID,
				RegionID:        req.RegionID,
				GoodsNum:        req.GoodsNum,
				PayMode:         req.PayMode,
				GoodsDetail:     goodsDetail,
			},
		},
	}
	dealsResp, err := s.deps.JifeiClient.GenerateDealsAndPay(ctx, dealsReq)
	if err != nil {
		return nil, fmt.Errorf("placeorder: jifei GenerateDealsAndPay: %w", err)
	}
	if dealsResp == nil || len(dealsResp.BigDealIDs) == 0 || dealsResp.BigDealIDs[0] == "" ||
		len(dealsResp.DealNames) == 0 || dealsResp.DealNames[0] == "" {
		return nil, fmt.Errorf("%w: BigDealIDs=%v DealNames=%v",
			ErrJifeiResponseInvalid,
			func() []string {
				if dealsResp == nil {
					return nil
				}
				return dealsResp.BigDealIDs
			}(),
			func() []string {
				if dealsResp == nil {
					return nil
				}
				return dealsResp.DealNames
			}(),
		)
	}

	dealName := dealsResp.DealNames[0]
	bigDealID := dealsResp.BigDealIDs[0]

	// 6. 落 trade_order（status='paid_pending_provision'）
	//    生产链路下 jifei generateDealsAndPay 在响应里已经同步触发了 ctl.createResource 回调，
	//    后者会通过常规 trade.createResource webhook 把 trade_order.status 推进到 'provisioned'。
	in := store.CreateOrderInput{
		BigOrderID:     bigDealID,
		DealName:       dealName,
		ExternalUserID: req.ExternalUserID,
		Uin:            req.Uin,
		AppID:          req.AppID,
		SubProductCode: def.SubProductCode,
		BundleID:       req.BundleID,
		Period:         req.Period,
		TimeUnit:       req.TimeUnit,
		GoodsNum:       req.GoodsNum,
		RegionID:       req.RegionID,
		PayMode:        req.PayMode,
		GoodsDetail:    goodsDetail,
		Status:         "paid_pending_provision", // 与 PlaceOrder 'pending_pay' 区分
		ResourceType:   "pass",
		ExpireTime:     time.Time{},
	}
	if err := s.deps.OrderWriter.CreateOrder(ctx, in); err != nil {
		if errors.Is(err, store.ErrTradeOrderDuplicate) {
			return nil, fmt.Errorf("%w: dealName=%s", ErrDealNameDuplicate, dealName)
		}
		// 已支付但写库失败：理论极少发生，运维介入。透传 raw error。
		return nil, fmt.Errorf("placeorder: persist trade_order (paid bigDealID=%s dealName=%s): %w",
			bigDealID, dealName, err)
	}

	return &PlaceOrderResult{
		DealName:   dealName,
		BigOrderID: bigDealID,
	}, nil
}

// GeneratePayURL 生成 / 反查支付页 url（设计稿 §4.2.2 接口）。
//
// **本期实现策略**（迭代 8B-1.5，jifei "生成支付 url" SDK 接入前的桩实现）：
//
//	1) 反查 trade_order 取 pay_url
//	2) 命中 → 返回缓存值（未来 jifei 异步回写 / pre-warm 的真实 URL）
//	3) 未命中 → 返回 **确定性 mock URL**（不再返 ErrPayURLUnavailable）
//
// 为什么改成 mock 兜底而非报错：
//   - 真实 jifei "生成支付 url" SDK 尚未接入；调用链上游 ctl.CreatePassOrder 需要这个接口
//     可用才能完成端到端流程（设计稿 §4.3 ctl Logic.CreatePassOrder 出参 PayURL 必须非空）。
//   - 报错（503）会让上游服务直接挂掉，无法继续走"创建本地 pass + 关联订单"分支；返 mock URL
//     则保持调用方契约不变，后续接入真实 SDK 时只需替换本函数实现，签名 / 错误类型不动。
//   - mock URL 形如 `https://buy.cloud.tencent.com/lighthouse/mock?dealName=<dealName>&token=mock`，
//     联调环境可被人眼识别为"未接入真实计费"，避免误以为已接入。
//
// **未来扩展**：jifei "生成支付 url" SDK 调用接入后，本函数 step 3 替换为：
//
//	jifei.GeneratePayURL(dealName) → UPDATE trade_order SET pay_url=?, expire_time=? WHERE deal_name=?
//	→ 返回 jifei 真实 URL
//
// 当前 ErrPayURLUnavailable 哨兵保留（外部 errors.Is 兼容），但本函数已不再返出。
func (s *Service) GeneratePayURL(ctx context.Context, dealName string) (string, error) {
	dealName = strings.TrimSpace(dealName)
	if dealName == "" {
		return "", fmt.Errorf("%w: deal_name is required", ErrInvalidInput)
	}

	order, err := s.deps.OrderStore.GetOrderByDealName(ctx, dealName)
	if err != nil {
		if errors.Is(err, store.ErrTradeOrderNotFound) {
			return "", fmt.Errorf("placeorder: trade_order not found: dealName=%s: %w",
				dealName, err)
		}
		return "", fmt.Errorf("placeorder: get trade_order dealName=%s: %w", dealName, err)
	}
	if order.PayURL != "" {
		return order.PayURL, nil
	}
	// 未命中 trade_order.pay_url 缓存 → 返 mock URL，保持调用方契约
	return mockPayURL(dealName), nil
}

// mockPayURL 构造形如
//
//	https://buy.cloud.tencent.com/lighthouse/mock?dealName=<dealName>&token=mock
//
// 的占位 URL；jifei "生成支付 url" SDK 接入前用于解锁 ctl ↔ trade 端到端联调。
//
// 单独抽出函数便于：
//   - 单测断言（不必硬编码常量）
//   - 未来接入真实 SDK 时统一替换 / 删除
func mockPayURL(dealName string) string {
	return "https://buy.cloud.tencent.com/lighthouse/mock?dealName=" + dealName + "&token=mock"
}

// validatePlaceOrderRequest 校验 PlaceOrderRequest 必填字段。
//
// Uin / ExternalUserID 校验策略（8B-1）：
//   - ShadowClient 已注入：Uin 允许为空（后续从 shadow 反查回填）；ExternalUserID 必填
//   - ShadowClient 未注入（8A 行为）：ExternalUserID + Uin 双必填，与原行为完全一致
func (s *Service) validatePlaceOrderRequest(req *PlaceOrderRequest) error {
	if strings.TrimSpace(req.BundleID) == "" {
		return fmt.Errorf("%w: bundle_id is required", ErrInvalidInput)
	}
	if strings.TrimSpace(req.ExternalUserID) == "" {
		return fmt.Errorf("%w: external_user_id is required", ErrInvalidInput)
	}
	if s.deps.ShadowClient == nil {
		// 8A 行为：Uin 必填
		if strings.TrimSpace(req.Uin) == "" {
			return fmt.Errorf("%w: uin is required", ErrInvalidInput)
		}
	}
	if req.Period <= 0 {
		return fmt.Errorf("%w: period must be > 0", ErrInvalidInput)
	}
	if strings.TrimSpace(req.TimeUnit) == "" {
		return fmt.Errorf("%w: time_unit is required", ErrInvalidInput)
	}
	if req.GoodsNum <= 0 {
		req.GoodsNum = 1 // Q41 协同：本期固定 1
	}
	if req.PayMode != 0 && req.PayMode != 1 && req.PayMode != 2 {
		return fmt.Errorf("%w: pay_mode must be 0/1/2, got %d", ErrInvalidInput, req.PayMode)
	}
	return nil
}

// buildGoodsDetail 把 BundleDefinition + 用户入参展平成 jifei goodsDetail map。
//
// 字段集与 inquiry.buildGoodsDetail 共享语义（设计稿 §3.5.5 (4) / §4.3 Step T3）：
//   - productCode / subProductCode / pid（来自 BundleDefinition）
//   - timeSpan / timeUnit / goodsNum（来自 PlaceOrderRequest）
//   - sv_*（来自 BundleDefinition.SVList，加 "sv_" 前缀，值原样保留）
//   - productInfo（直接透传）
//
// 与 inquiry buildGoodsDetail 不同点：本函数 sv_* 值不做 stringify，因为 generateDeals
// 协议层 GoodsDetail 是 map[string]interface{}，jifei 端按字段类型解析；询价侧 stringify
// 是为了与 checkCreate 入参对账保持类型一致（Q54 协议契约）。
func buildGoodsDetail(def *store.BundleDefinition, req PlaceOrderRequest) map[string]interface{} {
	out := map[string]interface{}{
		"productCode":    def.ProductCode,
		"subProductCode": def.SubProductCode,
		"pid":            def.Pid,
		"timeSpan":       req.Period,
		"timeUnit":       req.TimeUnit,
		"goodsNum":       req.GoodsNum,
	}
	for k, v := range def.SVList {
		out["sv_"+k] = v
	}
	if len(def.ProductInfo) > 0 {
		out["productInfo"] = def.ProductInfo
	}
	return out
}

// parseAppIDForJifei 把 trade 业务层的 string AppID 转换为 jifei 协议的 int64。
//
// 协议依据：jifei `qcloud.Deal.generateDealsAndPay` PDF §4.1 字段 `appId Integer`。
// 业务层 / DB / 跨服务接口（trade <-> ctl <-> shadow）一律使用 string 表示 AppID 以避免精度问题，
// 但调用 jifei CGW 时必须以 int64 序列化（否则 jifei 侧反序列化会拒绝）。
//
// 行为：
//   - 空字符串 → 返回 0；上层 jifeiclient 配合 `omitempty` 让该字段从 JSON 中省略，由 jifei 自行
//     按 ownerUin 反查（PDF §4.1 "appId 与主账号 ownerUin 对应"）。
//   - 非数字字符串 → 返回错误，由上层包装为 ErrInvalidInput。
func parseAppIDForJifei(appID string) (int64, error) {
	s := strings.TrimSpace(appID)
	if s == "" {
		return 0, nil
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse appId: %w", err)
	}
	if v < 0 {
		return 0, fmt.Errorf("parse appId: negative value %d", v)
	}
	return v, nil
}
