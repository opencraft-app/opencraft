package checkmodify

import (
	"context"

	"git.woa.com/wisp/mono/trade/internal/bundleresolve"
	jifeiproto "git.woa.com/wisp/mono/trade/internal/jifei"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// 目标 / 源套餐的解析。
//
// 反查算法本身与"为什么不能靠 goodsDetail 自定义字段"的实测依据见
// jifei.ResolveModifyBundlesBySV：该逻辑由 checkModify 与 modifyResource 共用，
// 放在协议层避免两份实现各自漂移（modifyResource 2026-09-02 实测踩了同一个坑）。
//
// store 投影与按 SP 检索由 bundleresolve.ModifyBundles 承担（同样两个 handler 共用）。
// 本文件只做一件本包特有的事：把与码段无关的 ResolveOutcome 映射到 checkModify 的
// 60080x 业务码。

// resolveBundlesBySV 在给定 (productCode, subProductCode) 范围内，按 oldConfig /
// newConfig 的 SV 集合反查源与目标 BundleDefinition。
//
// verdict.code != 0 表示反查失败，调用方直接按该业务码回计费。
func resolveBundlesBySV(
	ctx context.Context,
	bundleStore store.BundleDefinitionStore,
	productCode, subProductCode string,
	oldConfig, newConfig map[string]int64,
) (*store.BundleDefinition, *store.BundleDefinition, configVerdict, error) {
	res, err := bundleresolve.ModifyBundles(ctx, bundleStore, productCode, subProductCode, oldConfig, newConfig)
	if err != nil {
		return nil, nil, configVerdict{}, err
	}
	if !res.OK() {
		return nil, nil, configVerdict{resolveOutcomeToCode(res.Outcome), res.Detail}, nil
	}
	return res.Source, res.Target, configVerdict{}, nil
}

// resolveOutcomeToCode 把协议层的反查结果映射到 checkModify 的业务码。
//
// Ambiguous 归 ConfigMismatch 而不是 BundleNotFound：套餐确实在册，错的是"同 SP 内
// 两个套餐共用同一份 SV 配置"这个接入配置，语义上属配置不符。
func resolveOutcomeToCode(outcome jifeiproto.ResolveOutcome) int {
	switch outcome {
	case jifeiproto.ResolveAmbiguous:
		return ReturnCodeConfigMismatch
	default:
		return ReturnCodeBundleNotFound
	}
}
