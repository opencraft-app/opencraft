package dshproxy

import (
	"net"
	"strings"
)

const maxBotRouteIDLength = 59 // The complete "<bot-id>-dsh" DNS label is at most 63 bytes.

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

// botID derives the only allowed Bot selector from the public DSH hostname.
func (m routeMatcher) botID(host string) (string, bool) {
	host = canonicalHostname(host)
	for domain := range m {
		prefix, ok := strings.CutSuffix(host, "-"+domain)
		if ok && botRouteID(prefix) != "" {
			return prefix, true
		}
	}
	return "", false
}

func botRouteID(botID string) string {
	botID = strings.TrimSpace(botID)
	if botID == "" || len(botID) > maxBotRouteIDLength || !isRouteAlphaNumeric(botID[0]) || !isRouteAlphaNumeric(botID[len(botID)-1]) {
		return ""
	}
	for index := range len(botID) {
		if value := botID[index]; !isRouteAlphaNumeric(value) && value != '-' {
			return ""
		}
	}
	return botID
}

func isRouteAlphaNumeric(value byte) bool {
	return value >= 'a' && value <= 'z' || value >= '0' && value <= '9'
}

func canonicalHostname(authority string) string {
	authority = strings.TrimSpace(strings.ToLower(authority))
	if host, _, err := net.SplitHostPort(authority); err == nil {
		authority = host
	}
	return strings.TrimSuffix(authority, ".")
}
