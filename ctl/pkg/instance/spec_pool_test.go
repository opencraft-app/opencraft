// Package instance 内部白盒测试：覆盖 templateCandidatesForSpec / templateClassForSpec /
// skuIDForSpec 全部分支。
//
// 设计稿 .tmp/bundle-instance-spec-design.md §13.2 R1f / §13.5 联调期单测覆盖盲区。
// 本文件覆盖三条与多规格路由强相关的方法：
//   - templateCandidatesForSpec：BUG-07 联调期暴露，migration 022 把所有 bundle 回填
//     instance_spec_id 后，若 rewrite ConfigMap 漏配 [[api.instance.spec_pools]]，
//     CreateInstance 整条链路立即 fail 且全量阻断。
//   - templateClassForSpec：Q1=C 隔离方案落地，多规格部署时让 4C8G 走独立 template_class，
//     避免 sandbox sandbox_primary 模式按 binding.priority 自主选池导致跨规格漂移。
//   - skuIDForSpec：与 templateClassForSpec 对偶，避免 ctl 全局 DefaultSKUID 与多规格 sku
//     校验冲突（sandbox selectTemplateSKUBindingsForAllocation 严格校验
//     sku.template_class_id == requested.templateClassID）。
//
// 纯包内白盒测试，无 DB / Adapter 依赖。
package instance

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"ctl/pkg/config"
	"ctl/pkg/errcode"

	"go.uber.org/zap"
)

// installInstanceAPIConfigForTest 覆盖 config.ServerConf.APIConfig.Instance，
// 测试结束后恢复原值，避免污染同包其它测试。
func installInstanceAPIConfigForTest(t *testing.T, conf *config.InstanceAPIConfig) {
	t.Helper()

	if config.ServerConf == nil {
		config.ServerConf = &config.GlobalConfig{}
	}
	if config.ServerConf.APIConfig == nil {
		config.ServerConf.APIConfig = &config.APIConfig{}
	}

	original := config.ServerConf.APIConfig.Instance
	config.ServerConf.APIConfig.Instance = conf
	t.Cleanup(func() {
		config.ServerConf.APIConfig.Instance = original
	})
}

// newLogicForSpecPoolTest 构造最小可用 *logic，仅供 templateCandidatesForSpec 单测使用。
// 不挂任何 DAO / Adapter，因为该方法只读 logic.defaultTemplate / candidateTemplates 和
// 全局 config.ServerConf.APIConfig.Instance.SpecPools，纯查表逻辑。
func newLogicForSpecPoolTest(globalDefault string, globalCandidates []string) *logic {
	return &logic{
		logger:             zap.NewNop(),
		defaultTemplate:    globalDefault,
		candidateTemplates: append([]string(nil), globalCandidates...),
	}
}

// newLogicForTemplateClassTest 构造带全局 defaultTemplateClass 的 *logic，
// 供 templateClassForSpec 单测使用。
func newLogicForTemplateClassTest(globalTemplateClass string) *logic {
	return &logic{
		logger:               zap.NewNop(),
		defaultTemplateClass: globalTemplateClass,
	}
}

// newLogicForSkuIDTest 构造带全局 defaultSKUID 的 *logic，供 skuIDForSpec 单测使用。
func newLogicForSkuIDTest(globalSKUID string) *logic {
	return &logic{
		logger:       zap.NewNop(),
		defaultSKUID: globalSKUID,
	}
}

// TestTemplateCandidatesForSpec_EmptySpecIDFallsBackToGlobal 覆盖兼容期路径：
// bundle.instance_spec_id 为空时（migration 022 之前的存量数据），方法应返回全局
// default + candidate 列表，不查 SpecPools。设计稿 §4.3 / Q2=a。
func TestTemplateCandidatesForSpec_EmptySpecIDFallsBackToGlobal(t *testing.T) {
	installInstanceAPIConfigForTest(t, &config.InstanceAPIConfig{
		DefaultTemplateID:    "pool-c3",
		CandidateTemplateIDs: []string{"pool-c0", "pool-c1", "pool-c2", "pool-c3"},
		SpecPools: []config.SpecPoolConfig{
			{
				SpecID:               "spec-2c4g50g",
				DefaultTemplateID:    "pool-spec-2c-default",
				CandidateTemplateIDs: []string{"pool-spec-2c-default", "pool-spec-2c-backup"},
			},
		},
	})

	l := newLogicForSpecPoolTest("pool-c3", []string{"pool-c0", "pool-c1", "pool-c2", "pool-c3"})

	got, err := l.templateCandidatesForSpec("")
	if err != nil {
		t.Fatalf("expected nil err for empty specID, got %v", err)
	}
	want := []string{"pool-c3", "pool-c0", "pool-c1", "pool-c2"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("expected global pools %v, got %v", want, got)
	}
}

// TestTemplateCandidatesForSpec_HitsSpecPools 覆盖核心路径：
// bundle.instance_spec_id 命中 SpecPools 时返回该 spec 自己的 default + candidate，
// 不混入全局 candidate。设计稿 §3.3 Q2=a。
func TestTemplateCandidatesForSpec_HitsSpecPools(t *testing.T) {
	installInstanceAPIConfigForTest(t, &config.InstanceAPIConfig{
		DefaultTemplateID:    "pool-c3",
		CandidateTemplateIDs: []string{"pool-c0", "pool-c1", "pool-c2"},
		SpecPools: []config.SpecPoolConfig{
			{
				SpecID:               "spec-2c4g50g",
				DefaultTemplateID:    "pool-spec-2c-default",
				CandidateTemplateIDs: []string{"pool-spec-2c-default", "pool-spec-2c-backup"},
			},
			{
				SpecID:               "spec-4c8g80g",
				DefaultTemplateID:    "pool-spec-4c-default",
				CandidateTemplateIDs: []string{"pool-spec-4c-default"},
			},
		},
	})

	l := newLogicForSpecPoolTest("pool-c3", []string{"pool-c0", "pool-c1"})

	got, err := l.templateCandidatesForSpec("spec-2c4g50g")
	if err != nil {
		t.Fatalf("expected nil err for hit specID, got %v", err)
	}
	want := []string{"pool-spec-2c-default", "pool-spec-2c-backup"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("expected spec pools %v, got %v", want, got)
	}

	// 4C8G 单独命中第二条规格，验证多 spec 不串。
	got, err = l.templateCandidatesForSpec("spec-4c8g80g")
	if err != nil {
		t.Fatalf("expected nil err for spec-4c8g80g, got %v", err)
	}
	want = []string{"pool-spec-4c-default"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("expected 4c8g pools %v, got %v", want, got)
	}
}

// TestTemplateCandidatesForSpec_SpecIDMissingFromSpecPools 覆盖 BUG-07 核心断链路面：
// bundle.instance_spec_id 非空但 SpecPools 配置里没有对应段（即配置漂移），方法必须返
// ErrBundleInstanceSpecNoPool 而非静默 fallback 到全局。设计稿 §10 Q7=a 契约：避免
// "用户付了 4C8G 钱拿到 2C4G 实例" 的资金风险。
func TestTemplateCandidatesForSpec_SpecIDMissingFromSpecPools(t *testing.T) {
	installInstanceAPIConfigForTest(t, &config.InstanceAPIConfig{
		DefaultTemplateID:    "pool-c3",
		CandidateTemplateIDs: []string{"pool-c0", "pool-c1", "pool-c2"},
		SpecPools: []config.SpecPoolConfig{
			{
				SpecID:               "spec-2c4g50g",
				DefaultTemplateID:    "pool-spec-2c-default",
				CandidateTemplateIDs: []string{"pool-spec-2c-default"},
			},
		},
	})

	l := newLogicForSpecPoolTest("pool-c3", []string{"pool-c0", "pool-c1", "pool-c2"})

	got, err := l.templateCandidatesForSpec("spec-4c8g80g")
	if err == nil {
		t.Fatalf("expected ErrBundleInstanceSpecNoPool, got nil err with pools %v", got)
	}
	if !errors.Is(err, errcode.ErrBundleInstanceSpecNoPool) {
		t.Fatalf("expected ErrBundleInstanceSpecNoPool, got %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil pools on error, got %v", got)
	}
	// 错误消息应该包含具体的 specID，方便运维定位
	if !strings.Contains(err.Error(), "spec-4c8g80g") {
		t.Fatalf("expected error message to mention spec-4c8g80g, got %v", err)
	}
}

// TestTemplateCandidatesForSpec_SpecPoolsNotConfiguredAtAll 覆盖 BUG-07 完整复现路径：
// rewrite ConfigMap 完全没配 [[api.instance.spec_pools]] 段（SpecPools 是 nil 切片），
// 但 migration 022 已经把所有 bundle.instance_spec_id 回填为 spec-2c4g50g。这种部署
// SOP 漂移下，CreateInstance 必须立即 fail，不能 fallback 到全局让用户随机落到其它池。
func TestTemplateCandidatesForSpec_SpecPoolsNotConfiguredAtAll(t *testing.T) {
	installInstanceAPIConfigForTest(t, &config.InstanceAPIConfig{
		DefaultTemplateID:    "pool-c3",
		CandidateTemplateIDs: []string{"pool-c0", "pool-c1", "pool-c2", "pool-c3"},
		SpecPools:            nil, // 模拟 BUG-07：rewrite ConfigMap 漏配 spec_pools 段
	})

	l := newLogicForSpecPoolTest("pool-c3", []string{"pool-c0", "pool-c1", "pool-c2", "pool-c3"})

	got, err := l.templateCandidatesForSpec("spec-2c4g50g")
	if err == nil {
		t.Fatalf("expected ErrBundleInstanceSpecNoPool when SpecPools is nil, got nil err with pools %v", got)
	}
	if !errors.Is(err, errcode.ErrBundleInstanceSpecNoPool) {
		t.Fatalf("expected ErrBundleInstanceSpecNoPool, got %v", err)
	}
}

// TestTemplateCandidatesForSpec_SpecPoolsDeduplicates 验证候选池去重：当 SpecPool 的
// DefaultTemplateID 同时出现在 CandidateTemplateIDs 列表里（实际配置常见，例 sandbox-bj-7
// 上 default=pool-c3 同时出现在 candidate=[pool-c0..c5] 里），返回结果应该去重并保持顺序。
func TestTemplateCandidatesForSpec_SpecPoolsDeduplicates(t *testing.T) {
	installInstanceAPIConfigForTest(t, &config.InstanceAPIConfig{
		SpecPools: []config.SpecPoolConfig{
			{
				SpecID:               "spec-2c4g50g",
				DefaultTemplateID:    "pool-c3",
				CandidateTemplateIDs: []string{"pool-c0", "pool-c1", "pool-c2", "pool-c3", "pool-c4", "pool-c5"},
			},
		},
	})

	l := newLogicForSpecPoolTest("", nil)

	got, err := l.templateCandidatesForSpec("spec-2c4g50g")
	if err != nil {
		t.Fatalf("expected nil err, got %v", err)
	}
	// pool-c3 既是 default 又在 candidate 里，期望只出现一次（default 在前）
	want := []string{"pool-c3", "pool-c0", "pool-c1", "pool-c2", "pool-c4", "pool-c5"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("expected dedup pools %v, got %v", want, got)
	}
}

// TestTemplateClassForSpec_HitsSpecPoolWithTemplateClassID 覆盖 Q1=C 核心路径：
// SpecPool 命中且 TemplateClassID 非空 → 返该 spec 自己的 template_class，
// 实现 4C8G 路由与 2C4G 完全隔离。设计稿 §13.2 R1f 教训。
func TestTemplateClassForSpec_HitsSpecPoolWithTemplateClassID(t *testing.T) {
	installInstanceAPIConfigForTest(t, &config.InstanceAPIConfig{
		DefaultTemplateClassID: "openclaw-default",
		SpecPools: []config.SpecPoolConfig{
			{
				SpecID:               "spec-2c4g50g",
				DefaultTemplateID:    "pool-c3",
				CandidateTemplateIDs: []string{"pool-c3"},
				// 不设 TemplateClassID，沿用全局
			},
			{
				SpecID:               "spec-4c8g80g",
				TemplateClassID:      "openclaw-4c8g80g",
				DefaultTemplateID:    "pool-bj7-4c8g80g",
				CandidateTemplateIDs: []string{"pool-bj7-4c8g80g"},
			},
		},
	})

	l := newLogicForTemplateClassTest("openclaw-default")

	if got := l.templateClassForSpec("spec-4c8g80g"); got != "openclaw-4c8g80g" {
		t.Fatalf("expected isolated template_class openclaw-4c8g80g for 4c8g spec, got %q", got)
	}
}

// TestTemplateClassForSpec_HitsSpecPoolWithoutTemplateClassID 覆盖兼容路径：
// SpecPool 命中但 TemplateClassID 为空（单规格部署 / 兼容期）→ fallback 到
// 全局 defaultTemplateClass。
func TestTemplateClassForSpec_HitsSpecPoolWithoutTemplateClassID(t *testing.T) {
	installInstanceAPIConfigForTest(t, &config.InstanceAPIConfig{
		DefaultTemplateClassID: "openclaw-default",
		SpecPools: []config.SpecPoolConfig{
			{
				SpecID:               "spec-2c4g50g",
				DefaultTemplateID:    "pool-c3",
				CandidateTemplateIDs: []string{"pool-c3"},
			},
		},
	})

	l := newLogicForTemplateClassTest("openclaw-default")

	if got := l.templateClassForSpec("spec-2c4g50g"); got != "openclaw-default" {
		t.Fatalf("expected fallback to global openclaw-default when TemplateClassID empty, got %q", got)
	}
}

// TestTemplateClassForSpec_SpecIDMissingFromSpecPools 覆盖路由侧的"未命中"路径：
// templateCandidatesForSpec 会对该输入返 ErrBundleInstanceSpecNoPool，但 templateClassForSpec
// 走的是 metric / fallback 等"宽容"路径——直接返全局 defaultTemplateClass，让上层决定要不要
// 真正发起调用（不要双重 fail）。
func TestTemplateClassForSpec_SpecIDMissingFromSpecPools(t *testing.T) {
	installInstanceAPIConfigForTest(t, &config.InstanceAPIConfig{
		DefaultTemplateClassID: "openclaw-default",
		SpecPools: []config.SpecPoolConfig{
			{
				SpecID:               "spec-2c4g50g",
				DefaultTemplateID:    "pool-c3",
				CandidateTemplateIDs: []string{"pool-c3"},
			},
		},
	})

	l := newLogicForTemplateClassTest("openclaw-default")

	if got := l.templateClassForSpec("spec-9999"); got != "openclaw-default" {
		t.Fatalf("expected fallback to global openclaw-default for missing spec, got %q", got)
	}
}

// TestTemplateClassForSpec_EmptySpecID 覆盖兼容期路径：
// bundle.instance_spec_id 为空（migration 022 之前的存量数据）→ fallback 全局。
func TestTemplateClassForSpec_EmptySpecID(t *testing.T) {
	installInstanceAPIConfigForTest(t, &config.InstanceAPIConfig{
		DefaultTemplateClassID: "openclaw-default",
		SpecPools: []config.SpecPoolConfig{
			{
				SpecID:               "spec-4c8g80g",
				TemplateClassID:      "openclaw-4c8g80g",
				DefaultTemplateID:    "pool-bj7-4c8g80g",
				CandidateTemplateIDs: []string{"pool-bj7-4c8g80g"},
			},
		},
	})

	l := newLogicForTemplateClassTest("openclaw-default")

	if got := l.templateClassForSpec(""); got != "openclaw-default" {
		t.Fatalf("expected fallback to global openclaw-default for empty specID, got %q", got)
	}
}

// TestSkuIDForSpec_HitsSpecPoolWithSKUID 覆盖核心路径：SpecPool 命中且 SKUID 非空
// → 返该 spec 自己的 sku，实现多规格 sku 完全隔离。设计稿 §13.2 R1f 对偶项。
func TestSkuIDForSpec_HitsSpecPoolWithSKUID(t *testing.T) {
	installInstanceAPIConfigForTest(t, &config.InstanceAPIConfig{
		DefaultSKUID: "sku-hermes-2c4g",
		SpecPools: []config.SpecPoolConfig{
			{
				SpecID:               "spec-2c4g50g",
				SKUID:                "sku-hermes-2c4g",
				DefaultTemplateID:    "pool-c3",
				CandidateTemplateIDs: []string{"pool-c3"},
			},
			{
				SpecID:               "spec-4c8g80g",
				TemplateClassID:      "openclaw-4c8g80g",
				SKUID:                "sku-hermes-4c8g",
				DefaultTemplateID:    "pool-bj7-4c8g80g",
				CandidateTemplateIDs: []string{"pool-bj7-4c8g80g"},
			},
		},
	})

	l := newLogicForSkuIDTest("sku-hermes-2c4g")

	if got := l.skuIDForSpec("spec-4c8g80g"); got != "sku-hermes-4c8g" {
		t.Fatalf("expected isolated sku-hermes-4c8g for 4c8g spec, got %q", got)
	}
	if got := l.skuIDForSpec("spec-2c4g50g"); got != "sku-hermes-2c4g" {
		t.Fatalf("expected sku-hermes-2c4g for 2c4g spec, got %q", got)
	}
}

// TestSkuIDForSpec_HitsSpecPoolWithoutSKUID 覆盖兼容路径：SpecPool 命中但 SKUID 为空
// （单 sku 部署 / 兼容期）→ fallback 到全局 defaultSKUID。
func TestSkuIDForSpec_HitsSpecPoolWithoutSKUID(t *testing.T) {
	installInstanceAPIConfigForTest(t, &config.InstanceAPIConfig{
		DefaultSKUID: "sku-hermes-2c4g",
		SpecPools: []config.SpecPoolConfig{
			{
				SpecID:               "spec-2c4g50g",
				DefaultTemplateID:    "pool-c3",
				CandidateTemplateIDs: []string{"pool-c3"},
				// 不设 SKUID，沿用全局
			},
		},
	})

	l := newLogicForSkuIDTest("sku-hermes-2c4g")

	if got := l.skuIDForSpec("spec-2c4g50g"); got != "sku-hermes-2c4g" {
		t.Fatalf("expected fallback to global sku-hermes-2c4g when SKUID empty, got %q", got)
	}
}

// TestSkuIDForSpec_SpecIDMissingFromSpecPools 覆盖未命中路径：未配 SpecPool 的 spec
// 直接 fallback 全局 defaultSKUID（与 templateClassForSpec 对偶；不双重 fail）。
func TestSkuIDForSpec_SpecIDMissingFromSpecPools(t *testing.T) {
	installInstanceAPIConfigForTest(t, &config.InstanceAPIConfig{
		DefaultSKUID: "sku-hermes-2c4g",
		SpecPools: []config.SpecPoolConfig{
			{
				SpecID:               "spec-2c4g50g",
				SKUID:                "sku-hermes-2c4g",
				DefaultTemplateID:    "pool-c3",
				CandidateTemplateIDs: []string{"pool-c3"},
			},
		},
	})

	l := newLogicForSkuIDTest("sku-hermes-2c4g")

	if got := l.skuIDForSpec("spec-9999"); got != "sku-hermes-2c4g" {
		t.Fatalf("expected fallback to global sku-hermes-2c4g for missing spec, got %q", got)
	}
}

// TestSkuIDForSpec_EmptySpecID 覆盖兼容期路径：bundle.instance_spec_id 为空
// （migration 022 之前的存量数据）→ fallback 全局。
func TestSkuIDForSpec_EmptySpecID(t *testing.T) {
	installInstanceAPIConfigForTest(t, &config.InstanceAPIConfig{
		DefaultSKUID: "sku-hermes-2c4g",
		SpecPools: []config.SpecPoolConfig{
			{
				SpecID:               "spec-4c8g80g",
				TemplateClassID:      "openclaw-4c8g80g",
				SKUID:                "sku-hermes-4c8g",
				DefaultTemplateID:    "pool-bj7-4c8g80g",
				CandidateTemplateIDs: []string{"pool-bj7-4c8g80g"},
			},
		},
	})

	l := newLogicForSkuIDTest("sku-hermes-2c4g")

	if got := l.skuIDForSpec(""); got != "sku-hermes-2c4g" {
		t.Fatalf("expected fallback to global sku-hermes-2c4g for empty specID, got %q", got)
	}
}
