package botim

import (
	"strings"

	"github.com/google/uuid"
)

const tencentGroupPrefix = "vg_"

// TencentGroupID 由平台群 UUID 确定性派生腾讯自定义 GroupId（35 个 ASCII 字符）。
func TencentGroupID(groupID string) (string, bool) {
	parsed, err := uuid.Parse(groupID)
	if err != nil || parsed == uuid.Nil {
		return "", false
	}
	return tencentGroupPrefix + strings.ReplaceAll(parsed.String(), "-", ""), true
}

// GroupIDFromTencent 把腾讯 GroupId 反解为平台群 UUID；不是平台群时返回 false。
func GroupIDFromTencent(tencentGroupID string) (string, bool) {
	raw, ok := strings.CutPrefix(tencentGroupID, tencentGroupPrefix)
	if !ok || len(raw) != 32 {
		return "", false
	}
	parsed, err := uuid.Parse(raw)
	if err != nil || parsed == uuid.Nil {
		return "", false
	}
	return parsed.String(), true
}
