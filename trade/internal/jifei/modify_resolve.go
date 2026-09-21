package jifei

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// 变配回调的源 / 目标套餐解析，checkModify 与 modifyResource 共用。
//
// **为什么不能靠 goodsDetail 里的自定义字段**（2026-09-02 联调实测推翻的原设计）：
// trade 出向下单时在 goodsDetail 塞了 bundleId / newBundleId，原设计假设计费会像
// 新购链路的 externalUserId 那样原样回传。实测不成立——计费回调只回传它协议内认识的
// 字段，实收 goodsDetail 仅含 oldConfig / newConfig / curDeadline / goodsNum，两个
// 自定义键被丢弃。checkModify 因此曾固定返 600801，计费把该业务失败包成
// `returnCode=700002 rc check failed` 回给下单方，变配下单 502；modifyResource 同一
// 通道同一形状，2026-09-02 实测同样返 600901 "goodsDetail.bundleId is required"。
//
// **改用 SV 集合反查**：oldConfig / newConfig 是计费协议的一等公民，必然回传，且内容
// 恰好就是 trade_bundle_definition.sv_list。于是"是哪个套餐"这个问题可以完全由协议内
// 字段回答，不依赖任何透传假设。
//
// 正确性前提是 **SV 集合在同一 SP 内唯一标识一个 bundle**。这个前提本就是计费接入的
// 隐含要求：若两个 bundle 的 sv_list 完全相同，它们在计费侧是同一个价格模型，"从 A
// 升到 B"根本没有差价语义。所以这里不是引入新的脆弱假设，而是把既有约束显式化——并且
// 反查到多个候选时 fail-closed 报错，让配置错误立刻暴露，而不是随机挑一个继续走。
//
// 放在 jifei 包而不是任一 handler 包：两个 handler 属于不同错误码段
// （checkmodify 60080x / modifyresource 60090x），共享的只是"如何把协议字段反解成
// 套餐对"这件与错误码无关的事。解析结果用 ResolveOutcome 这个与码段无关的分类表达，
// 由各 handler 映射到自己的业务码，避免任一 handler 依赖另一个的错误码定义。

// ResolveOutcome 是 SV 反查的与错误码无关的结果分类。
//
// 各 handler 按自己的码段映射：checkModify 映射到 600802 / 600803，
// modifyResource 映射到 600901（B 类，让计费重试而不是立刻退款——反查失败可能是
// 运营刚改了 SV 还没同步接入单，重试期间修好就能正常发货）。
type ResolveOutcome int

const (
	// ResolveOK 源与目标套餐都唯一命中。
	ResolveOK ResolveOutcome = iota

	// ResolveBundleNotFound 该 SP 下无在册套餐，或某个 config 的 SV 集合不匹配任何套餐。
	// 通常是运营改了 SV 却没同步接入单。
	ResolveBundleNotFound

	// ResolveAmbiguous 同 SP 内出现 sv_list 重复的套餐。属配置错误，此时任何选择都是猜。
	ResolveAmbiguous
)

// SVBundle 是 SV 反查所需的套餐视图。
//
// 定义在 jifei 包而不是直接用 store.BundleDefinition：jifei 是协议层，让它依赖
// store 会把"计费协议"和"trade 持久化模型"绑死。调用方做一次轻量投影即可。
type SVBundle struct {
	BundleID string
	SVList   map[string]int64
}

// ResolveModifyBundlesBySV 按 oldConfig / newConfig 的 SV 集合在候选集里反查源与目标套餐。
//
// outcome != ResolveOK 时 detail 是可直接回给计费的可读原因，source / target 为 nil。
func ResolveModifyBundlesBySV(
	candidates []SVBundle,
	oldConfig, newConfig map[string]int64,
) (source, target *SVBundle, outcome ResolveOutcome, detail string) {
	if len(candidates) == 0 {
		return nil, nil, ResolveBundleNotFound, "no bundle definition in scope"
	}
	source, outcome, detail = MatchBundleBySV(candidates, oldConfig, "oldConfig")
	if outcome != ResolveOK {
		return nil, nil, outcome, detail
	}
	target, outcome, detail = MatchBundleBySV(candidates, newConfig, "newConfig")
	if outcome != ResolveOK {
		return nil, nil, outcome, detail
	}
	return source, target, ResolveOK, ""
}

// MatchBundleBySV 在候选集里找 sv_list 与 config 完全相等的唯一一个套餐。
func MatchBundleBySV(
	candidates []SVBundle,
	config map[string]int64,
	label string,
) (*SVBundle, ResolveOutcome, string) {
	var matched []SVBundle
	for _, cand := range candidates {
		if DiffSVList(config, cand.SVList) == "" {
			matched = append(matched, cand)
		}
	}
	switch len(matched) {
	case 1:
		hit := matched[0]
		return &hit, ResolveOK, ""
	case 0:
		return nil, ResolveBundleNotFound, fmt.Sprintf(
			"%s sv list matches no bundle definition: sv=%v", label, SortedSVKeys(config))
	default:
		ids := make([]string, 0, len(matched))
		for _, m := range matched {
			ids = append(ids, m.BundleID)
		}
		sort.Strings(ids)
		return nil, ResolveAmbiguous, fmt.Sprintf(
			"%s sv list matches %d bundle definitions (ambiguous): %v", label, len(matched), ids)
	}
}

// DiffSVList 返回第一处差异的可读描述；完全一致返回空串。
//
// 按排序后的键遍历，保证同一组差异每次输出同样的文本（map 迭代顺序随机会让排障时
// 无法比对，单测也无法稳定断言）。
func DiffSVList(got, want map[string]int64) string {
	if len(got) != len(want) {
		return fmt.Sprintf("sv count mismatch: got %d want %d (got=%v want=%v)",
			len(got), len(want), SortedSVKeys(got), SortedSVKeys(want))
	}
	for _, key := range SortedSVKeys(want) {
		gotVal, ok := got[key]
		if !ok {
			return fmt.Sprintf("missing sv %s", key)
		}
		if gotVal != want[key] {
			return fmt.Sprintf("sv %s value mismatch: got %d want %d", key, gotVal, want[key])
		}
	}
	return ""
}

// GoodsDetailSVMap 把 goodsDetail 的一个子对象（oldConfig / newConfig）取成 sv 集合。
//
// 只收 sv_ 前缀键：oldConfig / newConfig 内层除 sv_* 外还自带
// pid / productCode / subProductCode（计费变配询价强制要求，缺则报
// 371008 "pid not found"），这些是配置的自描述元信息而不是资源项。
// 若把它们一并收进来，与 sv_list 做集合比对时会以"键数不一致"误判成配置不符。
// 同理，计费未来在 config 内追加新的非 sv 字段也不会把我们打成假故障。
//
// 值兼容 float64（JSON number）和 string：trade 出向送的是裸数字，但计费在中间环节
// 把数字序列化成字符串再回传是常见行为，对着字符串报"配置不一致"只会制造假故障。
// 无法解析成整数的值直接丢弃，让上层的集合比对以"键数不一致"暴露。
func GoodsDetailSVMap(m map[string]interface{}, key string) map[string]int64 {
	raw, ok := m[key]
	if !ok || raw == nil {
		return nil
	}
	obj, ok := raw.(map[string]interface{})
	if !ok {
		return nil
	}
	out := make(map[string]int64, len(obj))
	for k, v := range obj {
		if !strings.HasPrefix(k, "sv_") {
			continue
		}
		switch t := v.(type) {
		case float64:
			out[k] = int64(t)
		case int64:
			out[k] = t
		case int:
			out[k] = int64(t)
		case string:
			n, err := strconv.ParseInt(t, 10, 64)
			if err != nil {
				continue
			}
			out[k] = n
		}
	}
	return out
}
