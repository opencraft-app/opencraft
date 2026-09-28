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

// ModifyBundles 按 oldConfig/newConfig 各自声明的计费域反查源与目标套餐，并校验
// 跨 SP 变配所需的不变量。outerProductCode/outerSubProductCode 描述当前资源，必须
// 与 oldConfig 的源商品一致；目标商品只由 newConfig 自描述。跨二层下单虽然使用
// 目标 goodsCategoryId，但 2026-09-20 国际 testing 的真实 checkModify 回调证明计费
// 会把 para.productCode/subProductCode 规范化为源资源身份。
//
// 检索域必须由 oldConfig/newConfig 各自给全；缺任一都不能安全反查对应套餐。
//
// 返回的 error 只表示 DB 故障（调用方应按"上游不可用"处理并让计费重试）；
// 业务性的反查失败走 Result.Outcome，不走 error。
func ModifyBundles(
	ctx context.Context,
	bundleStore store.BundleDefinitionStore,
	outerProductCode, outerSubProductCode string,
	goodsDetail map[string]interface{},
) (Result, error) {
	sourceIdentity, err := jifeiproto.GoodsDetailModifyConfigIdentity(goodsDetail, "oldConfig")
	if err != nil {
		return Result{Outcome: jifeiproto.ResolveConfigMismatch, Detail: err.Error()}, nil
	}
	targetIdentity, err := jifeiproto.GoodsDetailModifyConfigIdentity(goodsDetail, "newConfig")
	if err != nil {
		return Result{Outcome: jifeiproto.ResolveConfigMismatch, Detail: err.Error()}, nil
	}
	if sourceIdentity.ProductCode != targetIdentity.ProductCode {
		return Result{Outcome: jifeiproto.ResolveConfigMismatch, Detail: fmt.Sprintf(
			"cross product modify is not supported: source productCode=%q target productCode=%q",
			sourceIdentity.ProductCode, targetIdentity.ProductCode)}, nil
	}
	if outerProductCode != sourceIdentity.ProductCode || outerSubProductCode != sourceIdentity.SubProductCode {
		return Result{Outcome: jifeiproto.ResolveConfigMismatch, Detail: fmt.Sprintf(
			"outer billing identity must match source config: outer=%q/%q source=%q/%q",
			outerProductCode, outerSubProductCode, sourceIdentity.ProductCode, sourceIdentity.SubProductCode)}, nil
	}

	source, outcome, detail, err := resolveBundle(
		ctx, bundleStore, sourceIdentity, jifeiproto.GoodsDetailSVMap(goodsDetail, "oldConfig"), "oldConfig")
	if err != nil {
		return Result{}, err
	}
	if outcome != jifeiproto.ResolveOK {
		return Result{Outcome: outcome, Detail: detail}, nil
	}
	target, outcome, detail, err := resolveBundle(
		ctx, bundleStore, targetIdentity, jifeiproto.GoodsDetailSVMap(goodsDetail, "newConfig"), "newConfig")
	if err != nil {
		return Result{}, err
	}
	if outcome != jifeiproto.ResolveOK {
		return Result{Outcome: outcome, Detail: detail}, nil
	}
	if source.BundleID == target.BundleID {
		return Result{Outcome: jifeiproto.ResolveConfigMismatch,
			Detail: fmt.Sprintf("source and target bundle are identical: %q", source.BundleID)}, nil
	}
	if source.Pid != sourceIdentity.Pid {
		return Result{Outcome: jifeiproto.ResolveConfigMismatch, Detail: fmt.Sprintf(
			"oldConfig pid mismatch: config=%d bundle definition=%d", sourceIdentity.Pid, source.Pid)}, nil
	}
	if target.Pid != targetIdentity.Pid {
		return Result{Outcome: jifeiproto.ResolveConfigMismatch, Detail: fmt.Sprintf(
			"newConfig pid mismatch: config=%d bundle definition=%d", targetIdentity.Pid, target.Pid)}, nil
	}
	return Result{
		Source:  source,
		Target:  target,
		Outcome: jifeiproto.ResolveOK,
	}, nil
}

func resolveBundle(
	ctx context.Context,
	bundleStore store.BundleDefinitionStore,
	identity jifeiproto.ModifyConfigIdentity,
	sv map[string]int64,
	label string,
) (*store.BundleDefinition, jifeiproto.ResolveOutcome, string, error) {
	defs, err := bundleStore.ListBundleDefsBySubProductCode(ctx, identity.ProductCode, identity.SubProductCode)
	if err != nil {
		return nil, jifeiproto.ResolveOK, "", err
	}
	if len(defs) == 0 {
		return nil, jifeiproto.ResolveBundleNotFound, fmt.Sprintf(
			"no bundle definition for %s productCode=%q subProductCode=%q",
			label, identity.ProductCode, identity.SubProductCode), nil
	}
	byID := make(map[string]*store.BundleDefinition, len(defs))
	candidates := make([]jifeiproto.SVBundle, 0, len(defs))
	for _, def := range defs {
		if def == nil {
			continue
		}
		byID[def.BundleID] = def
		candidates = append(candidates, jifeiproto.SVBundle{BundleID: def.BundleID, SVList: def.SVList})
	}
	hit, outcome, detail := jifeiproto.MatchBundleBySV(candidates, sv, label)
	if outcome != jifeiproto.ResolveOK {
		return nil, outcome, detail, nil
	}
	return byID[hit.BundleID], jifeiproto.ResolveOK, "", nil
}
