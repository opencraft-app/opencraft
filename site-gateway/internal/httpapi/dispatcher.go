package httpapi

import (
	"net"
	"net/http"
	"strings"
)

// NewDispatcher routes explicitly configured DSH hosts before the existing site
// handler. Every other host remains governed by the existing COS/site routing.
func NewDispatcher(site, dsh http.Handler, dshDomains []string) http.Handler {
	domains := make(map[string]struct{}, len(dshDomains))
	for _, domain := range dshDomains {
		if domain = canonicalHostname(domain); domain != "" {
			domains[domain] = struct{}{}
		}
	}
	if dsh == nil || len(domains) == 0 {
		return site
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isDSHHost(canonicalHostname(r.Host), domains) {
			dsh.ServeHTTP(w, r)
			return
		}
		site.ServeHTTP(w, r)
	})
}

func isDSHHost(host string, domains map[string]struct{}) bool {
	for domain := range domains {
		prefix, ok := strings.CutSuffix(host, "-"+domain)
		if ok && validDSHBotID(prefix) {
			return true
		}
	}
	return false
}

func validDSHBotID(botID string) bool {
	if len(botID) == 0 || len(botID) > 59 || !isDSHAlphaNumeric(botID[0]) || !isDSHAlphaNumeric(botID[len(botID)-1]) {
		return false
	}
	for index := range len(botID) {
		value := botID[index]
		if !isDSHAlphaNumeric(value) && value != '-' {
			return false
		}
	}
	return true
}

func isDSHAlphaNumeric(value byte) bool {
	return value >= 'a' && value <= 'z' || value >= '0' && value <= '9'
}

func canonicalHostname(authority string) string {
	authority = strings.TrimSpace(strings.ToLower(authority))
	if host, _, err := net.SplitHostPort(authority); err == nil {
		authority = host
	}
	return strings.TrimSuffix(authority, ".")
}
