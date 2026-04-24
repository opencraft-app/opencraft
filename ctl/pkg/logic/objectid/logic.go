// Package objectid 提供统一的业务对象 ID 生成。
// 所有业务 ID 格式为 "前缀-UUID"，例如 ins-550e8400e29b41d4a716446655440000。
// UUID 无状态生成，不依赖数据库或分布式节点，天然适合未来分库分表。
//
// PassID 使用 DB 自增 ID + 编码算法生成（参考 lightpower lhins），
// 格式为 "pass-" + 8 字符 base-36 字符串，例如 pass-jyxpuid0。
package objectid

import (
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// Logic 定义业务对象 ID 生成接口。
type Logic interface {
	GenerateInstanceId() string
	GenerateTaskId() string
	GenerateOperationId() string
	GenerateWxLoginSessionId() string
	GenerateBundleId() string
}

type logic struct{}

// NewLogic 创建 objectid.Logic 实例。
func NewLogic() Logic {
	return &logic{}
}

func (l *logic) GenerateInstanceId() string      { return generate("ins") }
func (l *logic) GenerateTaskId() string           { return generate("task") }
func (l *logic) GenerateOperationId() string      { return generate("op") }
func (l *logic) GenerateWxLoginSessionId() string { return generate("wxs") }
func (l *logic) GenerateBundleId() string         { return generate("bun") }

// generate 生成 "前缀-uuid" 格式的 ID（去掉连字符使其更紧凑）。
func generate(prefix string) string {
	return prefix + "-" + strings.ReplaceAll(uuid.NewString(), "-", "")
}

// GeneratePassID 使用 DB 自增 ID + 编码算法生成 pass_id。
// autoID: 从 id_gen 表获取的自增 ID
// password: 编码密钥，如 "passmon" + ObjectIdPasswordSuffix
// region: 地域名，如 "ap-beijing"
// 返回格式: "pass-" + 8 字符 base-36 字符串
func GeneratePassID(autoID int64, password string, region string) (string, error) {
	if autoID <= 0 {
		return "", fmt.Errorf("invalid autoID: %d", autoID)
	}
	encoded := EncodePassID(autoID, password, region)
	return "pass-" + encoded, nil
}
