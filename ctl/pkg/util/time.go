// Package util ...
package util

import (
	"time"
)

// ISO8601 ...
func ISO8601(local time.Time) string {
	zero := time.Time{}
	if local == zero {
		return ""
	}
	return local.UTC().Format(time.RFC3339)
}

// GenerateZeroTimeForMySQL ...
func GenerateZeroTimeForMySQL() time.Time {
	return time.Date(1970, time.January, 1, 0, 0, 0, 0, time.UTC)
}
