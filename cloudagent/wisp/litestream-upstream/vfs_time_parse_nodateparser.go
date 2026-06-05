//go:build vfs && noltxdateparser

package litestream

import (
	"fmt"
	"time"
)

// parseTimeValue parses a timestamp string without pulling in the natural-language parser.
func parseTimeValue(value string) (time.Time, error) {
	if t, err := parseRFC3339TimeValue(value); err == nil {
		return t, nil
	}
	return time.Time{}, fmt.Errorf("invalid timestamp (expected RFC3339): %s", value)
}
