package dshproxy

import (
	"crypto/sha256"
	"encoding/hex"
	"net"
	"strings"
)

const routeHashBytes = 8

type routeMatcher map[string]struct{}

func newRouteMatcher(domains []string) routeMatcher {
	matcher := make(routeMatcher, len(domains))
	for _, domain := range domains {
		if domain = canonicalHostname(domain); domain != "" {
			matcher[domain] = struct{}{}
		}
	}
	return matcher
}

func (m routeMatcher) matches(host, botID string) bool {
	routeID := botRouteID(botID)
	if routeID == "" {
		return false
	}
	host = canonicalHostname(host)
	for domain := range m {
		if host == routeID+"-"+domain {
			return true
		}
	}
	return false
}

func botRouteID(botID string) string {
	botID = strings.TrimSpace(botID)
	if botID == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(botID))
	return hex.EncodeToString(sum[:routeHashBytes])
}

func canonicalHostname(authority string) string {
	authority = strings.TrimSpace(strings.ToLower(authority))
	if host, _, err := net.SplitHostPort(authority); err == nil {
		authority = host
	}
	return strings.TrimSuffix(authority, ".")
}
