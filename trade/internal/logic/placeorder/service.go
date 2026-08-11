// Package placeorder 实现 trade 服务对外暴露的"下单"业务能力（迭代 8A）。
//
// 设计稿对齐（trade-purchase-flow-design.md §4.2.1 / §4.3 / Q41 / Q42 / Q47 / Q48）：
//   - 入参：externalUserId / bundleId / period / timeUnit / goodsNum / payMode
//     （**Q41 修订 2026-05-11**：regionId 不再对外暴露，trade 内部固定 1/100001 = 广州 / 广州一区，
//     ctl 与前端不再透传也不感知）
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
//   - 支付 url 生成：拆为独立的 GeneratePayURL 方法（迭代 8B-1.6 起调 jifei
//     `qcloud.margin.getMidasEarmarking` 真实接入，未命中 trade_order.pay_url 时实时获取
//     并写回缓存）
package placeorder

import (
	"context"
	"errors"
	"fmt"
	"log"
	neturl "net/url"
	"strconv"
	"strings"
	"time"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/dianshiclient"
	"git.woa.com/wisp/mono/trade/internal/jifei"
	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/logic/activity"
	"git.woa.com/wisp/mono/trade/internal/region"
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

	// ErrPassNotFoundForRenew 续费场景下 ctl 反查 pass 失败（pass_id 在用户名下找不到 / 已销毁）。
	//
	// 触发条件：trade.PlaceRenewOrder / PlaceRenewOrderAndPay 在拼装 jifei goodsDetail 前
	// 调 ctl.ListPassesByResourceIDs(appID, [pass_id]) 反查 pass.expired_time 拼 curDeadline
	// （PDF §4.3 续费 goodsDetail.curDeadline 必填字段）— 若反查返空数组 / pass 已删除 /
	// expired_time 为零值都视为本错误。
	//
	// 上层应映射为 404 PassNotFound（与 BundleNotFound 同级业务错，不上报 5xx）。
	ErrPassNotFoundForRenew = errors.New("placeorder: pass not found for renew")
)

// formatJifeiDeadline 把 ctl pass.expired_time 转成 jifei 协议层 curDeadline 字符串。
//
// 入参约束：t 必须是非零 time.Time（零值会被 ctl 反查校验拦截，理论不会到这）。
//
// 时区契约（BUG-34 修复 + 后续抽取）：jifei 协议层 curDeadline 字段约定为北京时间字面值，
// 统一委托给 trade/internal/jifei.FormatCurDeadline，与 checkrenew/resourcequery 同源，
// 避免 trade pod 跑 UTC 时 t.Format() 输出 UTC 字面值与 jifei 协议层期望错位 8h。
func formatJifeiDeadline(t time.Time) string {
	return jifei.FormatCurDeadline(t)
}

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
	AutoRenewFlag  string
	// 注：Q41 修订 2026-05-11 删除 RegionID 字段。trade 内部固定 1（广州）/ 100001（广州一区），
	// 不再由 ctl / 前端透传。如未来 bundle 按 region 差价，再放回入参 + 改用 trade_bundle_definition.region 元数据。
}

// MoveInOrderRequest 是存量免费 pass 迁入计费的下单入参。
//
// 本路径只用于外部资源迁入 qcloud.Deal.generateDealsAndPay，不会触发 checkCreate/createResource
// 回调，也不写 trade_order；迁移状态由 ctl 持有。
type MoveInOrderRequest struct {
	ExternalUserID string
	Uin            string
	AppID          string
	BundleID       string
	ResourceID     string
	CurDeadline    string
}

// trade 内部固定的 region/zone 常量已收敛到 trade/internal/region 包（11C 抽取 2026-05-12）。
// 历史上本文件、inquiry/service.go、jifei/adapter.go、resourcequery/install.go 各自声明
// 同值常量，11C 起统一引用 region.LighthouseRegionID / region.LighthouseZoneID。

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

const moveInGoodsCategoryID int64 = 176262

const (
	AutoRenewFlagNotifyAndManual   = "notify_and_manual_renew"
	AutoRenewFlagAutoRenew         = "auto_renew"
	AutoRenewFlagNoNotifyAndManual = "no_notify_and_manual_renew"
)

// Deps 是 Service 的依赖注入。
//
// 必填项（构造期 New() 校验）：CTLClient / BundleStore / JifeiClient / OrderWriter / OrderStore。
// 可选项：
//   - ShadowClient — 8B-1 后接入；非 nil 时 PlaceOrder 自动反查 externalUserId →
//     (uin, app_id) 回填；nil 时退化为"由调用方在 PlaceOrderRequest 显式提供 Uin/AppID"
//     的 8A 行为，保持向后兼容。
//   - SiteKind — v1.7.x 国际站接入新增；trade 内部站点语义字面量（"cn" / "intl"）。
//     由 main.go 从 cfg.SiteKind 透传；空字符串或非法值由 region.Resolve 兜底为
//     "cn"。本字段贯穿下单 / 续费下单 / 下单+支付 / 续费下单+支付 四个出向路径的
//     envelope.resInfo 与 trade_order.region_id 记录列（A6.1 冱点）。
//   - RegionOverride — 北京 2 预发布接入 2026-06-12 新增；腾讯云 region 字面量。
//     由 main.go 从 cfg.RegionOverride（LIGHTVELA_TRADE_REGION env）透传；非空且命中
//     region.regionTable 时优先于 SiteKind 兜底。空字符串 → 按 SiteKind 走。
type Deps struct {
	CTLClient    ctlclient.Client
	BundleStore  store.BundleDefinitionStore
	JifeiClient  jifeiclient.Client
	OrderWriter  store.OrderWriter
	OrderStore   store.OrderStore    // GeneratePayURL 反查 trade_order.pay_url 用
	ShadowClient shadowclient.Client // 可选，nil 表示由调用方传 Uin/AppID
	SiteKind     string              // 可选，v1.7.x 国际站接入；"cn" / "intl"，缺省 cn 兜底

	// RegionOverride 是腾讯云 region 字面量 override（北京 2 预发布接入新增）。
	// 合法性已由 config.Load 在启动期 fail-fast 校验；本处只负责透透到 region.Resolve。
	RegionOverride string

	// ActivityResolver 是点石活动通道判定 helper（设计稿
	// .tmp/dianshi-activity-bundle-design.md §5.2 / §5.4）。可选注入：
	//   - 非 nil：PlaceOrder / PlaceOrderAndPay 在反查 trade_bundle_definition 之后
	//     插入分叉点判定；命中点石走 placeOrderDianshi 出向
	//   - nil（默认）：完全不感知点石，走 jifei 原路径
	// PlaceRenewOrder / PlaceRenewOrderAndPay 不读取本字段（设计稿 §5.5 续费写死走 jifei）。
	ActivityResolver activity.Resolver

	// DianshiClient 是点石出向客户端（设计稿 §5.1）。仅在 ActivityResolver 也注入时
	// 被 placeOrderDianshi 调用；启动期 main.go 应保证两者同进同退。
	DianshiClient dianshiclient.Client
}

// Service 实现"业务层下单"能力。
type Service struct {
	deps Deps

	// region 在 New() 期按 deps.SiteKind 解析一次后缓存，避免每次下单都走 region.Resolve
	// 函数调用（主要为了语义上更清晰：站点决策只在启动期发生一次，运行期不再变化）。
	// placeorder 不装配 currency 字段（仅询价 GetPriceItem 用 currency），所以本处只缓存
	// region 三元组，不缓存 currency。
	region region.LighthouseRegion
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
	return &Service{
		deps:   deps,
		region: region.Resolve(deps.SiteKind, deps.RegionOverride),
	}
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

	// 3.5. 活动分叉判定（设计稿 §5.4）。仅当 ActivityResolver 注入时生效。
	// 与询价侧不同：placeOrder 的 Resolver DB 错必须 5xx（不做 graceful-degrade），
	// 否则会让用户绕过点石下单走 jifei 拿原价单 + 留下 participation 缺失的脏数据。
	if s.deps.ActivityResolver != nil {
		mapping, useDianshi, resolveErr := s.deps.ActivityResolver.ResolveForPlaceOrder(ctx, req.BundleID, req.Uin, req.Period, req.TimeUnit)
		if resolveErr != nil {
			return nil, fmt.Errorf("placeorder: activity resolve bundleId=%s uin=%s: %w",
				req.BundleID, req.Uin, resolveErr)
		}
		if useDianshi {
			log.Printf("[activity-resolver] placeorder useDianshi=true bundleId=%s uin=%s activityId=%d actId=%d",
				req.BundleID, req.Uin, mapping.ActivityID, mapping.ActID)
			return s.placeOrderDianshi(ctx, req, def, mapping)
		}
	}

	categoryID := def.CategoryIDForScene("purchase")
	if categoryID == 0 {
		return nil, fmt.Errorf("placeorder: bundle definition missing category_ids[scene=purchase]: bundleId=%s",
			req.BundleID)
	}

	// 4. 拼装 jifei generateDeals 入参
	goodsDetail := buildGoodsDetail(def, req)
	// AppID 类型转换（与 PlaceOrderAndPay 一致；jifei 协议 appId 是 int64，PDF §4.1 "appId Integer"
	// 必填）。空字符串 → 0（omitempty 不传字段，jifei 通常会从 ownerUin 反查；trade 调用方
	// 应该总是传非零值，从 shadowclient 拿）。v1.7.28 BUG-05 修复：本路径 v1.7.19 协议校准时
	// 漏配 AppID 字段透传，jifei 沙箱实测返 100001 "appId not match uin"。
	appIDInt, err := parseAppIDForJifei(req.AppID)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid appId=%q: %v", ErrInvalidInput, req.AppID, err)
	}
	dealsReq := &jifeiclient.GenerateDealsRequest{
		OwnerUin: req.Uin,
		Uin:      req.Uin,
		AppID:    appIDInt,
		Goods: []jifeiclient.GoodsInfo{
			{
				GoodsCategoryID: categoryID,
				// Q41 修订 2026-05-11 + v1.7.x A6.1：region/zone 在 New() 期按 site 解析一次缓存
				// （cn=1/100001 广州 / intl=9/900001 新加坡，合规要求国际站资源落海外地域）
				RegionID:    s.region.RegionID,
				ZoneID:      s.region.ZoneID,
				GoodsNum:    req.GoodsNum,
				PayMode:     req.PayMode,
				GoodsDetail: goodsDetail,
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
		// Q41 修订 + v1.7.x A6.1：流水留痕 region_id 跟随出向 envelope.resInfo 同源
		RegionID:     s.region.RegionID,
		PayMode:      req.PayMode,
		GoodsDetail:  goodsDetail,
		Status:       "pending_pay",
		ResourceType: "pass",
		// v1.7.28 BUG-12 修复：trade_order.expire_time 列已删（migration 0004），不再写。
	}
	if err := s.deps.OrderWriter.CreateOrder(ctx, in); err != nil {
		if errors.Is(err, store.ErrTradeOrderDuplicate) {
			// dealName 由 jifei 生成、理论上唯一；冲突说明状态不一致 — 透传错误，不掩盖
			return nil, fmt.Errorf("%w: dealName=%s", ErrDealNameDuplicate, dealName)
		}
		return nil, fmt.Errorf("placeorder: persist trade_order dealName=%s: %w", dealName, err)
	}

	return &PlaceOrderResult{
		DealName:   dealName,
		BigOrderID: dealsResp.BigDealID,
	}, nil
}

// MoveInOrderAndPay 为 ctl 已存在的免费 pass 创建计费侧外部资源迁入单。
func (s *Service) MoveInOrderAndPay(ctx context.Context, req MoveInOrderRequest) (*PlaceOrderResult, error) {
	if err := validateMoveInOrderRequest(&req); err != nil {
		return nil, err
	}

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

	def, err := s.deps.BundleStore.GetBundleDefinitionByID(ctx, req.BundleID)
	if err != nil {
		if errors.Is(err, store.ErrBundleDefinitionNotFound) {
			return nil, fmt.Errorf("%w: trade_bundle_definition bundleId=%s",
				ErrBundleNotFound, req.BundleID)
		}
		return nil, fmt.Errorf("placeorder: get bundle definition: %w", err)
	}

	appIDInt, err := parseAppIDForJifei(req.AppID)
	if err != nil || appIDInt <= 0 {
		return nil, fmt.Errorf("%w: invalid appId=%q: %v", ErrInvalidInput, req.AppID, err)
	}

	goodsDetail := buildMoveInGoodsDetail(def, req)
	dealsReq := &jifeiclient.GenerateDealsAndPayRequest{
		OwnerUin:    req.Uin,
		Uin:         req.Uin,
		AppID:       appIDInt,
		ClientToken: "lightvela-move-in:" + strings.TrimSpace(req.ResourceID) + ":" + strings.TrimSpace(req.BundleID),
		Goods: []jifeiclient.GoodsInfo{
			{
				GoodsCategoryID: moveInGoodsCategoryID,
				RegionID:        s.region.RegionID,
				ZoneID:          s.region.ZoneID,
				GoodsNum:        1,
				PayMode:         1,
				ProjectID:       0,
				Action:          "preMoveIn",
				Type:            def.SubProductCode,
				GoodsDetail:     goodsDetail,
			},
		},
	}
	dealsResp, err := s.deps.JifeiClient.GenerateDealsAndPay(ctx, dealsReq)
	if err != nil {
		return nil, fmt.Errorf("placeorder: jifei GenerateDealsAndPay (move-in): %w", err)
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

	return &PlaceOrderResult{
		DealName:   dealsResp.DealNames[0],
		BigOrderID: dealsResp.BigDealIDs[0],
	}, nil
}

// PlaceRenewOrderRequest 是 PlaceRenewOrder 入参（R-C-5 续费下单）。
//
// 与 PlaceOrderRequest 的关键差异（设计稿 .tmp/trade-pass-renew-design.md §3.5 / §4.3 / R-C 切片）：
//   - ResourceID（pass_id）必填：续费针对已有 pass，与新购无关；jifei goodsDetail.resourceId 透传，
//     trade_order.resource_id 列 INSERT 时同步写入（与 createResource 收尾 MarkOrderProvisioned 反向回填
//     的新购流程互补）
//   - jifei GoodsInfo.Action 固定 "renew"（与 inquiry.QuoteRenew Action="renew" / renewresource handler 协议字段一致）
//   - goodsCategoryId 取 BundleDefinition.CategoryIDForScene("renew")（不同于 PlaceOrder 取 "purchase"）
//   - trade_order.OrderType='renew'（migration 0003 已落，DAO 层 R-C-1 已支持 store.OrderTypeRenew 常量）
//
// 字段语义其余与 PlaceOrderRequest 对齐；本期 GoodsNum 同样固定 1，PayMode 同样固定 1（Q41 / Q42）。
type PlaceRenewOrderRequest struct {
	ExternalUserID string
	Uin            string
	AppID          string
	BundleID       string
	ResourceID     string // 续费目标 pass_id（必填）
	// CurDeadline 是 jifei goodsDetail.curDeadline 字段（PDF §4.3 续费必填）。
	//
	// 真源在 ctl pass.expired_time 列；调用方（ctl 续费 logic）从 DB 读出后按
	// "2006-01-02 15:04:05" 格式拼字符串透传给 trade，trade 不做反查、不计算、不解析、
	// 不校验业务语义，仅做透传 + 必填非空校验，jifei 拼装时直接放入 goodsDetail map。
	//
	// 选字符串而非 time.Time 的理由：(a) 与 jifei 协议层字符串形态一致，零转换链；
	// (b) trade ↔ ctl 内部 RPC 不夹时区/格式语义；(c) trade_order 落库 / 排障日志看到
	// 的就是 jifei 实际收到的字符串。
	//
	// v1.7.20 B15 (PDF §4.3 / §4.4 line 31 `"curDeadline": "2019-02-11 11:49:52"`)
	CurDeadline string
	Period      int
	TimeUnit    string
	GoodsNum    int
	PayMode     int
}

// PlaceRenewOrder 执行单次"续费下单"（R-C-5 切片落地，2026-05-15）。
//
// 流程（与 PlaceOrder 对偶；3 处差异点：scene=renew / Action=renew / OrderType=renew + ResourceID 必填）：
//  1. 校验入参（含 ResourceID 必填）
//     1.5. shadow 反查（与 PlaceOrder 一致）
//  2. 反查 ctl bundle（确认存在 + 在售；下架的 bundle 不可续费）
//  3. 反查 trade_bundle_definition（拿 jifei 协议元数据 + sv_* + category[scene=renew]）
//  4. 拼装 jifei generateDeals 入参（goodsDetail 注入 resourceId；GoodsInfo.Action="renew"）
//  5. 调 jifei generateDeals 拿 BigDealID / DealName
//  6. 落 trade_order（OrderType='renew' + ResourceID=passID + status='pending_pay'）
//  7. 返回 (DealName, BigOrderID)
//
// 错误分类（与 PlaceOrder 一致）：
//   - 入参缺失（含 ResourceID 必填新增）→ ErrInvalidInput
//   - bundle 不存在 → ErrBundleNotFound
//   - bundle 已下架 → ErrBundleOffline
//   - jifei generateDeals 失败 → 透传 *jifeiclient.CGWError 或 raw error（带 "(renew)" 标记便于排障）
//   - trade_order UNIQUE 冲突 → ErrDealNameDuplicate
//
// 不做：
//   - 续费询价复算（信任入参 period/payMode；如需 reconcile，由上层 ctl 自行调 inquiry.QuoteRenew 对比）
//   - 支付 url 生成：续费同样拆为独立 GeneratePayURL，复用同一方法（dealName 作为查找键）
//
// 一体化变体见 PlaceRenewOrderAndPay（R-D-7 落地，与 PlaceOrderAndPay 对偶）。
func (s *Service) PlaceRenewOrder(ctx context.Context, req PlaceRenewOrderRequest) (*PlaceOrderResult, error) {
	if err := s.validatePlaceRenewOrderRequest(&req); err != nil {
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
			return nil, fmt.Errorf("placeorder: shadow GetBindingByExternalUserID (renew): %w", err)
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
		return nil, fmt.Errorf("placeorder: ctl GetBundleByID (renew): %w", err)
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
		return nil, fmt.Errorf("placeorder: get bundle definition (renew): %w", err)
	}

	// scene="renew" 取 categoryId（与 inquiry.QuoteRenew 对偶；未命中报错）
	categoryID := def.CategoryIDForScene("renew")
	if categoryID == 0 {
		return nil, fmt.Errorf("placeorder: bundle definition missing category_ids[scene=renew]: bundleId=%s",
			req.BundleID)
	}

	// 4. 拼装 jifei goodsDetail（基于 buildGoodsDetail 转化为 PlaceOrderRequest 形态复用，附加 resourceId）
	goodsDetail := buildGoodsDetail(def, PlaceOrderRequest{
		Period:   req.Period,
		TimeUnit: req.TimeUnit,
		GoodsNum: req.GoodsNum,
	})
	goodsDetail["resourceId"] = req.ResourceID
	// v1.7.20 B15: jifei goodsDetail.curDeadline 必填 (PDF §4.3 续费独有 2 字段之一,
	// 与 resourceId 同源同形态), 由 ctl 调用方从 pass.expired_time 拼好直接透传, trade
	// 不做格式校验/转换 — 字符串 in / 字符串 out, 排障时 trade 日志/DB 看到的就是 jifei
	// 实际收到的字符串
	goodsDetail["curDeadline"] = req.CurDeadline

	// AppID 类型转换（与 PlaceOrder / PlaceOrderAndPay / PlaceRenewOrderAndPay 一致；
	// jifei 协议 appId 是 int64，PDF §4.1 必填）。v1.7.28 BUG-05 修复：本路径 v1.7.19 协议
	// 校准时漏配 AppID 字段透传，jifei 实测返 100001 "appId not match uin"。
	appIDInt, err := parseAppIDForJifei(req.AppID)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid appId=%q: %v", ErrInvalidInput, req.AppID, err)
	}

	dealsReq := &jifeiclient.GenerateDealsRequest{
		OwnerUin: req.Uin,
		Uin:      req.Uin,
		AppID:    appIDInt,
		Goods: []jifeiclient.GoodsInfo{
			{
				GoodsCategoryID: categoryID,
				// v1.7.x A6.1：region/zone 同 PlaceOrder，按 deps.SiteKind 决定
				RegionID:    s.region.RegionID,
				ZoneID:      s.region.ZoneID,
				GoodsNum:    req.GoodsNum,
				PayMode:     req.PayMode,
				GoodsDetail: goodsDetail,
			},
		},
	}
	dealsResp, err := s.deps.JifeiClient.GenerateDeals(ctx, dealsReq)
	if err != nil {
		return nil, fmt.Errorf("placeorder: jifei GenerateDeals (renew): %w", err)
	}
	if dealsResp == nil || dealsResp.BigDealID == "" || len(dealsResp.DealNames) == 0 || dealsResp.DealNames[0] == "" {
		return nil, fmt.Errorf("%w (renew): BigDealID=%q DealNames=%v",
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

	// 5. 落 trade_order（OrderType='renew' + ResourceID=passID + status='pending_pay'）
	//    与新购的关键差异：
	//      - OrderType=OrderTypeRenew（DAO 层不会被默认覆盖为 'create'）
	//      - ResourceID=req.ResourceID（INSERT 时直接写入，与 createResource 流程的反向回填语义不同：
	//        续费场景下 ResourceID 在订单创建时就已知 = pass_id）
	in := store.CreateOrderInput{
		BigOrderID:     dealsResp.BigDealID,
		DealName:       dealName,
		ExternalUserID: req.ExternalUserID,
		Uin:            req.Uin,
		AppID:          req.AppID,
		SubProductCode: def.SubProductCode,
		BundleID:       req.BundleID,
		OrderType:      store.OrderTypeRenew, // R-C-5 关键差异点
		Period:         req.Period,
		TimeUnit:       req.TimeUnit,
		GoodsNum:       req.GoodsNum,
		// v1.7.x A6.1：流水留痕 region_id 跟随出向 envelope.resInfo 同源
		RegionID:     s.region.RegionID,
		PayMode:      req.PayMode,
		GoodsDetail:  goodsDetail,
		Status:       "pending_pay",
		ResourceType: "pass",
		ResourceID:   req.ResourceID, // R-C-5 关键差异点：续费 INSERT 时填 pass_id
		// v1.7.28 BUG-12 修复：trade_order.expire_time 列已删（migration 0004），不再写。
	}
	if err := s.deps.OrderWriter.CreateOrder(ctx, in); err != nil {
		if errors.Is(err, store.ErrTradeOrderDuplicate) {
			return nil, fmt.Errorf("%w (renew): dealName=%s", ErrDealNameDuplicate, dealName)
		}
		return nil, fmt.Errorf("placeorder: persist trade_order (renew) dealName=%s: %w", dealName, err)
	}

	return &PlaceOrderResult{
		DealName:   dealName,
		BigOrderID: dealsResp.BigDealID,
	}, nil
}

// validatePlaceRenewOrderRequest 校验 PlaceRenewOrderRequest 必填字段（R-C-5）。
//
// 与 validatePlaceOrderRequest 对偶，附加 ResourceID 必填校验。
func (s *Service) validatePlaceRenewOrderRequest(req *PlaceRenewOrderRequest) error {
	if strings.TrimSpace(req.BundleID) == "" {
		return fmt.Errorf("%w: bundle_id is required", ErrInvalidInput)
	}
	if strings.TrimSpace(req.ResourceID) == "" {
		return fmt.Errorf("%w: resource_id is required for renew", ErrInvalidInput)
	}
	// v1.7.20 B15: jifei goodsDetail.curDeadline 必填 (PDF §4.3); 真源由 ctl 调用方
	// 从 pass.expired_time 取后按 "2006-01-02 15:04:05" 格式拼字符串透传, trade 仅
	// 做必填校验, 不做格式 parseTime — 调用方按规范拼错时由 jifei 返 100001 兜底
	// (调用方编程错, 非用户错, 归 ErrInvalidInput 400)
	if strings.TrimSpace(req.CurDeadline) == "" {
		return fmt.Errorf("%w: cur_deadline is required for renew", ErrInvalidInput)
	}
	if strings.TrimSpace(req.ExternalUserID) == "" {
		return fmt.Errorf("%w: external_user_id is required", ErrInvalidInput)
	}
	if s.deps.ShadowClient == nil {
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
		req.GoodsNum = 1
	}
	if req.PayMode != 0 && req.PayMode != 1 && req.PayMode != 2 {
		return fmt.Errorf("%w: pay_mode must be 0/1/2, got %d", ErrInvalidInput, req.PayMode)
	}
	return nil
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

	// 3.5. 活动分叉判定（设计稿 §5.4）。PlaceOrderAndPay 与 PlaceOrder 共用同一段
	// placeOrderDianshi 私有方法（jifei generateDealsAndPay 与 generateDeals 在点石路径下
	// 都收敛到同一个点石 do_goods 出向调用，区别仅在 jifei 路径上的 SDK 拆分）。
	if s.deps.ActivityResolver != nil {
		mapping, useDianshi, resolveErr := s.deps.ActivityResolver.ResolveForPlaceOrder(ctx, req.BundleID, req.Uin, req.Period, req.TimeUnit)
		if resolveErr != nil {
			return nil, fmt.Errorf("placeorder: activity resolve bundleId=%s uin=%s: %w",
				req.BundleID, req.Uin, resolveErr)
		}
		if useDianshi {
			log.Printf("[activity-resolver] placeorder-and-pay useDianshi=true bundleId=%s uin=%s activityId=%d actId=%d",
				req.BundleID, req.Uin, mapping.ActivityID, mapping.ActID)
			return s.placeOrderDianshi(ctx, req, def, mapping)
		}
	}

	// Q71 2026-05-13：CategoryIDForScene 返回 int64（jifei 协议层 goodsCategoryId 是 int，
	//   见 PDF §4.1 line 14 "goodsCategoryId Integer"），未命中场景返 0。
	categoryID := def.CategoryIDForScene("purchase")
	if categoryID == 0 {
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
		Goods: []jifeiclient.GoodsInfo{
			{
				GoodsCategoryID: categoryID,
				// v1.7.x A6.1：region/zone 同 PlaceOrder，按 deps.SiteKind 决定
				RegionID:    s.region.RegionID,
				ZoneID:      s.region.ZoneID,
				GoodsNum:    req.GoodsNum,
				PayMode:     req.PayMode,
				GoodsDetail: goodsDetail,
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

	// 6. v1.7.28 BUG-22 / BUG-23 修订（2026-05-21 用户拍板）：
	//    PlaceOrderAndPay 只在 jifei 同步发货成功（dealDeliverResults.state="0"）时
	//    INSERT 完成态 trade_order，发货失败 / 异步中等态一律不落库。
	//
	// 设计动机（与原"先落 paid_pending_provision 等异步推进"对比）：
	//   - 原方案需要 trade_order 中间态 + createResource handler 回填 resource_id，
	//     但 jifei 同步推 createResource 早于 trade INSERT 导致死锁（已通过 BUG-22
	//     goodsDetail.externalUserId 透传机制让 createResource 完全脱离 trade_order
	//     反查依赖，发货流程不依赖 trade_order）。
	//   - trade_order 退化为"订单流水记录"职责，只承载已成功完成的订单信息；中间态
	//     / 失败态没有落库价值（jifei 这一侧已有完整生命周期记录）。
	//
	// jifei state 码（PDF §5.1 + 实测）：
	//   - "0" 发货成功：resourceIds[dealName] 非空 → INSERT trade_order(provisioned)
	//   - "1" 发货中 / "2" 重试 queryFlow / "4" 部分失败：异步中态，不落库（jifei
	//     后续回调 trade.createResource，handler 独立完成发货 + 写 trade_flow）
	//   - "3" 发货失败：永久失败，不落库
	//
	// 协议层成功响应字段（dealName + bigOrderId）仍按原契约返给调用方，
	// 让上游（控制台 / e2e 测试）能拿到订单号做后续操作（生成支付页 URL 等）。
	if shouldPersistOrderAfterPay(dealsResp, dealName) {
		passID := dealsResp.ResourceIDs[dealName][0]
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
			// v1.7.x A6.1：流水留痕 region_id 跟随出向 envelope.resInfo 同源
			RegionID:     s.region.RegionID,
			PayMode:      req.PayMode,
			GoodsDetail:  goodsDetail,
			Status:       "provisioned", // BUG-22/23：直接落完成态（state=0 + resourceId 已知）
			ResourceType: "pass",
			ResourceID:   passID, // BUG-22/23：jifei 同步返的 pass_id，一次到位回填
		}
		if err := s.deps.OrderWriter.CreateOrder(ctx, in); err != nil {
			if errors.Is(err, store.ErrTradeOrderDuplicate) {
				return nil, fmt.Errorf("%w: dealName=%s", ErrDealNameDuplicate, dealName)
			}
			// 已支付但写库失败：理论极少发生，运维介入。透传 raw error。
			return nil, fmt.Errorf("placeorder: persist trade_order (paid bigDealID=%s dealName=%s passID=%s): %w",
				bigDealID, dealName, passID, err)
		}
	}
	// state != "0" 或 resourceIds 为空：异步中态 / 失败态，不落 trade_order；
	// 仍按协议返 dealName + bigOrderId 给调用方，业务发货状态由 jifei 异步链路（→ trade
	// /trade/jifei/callback createResource handler）独立推进 + ctl pass 落地为真源。

	return &PlaceOrderResult{
		DealName:   dealName,
		BigOrderID: bigDealID,
	}, nil
}

// shouldPersistOrderAfterPay 判定 generateDealsAndPay 同步响应是否满足"一次到位落
// 完成态 trade_order"条件（v1.7.28 BUG-22/23 用户拍板）。
//
// 满足以下两条同时成立才落库：
//
//  1. dealDeliverResults[dealName].state == "0"（发货成功，PDF §5.1 状态码定义）
//  2. resourceIds[dealName] 非空（jifei 同步返了 pass_id，可一次性回填 resource_id）
//
// 任一不满足都视为"异步发货中 / 发货失败"，不落 trade_order；上游协议响应仍照常
// 返 dealName + bigOrderId（jifei 协议契约不变）。
func shouldPersistOrderAfterPay(resp *jifeiclient.GenerateDealsAndPayResponse, dealName string) bool {
	if resp == nil {
		return false
	}
	deliver, ok := resp.DealDeliverResults[dealName]
	if !ok {
		return false
	}
	state, _ := deliver["state"].(string)
	if state != "0" {
		return false
	}
	resourceIDs := resp.ResourceIDs[dealName]
	if len(resourceIDs) == 0 || resourceIDs[0] == "" {
		return false
	}
	return true
}

// PlaceRenewOrderAndPay 执行 jifei "续费下单并支付"一体化流程（R-D-7 / 测试用）。
//
// 设计稿引用：.tmp/trade-pass-renew-design.md §3.3 / §4.4 / R-D-7
//
// 与 PlaceRenewOrder 的差异（与 PlaceOrderAndPay vs PlaceOrder 同范式）：
//   - PlaceRenewOrder       → jifei `qcloud.Deal.generateDeals` 仅创建续费订单，落库
//     status='pending_pay'，调用方再走 GeneratePayURL 拉支付 URL 引导用户付款
//   - PlaceRenewOrderAndPay → jifei `qcloud.Deal.generateDealsAndPay` 一体化接口，
//     **一次调用** 完成"创建续费订单 + 同步支付 + 触发 checkRenew/renewResource 回调"，
//     跳过支付 URL；**条件落库**（v1.7.28 BUG-26 修订 2026-05-21，与 PlaceOrderAndPay
//     BUG-23 同范式）：仅在 jifei 同步发货成功（state="0" + resourceIds 非空）时
//     INSERT trade_order(status='provisioned')，异步中态 / 失败态不落库
//
// 与 PlaceOrderAndPay 的关键差异（与 PlaceRenewOrder vs PlaceOrder 同 3 处差异点）：
//   - GoodsCategoryID 取 def.CategoryIDForScene("renew") （新购走 "purchase"）
//   - goodsDetail 注入 resourceId = req.ResourceID（新购无此字段）
//   - trade_order INSERT 时 OrderType=OrderTypeRenew + ResourceID=req.ResourceID
//     （续费入参就有 pass_id；新购走反向回填 ResourceID 语义不同 — 但 BUG-22/23 后
//     新购也不再反向回填，state=0 时 jifei 同步返 resourceIds[0] 直接落 ResourceID）
//
// 使用场景：
//   - **联调测试 / 自动化 e2e**：在测试代金券充足的环境里用 autoVoucher=1 自动扣完，
//     让 trade ↔ jifei ↔ ctl.renewResource 整条续费链路无需真人浏览器付款即可端到端跑通
//   - 生产环境续费走 PlaceRenewOrder + GeneratePayURL 两步式（与新购同范式）
//
// 错误语义：与 PlaceRenewOrder 一致；带 "(renew)" 标记便于排障日志。
func (s *Service) PlaceRenewOrderAndPay(ctx context.Context, req PlaceRenewOrderRequest) (*PlaceOrderResult, error) {
	if err := s.validatePlaceRenewOrderRequest(&req); err != nil {
		return nil, err
	}

	// 1.5 shadow 反查（与 PlaceRenewOrder 一致）
	if strings.TrimSpace(req.Uin) == "" && s.deps.ShadowClient != nil {
		if strings.TrimSpace(req.ExternalUserID) == "" {
			return nil, fmt.Errorf("%w: external_user_id is required when uin is missing", ErrInvalidInput)
		}
		binding, err := s.deps.ShadowClient.GetBindingByExternalUserID(ctx, req.ExternalUserID)
		if err != nil {
			if errors.Is(err, shadowclient.ErrBindingNotFound) {
				return nil, fmt.Errorf("%w: externalUserId=%s", ErrBindingNotFound, req.ExternalUserID)
			}
			return nil, fmt.Errorf("placeorder: shadow GetBindingByExternalUserID (renew-and-pay): %w", err)
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
		return nil, fmt.Errorf("placeorder: ctl GetBundleByID (renew-and-pay): %w", err)
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
		return nil, fmt.Errorf("placeorder: get bundle definition (renew-and-pay): %w", err)
	}

	// scene="renew" 取 categoryId（与 PlaceRenewOrder 对偶；未命中报错）
	categoryID := def.CategoryIDForScene("renew")
	if categoryID == 0 {
		return nil, fmt.Errorf("placeorder: bundle definition missing category_ids[scene=renew]: bundleId=%s",
			req.BundleID)
	}

	// 4. AppID 类型转换（与 PlaceOrderAndPay 一致；jifei 协议 appId 是 int64）
	appIDInt, err := parseAppIDForJifei(req.AppID)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid appId=%q: %v", ErrInvalidInput, req.AppID, err)
	}

	// 5. 拼装 jifei generateDealsAndPay 入参
	//    与 PlaceOrderAndPay 关键差异：goodsDetail 注入 resourceId（续费目标 pass_id）
	goodsDetail := buildGoodsDetail(def, PlaceOrderRequest{
		Period:   req.Period,
		TimeUnit: req.TimeUnit,
		GoodsNum: req.GoodsNum,
	})
	goodsDetail["resourceId"] = req.ResourceID
	// v1.7.20 B15: 同 PlaceRenewOrder 注入 curDeadline (PDF §4.3 续费必填; 一体化 + 两步式
	// 共用同一份 goodsDetail 字段集)
	goodsDetail["curDeadline"] = req.CurDeadline

	autoVoucher := 1 // 测试链路下默认自动扣代金券（与 PlaceOrderAndPay 一致）
	dealsReq := &jifeiclient.GenerateDealsAndPayRequest{
		OwnerUin:    req.Uin,
		Uin:         req.Uin,
		AppID:       appIDInt,
		AutoVoucher: &autoVoucher,
		Goods: []jifeiclient.GoodsInfo{
			{
				GoodsCategoryID: categoryID,
				// v1.7.x A6.1：region/zone 同前三个出向路径，按 deps.SiteKind 决定
				RegionID:    s.region.RegionID,
				ZoneID:      s.region.ZoneID,
				GoodsNum:    req.GoodsNum,
				PayMode:     req.PayMode,
				GoodsDetail: goodsDetail,
			},
		},
	}
	dealsResp, err := s.deps.JifeiClient.GenerateDealsAndPay(ctx, dealsReq)
	if err != nil {
		return nil, fmt.Errorf("placeorder: jifei GenerateDealsAndPay (renew): %w", err)
	}
	if dealsResp == nil || len(dealsResp.BigDealIDs) == 0 || dealsResp.BigDealIDs[0] == "" ||
		len(dealsResp.DealNames) == 0 || dealsResp.DealNames[0] == "" {
		return nil, fmt.Errorf("%w (renew): BigDealIDs=%v DealNames=%v",
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

	// 6. v1.7.28 BUG-25 / BUG-26 修订（2026-05-21 用户拍板，与新购 BUG-22 / BUG-23 同模式）：
	//    PlaceRenewOrderAndPay 只在 jifei 同步发货成功（dealDeliverResults.state="0"）时
	//    INSERT 完成态 trade_order，发货失败 / 异步中等态一律不落库。
	//
	// 设计动机（与新购 BUG-23 同范式）：
	//   - trade_order 退化为 "订单流水记录" 职责，只承载已成功完成的订单信息；
	//     中间态 / 失败态没有落库价值（jifei 这一侧已有完整生命周期记录）。
	//   - 发货流程不依赖 trade_order（BUG-25 已让 renewResource handler 完全脱离 trade_order
	//     反查依赖，与新购 BUG-22 同范式）。
	//
	// jifei state 码（PDF §5.1 + 实测）：
	//   - "0" 发货成功：resourceIds[dealName] 非空 → INSERT trade_order(provisioned)
	//   - "1" 发货中 / "2" 重试 queryFlow / "4" 部分失败：异步中态，不落库（jifei 后续
	//     回调 trade.renewResource，handler 独立完成续费 + 写 trade_flow）
	//   - "3" 发货失败：永久失败，不落库
	//
	// 协议层成功响应字段（dealName + bigOrderId）仍按原契约返给调用方，
	// 让上游（控制台 / e2e 测试）能拿到订单号做后续操作（生成支付页 URL 等）。
	//
	// **与新购 PlaceOrderAndPay 的差异点**（与调用 PlaceRenewOrder 与 PlaceOrder 的 3 点差异同范式）：
	//   - OrderType=OrderTypeRenew（续费独有）
	//   - ResourceID=req.ResourceID（续费入参就有 pass_id，不需从 jifei 同步返取；
	//     jifei 返的 resourceIds[dealName][0] 是透传回的 req.ResourceID，二者该一致）
	if shouldPersistOrderAfterPay(dealsResp, dealName) {
		in := store.CreateOrderInput{
			BigOrderID:     bigDealID,
			DealName:       dealName,
			ExternalUserID: req.ExternalUserID,
			Uin:            req.Uin,
			AppID:          req.AppID,
			SubProductCode: def.SubProductCode,
			BundleID:       req.BundleID,
			OrderType:      store.OrderTypeRenew,
			Period:         req.Period,
			TimeUnit:       req.TimeUnit,
			GoodsNum:       req.GoodsNum,
			// v1.7.x A6.1：流水留痕 region_id 跟随出向 envelope.resInfo 同源
			RegionID:     s.region.RegionID,
			PayMode:      req.PayMode,
			GoodsDetail:  goodsDetail,
			Status:       "provisioned", // BUG-26：直接落完成态（state=0 + resourceId 已知）
			ResourceType: "pass",
			ResourceID:   req.ResourceID, // 续费以入参 pass_id 为准（与 jifei 返一致）
		}
		if err := s.deps.OrderWriter.CreateOrder(ctx, in); err != nil {
			if errors.Is(err, store.ErrTradeOrderDuplicate) {
				return nil, fmt.Errorf("%w (renew): dealName=%s", ErrDealNameDuplicate, dealName)
			}
			// 已支付但写库失败：理论极少发生，运维介入。透传 raw error。
			return nil, fmt.Errorf("placeorder: persist trade_order (renew-and-pay paid bigDealID=%s dealName=%s passID=%s): %w",
				bigDealID, dealName, req.ResourceID, err)
		}
	}
	// state != "0" 或 resourceIds 为空：异步中态 / 失败态，不落 trade_order；
	// 仍按协议返 dealName + bigOrderId 给调用方，业务发货状态由 jifei 异步链路（→ trade
	// /trade/jifei/callback renewResource handler）独立推进 + ctl pass 落地为真源。

	return &PlaceOrderResult{
		DealName:   dealName,
		BigOrderID: bigDealID,
	}, nil
}

// GeneratePayURL 生成 / 反查支付页 url（设计稿 §4.2.2 接口）。
//
// **本期实现策略**（迭代 8B-1.6，jifei `qcloud.margin.getMidasEarmarking` 真实接入）：
//
//  1. 反查 trade_order 取 (uin, pay_url)
//  2. 命中 pay_url 缓存 → 直接返回（Q-PAY-2 拍板：同一 dealName 复用首次拿到的 URL）
//  3. 未命中 → 调 jifei `qcloud.margin.getMidasEarmarking`（PDF 协议）→ 写回 trade_order.pay_url
//     缓存 → 返回 jifei 真实 URL
//
// 错误语义：
//   - dealName 在 trade_order 不存在 → wrap store.ErrTradeOrderNotFound（上层 handler 映射 4xx）
//   - jifei 业务错（returnCode != 0）→ 透传 *jifeiclient.CGWError（Q-PAY-5 拍板：统一 5xx 透传，
//     由调用方按错误码自行降级；本函数不做 jifei 错误码级别的语义分类）
//   - jifei HTTP 失败 / 4s 超时 → 透传 ErrCGWHTTPNon200 / 包装 raw err
//   - 写回 trade_order.pay_url 失败 → 仍返 jifei URL（已成功拿到 URL，落库失败属于运维异常，
//     不能让用户付不了款）；落库错走 ELK 日志兜底（Q-PAY-1 b 协同）
//
// 不改 trade_order.status（Q-PAY-3 拍板）：getMidasEarmarking 在 status 状态机外侧；
// status 仍由 PlaceOrder 入口写 'pending_pay'，由 createResource 收尾推进到 'provisioned'。
//
// needCharge=0（PDF §5：余额已扣完不需要再付款）也直接返 URL（前端 Midas SDK 会识别此 URL 后
// 立即返成功），不在本函数特化处理（Q-PAY-3 协同）。
//
// ErrPayURLUnavailable 哨兵保留（外部 errors.Is 兼容），但本函数已不再返出。
// PayURLDetail 是 GeneratePayURL 的扩展返回值（v1.7.30 R-D-2 后扩展，2026-05-23）。
//
// 字段语义：
//   - PayURL：jifei 返回的 Midas 收银台 URL（必非空；前端跳转用）
//   - TokenID：米大师支付 token，前端跳 Midas SDK 用；jifei 协议外字段，可能 nil（D3 兜底）
//   - OrderID：米大师订单号（= jifei outTradeNo / billId，与 trade dealName 不同源）；
//     jifei 协议外字段，可能 nil（D3 兜底）
//   - NeedCharge：1 = 需跳 Midas / 0 = 已扣完无需支付
//   - Uin：来自 trade_order.uin（用户腾讯云 uin）
//   - AppID：来自 trade_order.app_id（用户腾讯云 appId，与米大师商户 appid 不同）
//   - MidasAppID：米大师商户 appid（来自 jifei 顶层 appid 字段，前端跳 SDK 时透传给米大师）；
//     可能 nil（D3 兜底，且命中本地缓存且 url path 不可解析时也为 nil）
//
// **缓存命中时的字段填充策略**（v1.7.30 拍板 2026-05-23）：
//
// trade_order.pay_url 缓存命中 → 不再调 jifei，从 URL path/query 反解析协议外字段
// （path 第 3 段 = midas appid；query token_id / out_trade_no = TokenID / OrderID），
// 解析失败仅日志告警，对应字段返 nil 走 D3 兜底契约（前端拿到 null 自行处理）。
//
// 真实 URL 形态（2026-05-23 北京 trade 联调验证）：
//
//	/v1/r/{midas_appid}/qz_goods_info?transaction_id=...&token_id=...&out_trade_no=...&deploy_env=stable
type PayURLDetail struct {
	PayURL     string
	TokenID    *string
	OrderID    *string
	NeedCharge int
	Uin        string
	AppID      string
	MidasAppID *string
}

// GeneratePayURLOptions 拉取支付 URL 时的可选参数（v1.7.31 接口拆分新增）。
// 全部字段可选；空值时不透传（兼容现有行为）。
type GeneratePayURLOptions struct {
	Platform  string `json:"platform,omitempty"`
	WxOpenID  string `json:"wx_open_id,omitempty"`
	WxAppID   string `json:"wx_app_id,omitempty"`
	CancelURL string `json:"cancel_url,omitempty"`
	ReturnURL string `json:"return_url,omitempty"`
}

func (s *Service) GeneratePayURL(ctx context.Context, dealName string, opts *GeneratePayURLOptions) (*PayURLDetail, error) {
	dealName = strings.TrimSpace(dealName)
	if dealName == "" {
		return nil, fmt.Errorf("%w: deal_name is required", ErrInvalidInput)
	}

	order, err := s.deps.OrderStore.GetOrderByDealName(ctx, dealName)
	if err != nil {
		if errors.Is(err, store.ErrTradeOrderNotFound) {
			return nil, fmt.Errorf("placeorder: trade_order not found: dealName=%s: %w",
				dealName, err)
		}
		return nil, fmt.Errorf("placeorder: get trade_order dealName=%s: %w", dealName, err)
	}
	// 命中缓存：同一 dealName 复用首次拿到的 URL（Q-PAY-2）；从 URL 反解析协议外字段。
	if order.PayURL != "" {
		tokenID, orderID, midasAppID := parsePayURLAuxFields(order.PayURL)
		return &PayURLDetail{
			PayURL:     order.PayURL,
			TokenID:    tokenID,
			OrderID:    orderID,
			NeedCharge: 1, // 缓存场景不知 jifei 当前 needCharge 状态，按"需要支付"返默认值
			Uin:        order.Uin,
			AppID:      order.AppID,
			MidasAppID: midasAppID,
		}, nil
	}

	// 未命中 → 调 jifei `qcloud.margin.getMidasEarmarking`
	if order.Uin == "" {
		// 防御性：trade_order 应当在 PlaceOrder 入口落库时写入 uin，理论不会触发
		return nil, fmt.Errorf("placeorder: trade_order.uin missing for dealName=%s (data inconsistency)",
			dealName)
	}
	midasReq := &jifeiclient.GetMidasEarmarkingRequest{
		OwnerUin:  order.Uin,
		Uin:       order.Uin,
		DealNames: []string{dealName},
		Platform:  optsPlatform(opts),
		WxOpenID:  optsWxOpenID(opts),
		WxAppID:   optsWxAppID(opts),
		CancelURL: optsCancelURL(opts),
		ReturnURL: optsReturnURL(opts),
	}
	if isIntlSite(s.deps.SiteKind) {
		midasReq.PayScene = "credit_card"
		if orderHasAutoRenewFlag(order.GoodsDetail) {
			midasReq.ContractOrder = 1
		}
	}
	resp, err := s.deps.JifeiClient.GetMidasEarmarking(ctx, midasReq)
	if err != nil {
		// Q-PAY-5：透传给上层（含 *CGWError / ErrCGWHTTPNon200 等），由 handler 映射 5xx
		return nil, fmt.Errorf("placeorder: jifei GetMidasEarmarking dealName=%s: %w", dealName, err)
	}
	if resp == nil {
		return nil, fmt.Errorf("placeorder: jifei GetMidasEarmarking returned nil response for dealName=%s",
			dealName)
	}
	// jifei qcloud.margin.getMidasEarmarking 协议：data.needCharge=0 表示订单
	// 已支付 / 无需再付（合法终态），此时 jifei 合规返空 url。需透传 NeedCharge=0
	// 给上层（ctl）按"已支付"分支处理，与 RenewPassOrderUrl 续费链路对齐。
	// 仅当 needCharge=1（需跳支付）但 url 仍为空时才视为协议异常。
	if resp.URL == "" && resp.NeedCharge != 0 {
		return nil, fmt.Errorf("placeorder: jifei GetMidasEarmarking returned empty url for dealName=%s (needCharge=%d)",
			dealName, resp.NeedCharge)
	}

	// 写回 trade_order.pay_url 缓存（最佳努力 — 失败不阻塞返 URL）
	// needCharge=0 时 resp.URL 为空，跳过缓存写回（避免空串污染缓存命中分支）
	if resp.URL != "" {
		if writeErr := s.deps.OrderWriter.UpdatePayURL(ctx, dealName, resp.URL); writeErr != nil {
			// 落库失败走 ELK 日志兜底（Q-PAY-1 b）；不阻塞用户支付。
			// 这里用 fmt.Println 仅作为 placeholder — 实际会被框架级 logger（zap / slog）替换；
			// 但保留这条日志输出避免静默丢失。
			fmt.Printf("WARN placeorder: cache pay_url failed dealName=%s url=%s err=%v\n",
				dealName, resp.URL, writeErr)
		}
	}

	// 米大师商户 appid（jifei 顶层 appid）：协议必返非空；为对齐 D3 兜底契约，仍按指针包装，
	// jifei 真返空串时透传 nil（保持"协议未返 → null"语义）。
	var midasAppID *string
	if resp.AppID != "" {
		v := resp.AppID
		midasAppID = &v
	}
	return &PayURLDetail{
		PayURL:     resp.URL,
		TokenID:    resp.TokenID,
		OrderID:    resp.OutTradeNo,
		NeedCharge: resp.NeedCharge,
		Uin:        order.Uin,
		AppID:      order.AppID,
		MidasAppID: midasAppID,
	}, nil
}

// parsePayURLAuxFields 从 trade_order.pay_url 缓存值反解析协议外字段，仅供
// GeneratePayURL 命中缓存路径使用（避免重复调 jifei）。
//
// 真实 URL 形态（2026-05-23 北京 trade 联调实测）：
//
//	/v1/r/{midas_appid}/qz_goods_info?transaction_id=...&token_id=...&out_trade_no=...&deploy_env=stable
//
// 解析策略（D3 兜底）：任一项解析失败均返 nil，由上层 JSON null 透传给前端。**禁止用空串
// 占位**，避免与 jifei 真实返空串歧义。
//
// path 段分隔不依赖固定下标，而是定位 `/v1/r/` 紧随的第一段 — 这样即使 jifei 修改 path
// 形态（增减前缀）也最大程度兼容。
func parsePayURLAuxFields(payURL string) (tokenID, orderID, midasAppID *string) {
	u, err := neturl.Parse(payURL)
	if err != nil {
		return nil, nil, nil
	}

	q := u.Query()
	if v := q.Get("token_id"); v != "" {
		tokenID = &v
	}
	if v := q.Get("out_trade_no"); v != "" {
		orderID = &v
	}

	// midas appid 位于 path `/v1/r/{midas_appid}/...`；定位 "/r/" 后第一段
	const marker = "/r/"
	if idx := strings.Index(u.Path, marker); idx >= 0 {
		rest := u.Path[idx+len(marker):]
		if slash := strings.Index(rest, "/"); slash > 0 {
			seg := rest[:slash]
			if seg != "" {
				midasAppID = &seg
			}
		} else if rest != "" {
			midasAppID = &rest
		}
	}
	return tokenID, orderID, midasAppID
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
	_, autoRenewFlagSet, err := jifeiAutoRenewFlagValue(req.AutoRenewFlag)
	if err != nil {
		return err
	}
	if autoRenewFlagSet && !isIntlSite(s.deps.SiteKind) {
		return fmt.Errorf("%w: auto_renew_flag is only supported for intl site", ErrInvalidInput)
	}
	return nil
}

// buildGoodsDetail 把 BundleDefinition + 用户入参展平成 jifei goodsDetail map。
//
// 字段集与 inquiry.buildGoodsDetail 共享语义（设计稿 §3.5.5 (4) / §4.3 Step T3）：
//   - productCode / subProductCode / pid（来自 BundleDefinition；pid 是 int64，Q71 拍板 2026-05-13）
//   - timeSpan / timeUnit / goodsNum（来自 PlaceOrderRequest）
//   - sv_*（来自 BundleDefinition.SVList，key **直接透传**为 goodsDetail key；值是 int64，
//     直接透传为 number 进入 jifei wire — Q71 推翻 Q66：sv_* 协议层是 int，
//     PDF §4.4 line 30/38 / §4.4.1.1.2 line 23）
//   - productInfo（直接透传）
//
// 5 处共享同一套构造逻辑：inquiry / placeorder.PlaceOrder / placeorder.PlaceOrderAndPay /
// resourcequery/mapper.buildResourceGoodsDetail / jifei/adapter.buildGoodsDetail。
func buildGoodsDetail(def *store.BundleDefinition, req PlaceOrderRequest) map[string]interface{} {
	out := map[string]interface{}{
		"productCode":    def.ProductCode,
		"subProductCode": def.SubProductCode,
		"pid":            def.Pid,
		"timeSpan":       req.Period,
		"timeUnit":       req.TimeUnit,
		"goodsNum":       req.GoodsNum,
	}
	// v1.7.28 BUG-07：把 trade 自家业务字段 bundleId 透传到 jifei goodsDetail（仅新购链路）。
	//
	// PDF §2.2 明示 "goodsDetail 中字段都是透传"，jifei 会原样回传到所有回调。trade 利用此特性
	// 把 bundleId 塞进来，让 checkCreate / createResource 入向回调能从 goodsDetail.bundleId
	// 反查 trade_bundle_definition 做对账（jifei 协议层不会发 dealName 给 checkCreate，
	// 原 §5.2 设计稿"靠 dealName 反查 trade_order"路径不可行）。
	//
	// **续费链路不塞 bundleId**：续费的 jifei 回调 (checkRenew / renewResource) 协议层会
	// 发 resourceId（pass_id），trade 通过 resourceId 反查 ctl/pass 拿 bundle 信息，
	// 不需要 goodsDetail 里再透传 bundleId。续费路径 buildGoodsDetail 调用方传 req.BundleID = ""，
	// 这里通过非空判断跳过 bundleId 注入，保持续费 goodsDetail 干净。
	if req.BundleID != "" {
		out["bundleId"] = req.BundleID
	}
	// v1.7.28 BUG-22：把 trade 自家业务字段 externalUserId 透传到 jifei goodsDetail（仅新购链路）。
	//
	// 设计动机：jifei 协议层 createResource 回调 para 顶层只有 (uin, appId)，没有 lightclaw
	// externalUserId（lightclaw 业务用户 ID，与 ctl.pass.user_id 一致）。原设计是 trade 通过
	// dealName 反查 trade_order 拿 externalUserId 调 ctl.completePass，但这导致：
	//   - jifei 同步推 createResource 早于 trade INSERT trade_order（PlaceOrderAndPay 时序问题）
	//   - 抢占式幂等 trade_flow.in_progress 卡死（赢家路径反查 trade_order 返 ErrNotFound 即返
	//     600202，但 trade_flow 已抢占成功，后续 retry 永远 600203 死锁）
	//
	// 修复：把 externalUserId 当做 trade 自家业务字段塞进 goodsDetail（与 bundleId 同范式）；
	// jifei 原样回传到 createResource，trade 直接从 jifei 入参拿 externalUserId 调 ctl，
	// 不再依赖 trade_order 反查。这样 createResource handler 与 trade_order 完全解耦，
	// trade_order 只承担"订单流水记录"职责，不在发货关键路径上。
	//
	// **续费链路不塞 externalUserId**：续费回调（renewResource）通过 resourceId 反查
	// ctl/pass 已经能拿到 user_id；保持续费 goodsDetail 干净。
	if req.ExternalUserID != "" {
		out["externalUserId"] = req.ExternalUserID
	}
	if v, ok, _ := jifeiAutoRenewFlagValue(req.AutoRenewFlag); ok {
		out["autoRenewFlag"] = v
	}
	// 2026-05-13 起契约变更：运营录入 key 必须已带 sv_ 前缀，trade 不再自动补前缀。
	for k, v := range def.SVList {
		out[k] = v
	}
	if len(def.ProductInfo) > 0 {
		out["productInfo"] = def.ProductInfo
	}
	return out
}

func buildMoveInGoodsDetail(def *store.BundleDefinition, req MoveInOrderRequest) map[string]interface{} {
	out := map[string]interface{}{
		"productCode":    def.ProductCode,
		"subProductCode": def.SubProductCode,
		"pid":            def.Pid,
		"timeSpan":       1,
		"timeUnit":       "m",
		"goodsNum":       1,
		"resourceId":     strings.TrimSpace(req.ResourceID),
		"bundleId":       strings.TrimSpace(req.BundleID),
		"externalUserId": strings.TrimSpace(req.ExternalUserID),
		"curDeadline":    strings.TrimSpace(req.CurDeadline),
		"billingParam": map[string]interface{}{
			"resourcesSource": "lightvela",
		},
	}
	for k, v := range def.SVList {
		out[k] = v
	}
	if len(def.ProductInfo) > 0 {
		out["productInfo"] = def.ProductInfo
	}
	return out
}

func validateMoveInOrderRequest(req *MoveInOrderRequest) error {
	if req == nil {
		return fmt.Errorf("%w: nil request", ErrInvalidInput)
	}
	if strings.TrimSpace(req.ExternalUserID) == "" {
		return fmt.Errorf("%w: external_user_id is required", ErrInvalidInput)
	}
	if strings.TrimSpace(req.Uin) == "" {
		return fmt.Errorf("%w: uin is required", ErrInvalidInput)
	}
	if strings.TrimSpace(req.AppID) == "" {
		return fmt.Errorf("%w: app_id is required", ErrInvalidInput)
	}
	if strings.TrimSpace(req.BundleID) == "" {
		return fmt.Errorf("%w: bundle_id is required", ErrInvalidInput)
	}
	if strings.TrimSpace(req.ResourceID) == "" {
		return fmt.Errorf("%w: resource_id is required", ErrInvalidInput)
	}
	if strings.TrimSpace(req.CurDeadline) == "" {
		return fmt.Errorf("%w: cur_deadline is required", ErrInvalidInput)
	}
	if _, err := jifei.ParseCurDeadline(strings.TrimSpace(req.CurDeadline)); err != nil {
		return fmt.Errorf("%w: cur_deadline must match %s in CST: %v", ErrInvalidInput, jifei.CurDeadlineLayout, err)
	}
	return nil
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

// resolveCurDeadlineForRenew 反查 ctl pass.expired_time，作为 jifei 续费协议
// goodsDetail.curDeadline 的真源（PDF §4.3 必填字段）。
//
// **设计要点**：
//   - 真源严格落在 ctl `pass.expired_time` 列（DB 唯一权威）— 不接受调用方透传，
//     避免前端自行计算的 deadline 与 ctl 实际状态漂移导致 jifei 询价基线错误。
//   - 反查路径复用既有 `ListPassesByResourceIDs(appID, [pass_id])` 接口（资源反查链路 11A 已落），
//     不新增 ctl handler。
//   - appID 必须 > 0（PlaceRenewOrder/PlaceRenewOrderAndPay 在调本 helper 前已 shadow 反查 +
//     parseAppIDForJifei 转 int64 完成；这里再做一次防御）。
//
// 错误语义：
//   - appID <= 0 / passID 空：返 ErrInvalidInput（理论由上游校验拦截，防御性兜底）
//   - ctl 反查 raw 错（网络 / 5xx）：透传 wrapped error
//   - 反查长度 != 1：返 ErrPassNotFoundForRenew（pass 不存在 / 已销毁 / 不在 user 名下）
//   - pass.ExpiredTime 为零值：返 ErrPassNotFoundForRenew（DB 数据异常）
func (s *Service) resolveCurDeadlineForRenew(
	ctx context.Context,
	appID int64,
	passID string,
) (string, error) {
	if appID <= 0 {
		return "", fmt.Errorf("%w: appId must be > 0 for renew curDeadline lookup, got %d",
			ErrInvalidInput, appID)
	}
	if strings.TrimSpace(passID) == "" {
		return "", fmt.Errorf("%w: pass_id is required for renew curDeadline lookup", ErrInvalidInput)
	}
	passes, err := s.deps.CTLClient.ListPassesByResourceIDs(ctx, appID, []string{passID})
	if err != nil {
		return "", fmt.Errorf("placeorder: ctl ListPassesByResourceIDs (renew curDeadline lookup): %w", err)
	}
	if len(passes) != 1 || passes[0] == nil {
		return "", fmt.Errorf("%w: appId=%d passId=%s ctl returned %d entries",
			ErrPassNotFoundForRenew, appID, passID, len(passes))
	}
	pass := passes[0]
	if pass.ExpiredTime.IsZero() {
		return "", fmt.Errorf("%w: appId=%d passId=%s expired_time is zero (DB data anomaly)",
			ErrPassNotFoundForRenew, appID, passID)
	}
	return formatJifeiDeadline(pass.ExpiredTime), nil
}

// optsPlatform / optsWxOpenID / optsWxAppID 从 GeneratePayURLOptions 安全提取字段（nil 安全）。
func optsPlatform(opts *GeneratePayURLOptions) string {
	if opts == nil {
		return ""
	}
	return opts.Platform
}

func optsWxOpenID(opts *GeneratePayURLOptions) string {
	if opts == nil {
		return ""
	}
	return opts.WxOpenID
}

func optsWxAppID(opts *GeneratePayURLOptions) string {
	if opts == nil {
		return ""
	}
	return opts.WxAppID
}

func optsCancelURL(opts *GeneratePayURLOptions) string {
	if opts == nil {
		return ""
	}
	return opts.CancelURL
}

func optsReturnURL(opts *GeneratePayURLOptions) string {
	if opts == nil {
		return ""
	}
	return opts.ReturnURL
}

func isIntlSite(siteKind string) bool {
	return strings.EqualFold(strings.TrimSpace(siteKind), "intl")
}

func jifeiAutoRenewFlagValue(flag string) (int, bool, error) {
	switch strings.ToLower(strings.TrimSpace(flag)) {
	case "":
		return 0, false, nil
	case AutoRenewFlagNotifyAndManual:
		return 0, true, nil
	case AutoRenewFlagAutoRenew:
		return 1, true, nil
	case AutoRenewFlagNoNotifyAndManual:
		return 2, true, nil
	default:
		return 0, false, fmt.Errorf("%w: auto_renew_flag must be %q, %q or %q",
			ErrInvalidInput,
			AutoRenewFlagNotifyAndManual,
			AutoRenewFlagAutoRenew,
			AutoRenewFlagNoNotifyAndManual)
	}
}

func orderHasAutoRenewFlag(goodsDetail map[string]interface{}) bool {
	switch v := goodsDetail["autoRenewFlag"].(type) {
	case bool:
		return v
	case int:
		return v == 1
	case int64:
		return v == 1
	case float64:
		return v == 1
	case string:
		if mapped, ok, err := jifeiAutoRenewFlagValue(v); err == nil && ok {
			return mapped == 1
		}
		return v == "1" || strings.EqualFold(v, "true")
	default:
		return false
	}
}

// placeOrderDianshi 是点石活动下单分支（设计稿 §5.4 / v0.5 修订）。
//
// v0.5 拍板：点石下单底层就是 jifei 下单——点石把活动单透传给 jifei 计费体系，jifei
// 仍按现网形态做反向回调 lightvela.pass.checkCreate / lightvela.pass.createResource
// 到 trade，与普通 jifei 新购**完全同链路**。trade 端没有点石专用的同步发货分支，
// createResourceHandler 仅有 jifei 反向回调一条入口。
//
// 本方法只做 4 件事：
//  1. 计算 check_sum（mapping.SecretKey != "" 时；secret_key 空则不出现 check_sum 字段）
//  2. 拼装 dianshiclient.DoGoodsRequest 调点石 do_goods
//  3. 拿到 deal_names[0] / big_deal_no
//  4. 落 trade_order(status='paid_pending_provision', source='dianshi')
//
// 失败语义：
//   - 点石下单失败 → 直接返业务错给 ctl，不留任何 trade 端落地（与 jifei generateDealsAndPay 失败同款）
//   - DB 写 trade_order 失败 → 5xx 返 ctl
//
// pass 落地 / participation INSERT 全部在 jifei 反向回调驱动的 createResourceHandler 路径里完成
// （commit 6 落地）。
//
// 复用：PlaceOrder 双步链路 与 PlaceOrderAndPay 一体化链路在点石路径上完全合并——点石协议
// 不区分双步 / 一体化，本方法对两者出参签名一致（都返 *PlaceOrderResult）。
func (s *Service) placeOrderDianshi(
	ctx context.Context,
	req PlaceOrderRequest,
	def *store.BundleDefinition,
	mapping *activity.Mapping,
) (*PlaceOrderResult, error) {
	if s.deps.DianshiClient == nil {
		return nil, fmt.Errorf("placeorder: dianshi client not configured (ActivityResolver injected without DianshiClient)")
	}

	reusableStore, ok := s.deps.OrderStore.(store.ReusableDianshiOrderStore)
	if !ok {
		return nil, fmt.Errorf("placeorder: reusable dianshi order store not configured")
	}
	reuseHours := mapping.OrderExpiredTime
	if reuseHours <= 0 {
		log.Printf("[dianshi-order-idempotency] invalid order_expired_time=%f, fallback=1 bundleId=%s activityId=%d",
			reuseHours, req.BundleID, mapping.ActivityID)
		reuseHours = 1
	}
	reuseWindow := time.Duration(reuseHours * float64(time.Hour))
	createdAfter := time.Now().UTC().Add(-reuseWindow)
	order, err := reusableStore.FindReusableDianshiOrder(ctx, req.ExternalUserID, mapping.ActivityID, req.BundleID, createdAfter)
	if err != nil && !errors.Is(err, store.ErrTradeOrderNotFound) {
		return nil, fmt.Errorf("placeorder: find reusable dianshi order bundleId=%s activityId=%d externalUserId=%s: %w",
			req.BundleID, mapping.ActivityID, req.ExternalUserID, err)
	}
	if err == nil && order != nil {
		log.Printf("[dianshi-order-idempotency] hit externalUserId=%s activityId=%d bundleId=%s dealName=%s status=%s createdTime=%s",
			req.ExternalUserID, mapping.ActivityID, req.BundleID, order.DealName, order.Status, order.CreatedTime.Format(time.RFC3339Nano))
		return &PlaceOrderResult{
			DealName:   order.DealName,
			BigOrderID: order.BigOrderID,
			PayURL:     order.PayURL,
		}, nil
	}

	// 1. check_sum：mapping.SecretKey 为空 → 不发字段（dianshiclient.CalcCheckSum 返空字符串触发 omitempty）
	checkSum := dianshiclient.CalcCheckSum(req.Uin, mapping.ActivityID, mapping.SecretKey)

	// 2. 拼 do_goods envelope.para
	//
	// 2026-06-25 用户拍板：点石活动切到正式形态，envelope 不再带 preview 字段
	// （详见 dianshiclient.DoGoodsRequest 注释）。Uin 必须保留：CalcCheckSum 输入 +
	// jifei 计费侧按 uin 区分国内站 / 国际站、把 deal 归属到真实账号。
	doGoodsReq := &dianshiclient.DoGoodsRequest{
		Uin:        req.Uin,
		ActivityID: mapping.ActivityID,
		Originate:  dianshiclient.OriginateLightvelaTrade,
		CheckSum:   checkSum,
		Goods: []dianshiclient.DoGoodsItem{
			{
				ActID: mapping.ActID,
				// preference_param 5 字段。timeSpanUnit 下单使用活动配置（如 "14d"），
				// 与 inquiry.quoteDianshi 的展示周期解耦；externalUserId 是下单专属，让点石把
				// "哪个业务用户下了哪个商品"记到点石侧履约链路里。
				PreferenceParam: map[string]interface{}{
					"regionId":       s.region.RegionID,
					"timeSpanUnit":   mapping.TimeSpanUnit,
					"subProductCode": def.SubProductCode,
					"bundleId":       mapping.BundleID,
					"externalUserId": req.ExternalUserID,
				},
			},
		},
	}

	// 3. 调点石 do_goods（失败直接返业务错，不写任何 trade 端记录）
	doGoodsResp, err := s.deps.DianshiClient.DoGoods(ctx, doGoodsReq)
	if err != nil {
		return nil, fmt.Errorf("placeorder: dianshi DoGoods bundleId=%s activityId=%d actId=%d: %w",
			req.BundleID, mapping.ActivityID, mapping.ActID, err)
	}
	if doGoodsResp == nil || len(doGoodsResp.DealNames) == 0 || doGoodsResp.DealNames[0] == "" {
		return nil, fmt.Errorf("%w: dianshi do_goods returned empty deal_names (bundleId=%s activityId=%d big_deal_no=%q)",
			ErrJifeiResponseInvalid, req.BundleID, mapping.ActivityID,
			func() string {
				if doGoodsResp == nil {
					return ""
				}
				return doGoodsResp.BigDealNo
			}(),
		)
	}

	dealName := doGoodsResp.DealNames[0]
	bigDealNo := doGoodsResp.BigDealNo

	// 4. 落 trade_order（source='dianshi'，status='paid_pending_provision' 与 PlaceOrderAndPay 同款——
	// 点石下单同步链路与 jifei generateDealsAndPay 一体化语义对齐：拿到 deal_name 即视为"已下单已扣款待发货"，
	// 等 jifei 反向回调 createResource 把 status 推进到 'provisioned'）。
	goodsDetail := buildGoodsDetail(def, req)
	// 把活动元信息塞入 goodsDetail，便于 createResource handler 反查 / 排障日志
	goodsDetail["dianshi_activity_id"] = mapping.ActivityID
	goodsDetail["dianshi_act_id"] = mapping.ActID
	goodsDetail["dianshi_big_deal_no"] = bigDealNo

	in := store.CreateOrderInput{
		BigOrderID:     bigDealNo, // 点石 big_deal_no = jifei big_order_id 同位
		DealName:       dealName,
		ExternalUserID: req.ExternalUserID,
		Uin:            req.Uin,
		AppID:          req.AppID,
		SubProductCode: def.SubProductCode,
		BundleID:       req.BundleID,
		Period:         req.Period,
		TimeUnit:       req.TimeUnit,
		GoodsNum:       req.GoodsNum,
		RegionID:       s.region.RegionID,
		PayMode:        req.PayMode,
		GoodsDetail:    goodsDetail,
		Status:         store.OrderStatusPaidPendingProvision,
		ResourceType:   "pass",
		Source:         store.OrderSourceDianshi,
		ActivityID:     mapping.ActivityID,
		ActID:          mapping.ActID,
	}
	if err := s.deps.OrderWriter.CreateOrder(ctx, in); err != nil {
		if errors.Is(err, store.ErrTradeOrderDuplicate) {
			return nil, fmt.Errorf("%w: dealName=%s", ErrDealNameDuplicate, dealName)
		}
		return nil, fmt.Errorf("placeorder: persist trade_order (dianshi) dealName=%s: %w", dealName, err)
	}

	log.Printf("[trade-order] source=dianshi dealName=%s bigDealNo=%s uin=%s appId=%s bundleId=%s activityId=%d actId=%d",
		dealName, bigDealNo, req.Uin, req.AppID, req.BundleID, mapping.ActivityID, mapping.ActID)

	return &PlaceOrderResult{
		DealName:   dealName,
		BigOrderID: bigDealNo,
	}, nil
}
