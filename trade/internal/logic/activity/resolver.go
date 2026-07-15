// Package activity 提供 trade 询价 / 下单分叉点的"活动 bundle 判定 + 用户参与查询"
// 共用 helper（设计稿 .tmp/dianshi-activity-bundle-design.md §5.2）。
//
// inquiry.Service.Quote 与 placeorder.Service.PlaceOrder 在分叉点都需要这 2 步反查：
//  1. trade_bundle_activity 表查 bundle_id 是否为活动 bundle
//  2. trade_user_activity_participation 表查 (uin, activity_id) 是否已参与
//
// 两者决策真值表：
//
//	bundle_activity 无记录（非活动 bundle）            → (nil, false, nil) 走 jifei
//	bundle_activity.active=false                        → (mapping, false, nil) 走 jifei
//	bundle_activity.active=true && participation HIT    → (mapping, false, nil) 走 jifei（已享受）
//	bundle_activity.active=true && participation MISS   → (mapping, true,  nil) 走点石
//
// 询价 / 下单分别调用 ResolveForInquiry / ResolveForPlaceOrder，两者共享同一份反查路径，
// 仅在错误处理上略有差异——询价失败可由上层 Quote 做 graceful-degrade 走 jifei；
// 下单失败必须 5xx（设计稿 §5.3 / §5.4）。
package activity

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"git.woa.com/wisp/mono/trade/internal/store"
)

// Mapping 是 trade_bundle_activity 表的领域对象（与 store.BundleActivity 1:1 映射）。
//
// 单独定义对外类型而非直接复用 store.BundleActivity 的考虑：
//   - 让 logic 层不依赖 store 的具体字段集变迁
//   - 便于 Resolver 的调用方（inquiry / placeorder）拿 Mapping 做日志 / metric 透传
type Mapping struct {
	BundleID   string
	ActivityID int64
	ActID      int64
	SecretKey  string
	Active     bool
	// TimeSpanUnit 是点石 preference_param.timeSpanUnit 字面值（如 "7d"）。
	// 从 store.BundleActivity 透传过来，询价 / 下单两端作为 goods[].preference_param.timeSpanUnit 出向。
	TimeSpanUnit string
	// OrderExpiredTime 是点石下单幂等复用窗口，单位小时，支持 0.5。
	OrderExpiredTime float64
}

// Resolver 决定某一次询价 / 下单是否走点石活动通道。
type Resolver interface {
	// ResolveForInquiry 在询价分叉点调用。
	ResolveForInquiry(ctx context.Context, bundleID, uin string, timeSpan int, timeUnit string) (*Mapping, bool, error)

	// ResolveForPlaceOrder 在下单分叉点调用。
	ResolveForPlaceOrder(ctx context.Context, bundleID, uin string, timeSpan int, timeUnit string) (*Mapping, bool, error)
}

// resolver 是 Resolver 的默认实现。
type resolver struct {
	store store.ActivityStore
}

// NewResolver 构造默认 Resolver。
func NewResolver(s store.ActivityStore) Resolver {
	return &resolver{store: s}
}

// ResolveForInquiry 实现 Resolver 接口。
func (r *resolver) ResolveForInquiry(ctx context.Context, bundleID, uin string, timeSpan int, timeUnit string) (*Mapping, bool, error) {
	return r.resolve(ctx, bundleID, uin, timeSpan, timeUnit)
}

// ResolveForPlaceOrder 实现 Resolver 接口。
//
// 与 ResolveForInquiry 共用同一份反查路径——错误处理差异由调用方（上层 service）决定，
// 不在 Resolver 内分叉。
func (r *resolver) ResolveForPlaceOrder(ctx context.Context, bundleID, uin string, timeSpan int, timeUnit string) (*Mapping, bool, error) {
	return r.resolve(ctx, bundleID, uin, timeSpan, timeUnit)
}

// resolve 是 ResolveForInquiry / ResolveForPlaceOrder 共享的核心反查路径（设计稿 §5.2）。
//
// 步骤：
//  1. 查 trade_bundle_activity（按 bundle_id）
//     - 无记录 → (nil, false, nil)，非活动 bundle 直接走 jifei
//     - DB 错误 → (nil, false, err)
//  2. mapping.Active == false → (mapping, false, nil)，活动已下线，走 jifei
//  3. 本次请求不是 1 个月 → (mapping, false, nil)，走 jifei
//  4. 查 trade_user_activity_participation (uin, activity_id) 是否存在
//     - 已参与 → (mapping, false, nil)，每用户一次约束生效，走 jifei
//     - 未参与 → (mapping, true, nil)，走点石活动通道
//     - DB 错误 → (mapping, false, err)（mapping 非 nil 便于上层日志透传）
func (r *resolver) resolve(ctx context.Context, bundleID, uin string, timeSpan int, timeUnit string) (*Mapping, bool, error) {
	if r == nil || r.store == nil {
		return nil, false, fmt.Errorf("activity resolver: store is nil")
	}
	if bundleID == "" {
		return nil, false, fmt.Errorf("activity resolver: bundleID is required")
	}
	if uin == "" {
		// uin 必须由 shadow 反查回填后传入。Resolver 不做 shadow 兜底——若 uin 为空
		// 直接错误返出，避免误把 uk_uin_activity (uin='') 命中其他用户的参与记录。
		return nil, false, fmt.Errorf("activity resolver: uin is required (must be back-filled by shadow lookup)")
	}

	ba, err := r.store.GetBundleActivityByBundleID(ctx, bundleID)
	if errors.Is(err, store.ErrBundleActivityNotFound) {
		// 非活动 bundle，直接走 jifei
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("activity resolver: get bundle_activity bundleID=%s: %w", bundleID, err)
	}

	mapping := &Mapping{
		BundleID:         ba.BundleID,
		ActivityID:       ba.ActivityID,
		ActID:            ba.ActID,
		SecretKey:        ba.SecretKey,
		Active:           ba.Active,
		TimeSpanUnit:     ba.TimeSpanUnit,
		OrderExpiredTime: ba.OrderExpiredTime,
	}

	if !mapping.Active {
		// 活动已下线，走 jifei；mapping 仍返回便于上层日志带活动元信息
		return mapping, false, nil
	}
	if !isOneMonth(timeSpan, timeUnit) {
		// 点石活动只支持 1 个月购买周期；其他周期按普通计费链路处理。
		return mapping, false, nil
	}

	hit, err := r.store.HasUserParticipated(ctx, uin, mapping.ActivityID)
	if err != nil {
		return mapping, false, fmt.Errorf(
			"activity resolver: query participation uin=%s activityID=%d: %w",
			uin, mapping.ActivityID, err,
		)
	}
	if hit {
		// 已参与过同 activity，回落 jifei 走原价单
		return mapping, false, nil
	}
	// 未参与 + 活动生效 → 走点石
	return mapping, true, nil
}

func isOneMonth(timeSpan int, timeUnit string) bool {
	return timeSpan == 1 && strings.EqualFold(strings.TrimSpace(timeUnit), "m")
}
