//go:build vfs && !noltxdateparser

package litestream

import (
	"fmt"
	"time"

	"github.com/markusmobius/go-dateparser"
)

// parseTimeValue parses a timestamp string, trying RFC3339 first, then relative expressions.
func parseTimeValue(value string) (time.Time, error) {
	if t, err := parseRFC3339TimeValue(value); err == nil {
		return t, nil
	}

	cfg := &dateparser.Configuration{
		CurrentTime: time.Now().UTC(),
	}
	result, err := dateparser.Parse(cfg, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid timestamp (expected RFC3339 or relative time like '5 minutes ago'): %s", value)
	}
	if result.Time.IsZero() {
		return time.Time{}, fmt.Errorf("could not parse time: %s", value)
	}
	return result.Time.UTC(), nil
}
