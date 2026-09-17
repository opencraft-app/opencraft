package core

import (
	"fmt"
	"strconv"
	"strings"
)

// RegionFromZone returns the Tencent Cloud region that owns zone.
// Tencent zones end in a numeric availability-zone ordinal, for example
// ap-singapore-2 and ap-johorbahru-1.
func RegionFromZone(zone string) (string, error) {
	trimmed := strings.TrimSpace(zone)
	idx := strings.LastIndex(trimmed, "-")
	if idx <= 0 || idx == len(trimmed)-1 {
		return "", fmt.Errorf("invalid Tencent Cloud zone %q", zone)
	}
	if _, err := strconv.Atoi(trimmed[idx+1:]); err != nil {
		return "", fmt.Errorf("invalid Tencent Cloud zone %q: %w", zone, err)
	}
	return trimmed[:idx], nil
}
