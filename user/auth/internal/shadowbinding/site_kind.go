package shadowbinding

import (
	"fmt"
	"strings"
)

func ParseSiteKind(raw string) (string, error) {
	kind := strings.ToLower(strings.TrimSpace(raw))
	if kind == "" {
		return SiteKindCN, nil
	}
	switch kind {
	case SiteKindCN, SiteKindIntl:
		return kind, nil
	default:
		return "", fmt.Errorf("invalid site kind %q: expected %q or %q", raw, SiteKindCN, SiteKindIntl)
	}
}
