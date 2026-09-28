// Package instancespec 实例规格（CPU/内存/系统盘）常量字典。
//
// 设计稿：.tmp/bundle-instance-spec-design.md
//   - Q1=a：抽象层采用代码常量字典，不新建 DB 字典表
//   - 规格 ID 是兼容期路由键；活动调整内存时沿用既有 ID，不按 ID 推断实际内存。
//   - Q-FRONT-1=b：cpu / memory / system_disk_size 三字段在 user-facing /
//     internal-facing / admin 三处出参都暴露
//
// 唯一消费方：
//   - ctl/pkg/instance.RunCreateInstanceTask：按 bundle.instance_spec_id 选 per-spec 候选池
//   - ctl/pkg/logic/bundle.entityToDetail：把 spec_id 展开为 cpu / memory / system_disk_size
//   - ctl/main/api 只读接口 GET /admin/api/ctl/instance-specs：供运营 bundle 编辑页下拉框
package instancespec

import "strings"

// SpecID 已知的实例规格 ID（业务键）。
//
// 历史 ID 保持不变，以兼容已绑定的套餐和 CTL spec_pools 配置。
// 活动后实际交付规格以本字典的 CPU/Memory 与 Sandbox 池配置为准，不解析 ID 中的旧内存数字。
const (
	// SpecID2C4G50G 历史路由键；NULL 的兼容期 fallback 仍落到此 ID
	SpecID2C4G50G = "spec-2c4g50g"
	// SpecID4C8G80G 历史中阶路由键，不能因活动调整而更名
	SpecID4C8G80G = "spec-4c8g80g"
)

// DefaultSpecID 兼容期默认规格 ID（bundle.instance_spec_id 为空时回落到此规格）。
const DefaultSpecID = SpecID2C4G50G

// SpecDefinition 实例规格展示定义（常量字典；调整展示数值需要发版）。
type SpecDefinition struct {
	// SpecID 规格业务键，对应 bundle.instance_spec_id 列
	SpecID string
	// DisplayName 运营展示名（仅 admin DTO 使用）
	DisplayName string
	// CPU CPU 核数（user-facing / internal-facing / admin 三端都暴露）
	CPU int
	// Memory 内存大小，单位 GB（user-facing / internal-facing / admin 三端都暴露）
	//
	// 单位约定（前端联调文档 codesign/ctl-frontend-billing-api.md）：
	//   - 活动期间历史 spec_id 不改名，不能从其名称推断实际内存；
	//     展示值应与新交付池的 CPU/内存一致。
	//   - 与 sandbox openapi 的 memoryMB（MB 单位）字段无关；ctl bundle DTO 的 memory
	//     是面向 user-facing / admin / internal RPC 的纯展示字段，统一按 GB 报。
	Memory int
	// SystemDiskSize 系统盘大小，单位 GB（user-facing / internal-facing / admin 三端都暴露）
	SystemDiskSize int
}

// knownSpecs 已知规格字典；旧 ID 继续作为路由键，活动规格在这里按实际交付更新。
//
// 注：候选池清单不在此处维护，由 InstanceAPIConfig.SpecPools 持有（设计稿 §3.3 候选 A）。
var knownSpecs = []SpecDefinition{
	{
		SpecID:         SpecID2C4G50G,
		DisplayName:    "2核8G 50G系统盘",
		CPU:            2,
		Memory:         8, // GB
		SystemDiskSize: 50,
	},
	{
		SpecID:         SpecID4C8G80G,
		DisplayName:    "4核16G 80G系统盘",
		CPU:            4,
		Memory:         16, // GB
		SystemDiskSize: 80,
	},
}

// ListAll 返回全部已知规格（用于 admin GET /instance-specs 只读接口）。
//
// 返回的切片是只读副本，调用方不应修改其中元素。
func ListAll() []SpecDefinition {
	out := make([]SpecDefinition, len(knownSpecs))
	copy(out, knownSpecs)
	return out
}

// ResolveByID 按 spec_id 查规格定义；空字符串视为 DefaultSpecID（兼容期 fallback）。
//
// 找不到时返回 (zeroValue, false)，调用方负责处理（admin import / modify 时报
// BundleInstanceSpecNotFound；CreateInstance 选池时报 InstanceCreationFailed）。
func ResolveByID(specID string) (SpecDefinition, bool) {
	specID = strings.TrimSpace(specID)
	if specID == "" {
		specID = DefaultSpecID
	}
	for _, s := range knownSpecs {
		if s.SpecID == specID {
			return s, true
		}
	}
	return SpecDefinition{}, false
}

// IsKnown 判断 spec_id 是否在已知字典中（admin 校验用）。空字符串视为兼容期合法。
func IsKnown(specID string) bool {
	specID = strings.TrimSpace(specID)
	if specID == "" {
		return true
	}
	_, ok := ResolveByID(specID)
	return ok
}
