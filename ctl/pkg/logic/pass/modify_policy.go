package pass

// Pass 升配的允许关系。需求：TAPD 1010132091137784162 §7.2
//
// 刻意只是一张常量表，不建升级边表、不建图模型：当前合法边数量很少，而
// "能否从 A 到 B" 是业务策略而不是运营数据——放进 DB 只会让线上多一份可以
// 和代码打架的真相。
//
// CTL 不保存 SP/PID/SV；这里仅表达产品允许的有向升级边。计费身份与跨 SP 报文一致性
// 由 trade 对着自己的 BundleDefinition 校验。

const (
	bundleLaunch   = "bundle_launch_01"
	bundleCruise   = "bundle_cruise_01"
	bundleLaunchAI = "bundle_launch_ai_01"
	bundleCruiseAI = "bundle_cruise_ai_01"
)

// allowedModifyTargets 是 source bundle → 允许的 target bundle 列表。
// 值用切片而不是单值，是为了让"一个套餐可升到多档"在不改调用方的前提下自然扩展。
var allowedModifyTargets = map[string][]string{
	bundleLaunch:   {bundleCruise, bundleLaunchAI, bundleCruiseAI},
	bundleCruise:   {bundleCruiseAI},
	bundleLaunchAI: {bundleCruiseAI},
}

// ModifyAllowed 回答"能否从 source 升配到 target"。降配、AI → 通用、Cruise → Launch AI
// 以及 source == target 的空变配都落在 false 分支。
func ModifyAllowed(sourceBundleID, targetBundleID string) bool {
	for _, allowed := range allowedModifyTargets[sourceBundleID] {
		if allowed == targetBundleID {
			return true
		}
	}
	return false
}

// AllowedModifyTargets 返回 source 可升配到的目标套餐，供 trade 拉可变配列表用。
// 返回副本，避免调用方改到策略表。
func AllowedModifyTargets(sourceBundleID string) []string {
	targets := allowedModifyTargets[sourceBundleID]
	if len(targets) == 0 {
		return nil
	}
	return append([]string(nil), targets...)
}
