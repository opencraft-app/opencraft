// Package bundleresolve 把计费变配回调里的 oldConfig / newConfig 反查成
// trade_bundle_definition 行，供 checkModify 与 modifyResource 共用。
//
// 为什么单独一个包：反查这件事横跨两层——协议语义（"SV 集合唯一标识一个套餐"，
// 见 jifei.ResolveModifyBundlesBySV 的实测依据）和持久化模型
// （store.BundleDefinition + 按 SP 检索）。放进 jifei 会让协议层依赖 store，
// 放进 store 会让持久化层依赖协议层，放进任一 handler 包则另一个 handler 得
// 跨包引用别人的私有实现或复制一份。三条路都会制造耦合或漂移，
// 所以让一个只依赖这两者的薄包来承担。
//
// 本包刻意不返回业务错误码：checkModify 与 modifyResource 分属 60080x / 60090x
// 两个码段，且同一种失败在两条链路的语义不同（checkModify 反查失败是"拒绝下单"，
// modifyResource 反查失败是"让计费重试"而非退款）。所以这里只回
// jifei.ResolveOutcome，由各 handler 映射到自己的码。
package bundleresolve

import (
	"context"
	"fmt"

	jifeiproto "git.woa.com/wisp/mono/trade/internal/jifei"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// Result 是一次反查的结果。
//
// Outcome != jifeiproto.ResolveOK 时 Source / Target 为 nil，Detail 是可直接进
// 计费 returnMessage 的可读原因。
type Result struct {
	Source *store.BundleDefinition
	Target *store.BundleDefinition

	Outcome jifeiproto.ResolveOutcome
	Detail  string
}

// OK 是 Outcome == ResolveOK 的语法糖，省掉调用方各自 import 协议层常量。
func (r Result) OK() bool { return r.Outcome == jifeiproto.ResolveOK }

// ModifyBundles 在 (productCode, subProductCode) 检索域内，按 oldConfig / newConfig
// 的 SV 集合反查源与目标套餐。
//
// 检索域必须由调用方给全：缺任一就只能全表反查，会把跨 SP 的套餐纳入候选，
// 违背本期"只做同 SP 变配"的边界。
//
// 返回的 error 只表示 DB 故障（调用方应按"上游不可用"处理并让计费重试）；
// 业务性的反查失败走 Result.Outcome，不走 error。
func ModifyBundles(
	ctx context.Context,
	bundleStore store.BundleDefinitionStore,
	productCode, subProductCode string,
	oldConfig, newConfig map[string]int64,
) (Result, error) {
	defs, err := bundleStore.ListBundleDefsBySubProductCode(ctx, productCode, subProductCode)
	if err != nil {
		return Result{}, err
	}
	if len(defs) == 0 {
		return Result{
			Outcome: jifeiproto.ResolveBundleNotFound,
			Detail: fmt.Sprintf("no bundle definition for productCode=%q subProductCode=%q",
				productCode, subProductCode),
		}, nil
	}

	// byID 把协议层反查回来的 BundleID 还原成完整 BundleDefinition：调用方的后续
	// 对账（PID / SP / categoryId）要用 def 上的其它列，协议层的 SVBundle 只带
	// ID 和 SV 集合。
	byID := make(map[string]*store.BundleDefinition, len(defs))
	candidates := make([]jifeiproto.SVBundle, 0, len(defs))
	for _, def := range defs {
		if def == nil {
			continue
		}
		byID[def.BundleID] = def
		candidates = append(candidates, jifeiproto.SVBundle{BundleID: def.BundleID, SVList: def.SVList})
	}

	source, target, outcome, detail := jifeiproto.ResolveModifyBundlesBySV(candidates, oldConfig, newConfig)
	if outcome != jifeiproto.ResolveOK {
		return Result{Outcome: outcome, Detail: detail}, nil
	}
	return Result{
		Source:  byID[source.BundleID],
		Target:  byID[target.BundleID],
		Outcome: jifeiproto.ResolveOK,
	}, nil
}
