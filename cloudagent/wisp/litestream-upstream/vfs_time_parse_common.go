//go:build vfs

package litestream

import "time"

func parseRFC3339TimeValue(value string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return t, nil
	}
	return time.Parse(time.RFC3339, value)
}
