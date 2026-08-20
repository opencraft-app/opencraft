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
		if _, ok := domains[canonicalHostname(r.Host)]; ok {
			dsh.ServeHTTP(w, r)
			return
		}
		site.ServeHTTP(w, r)
	})
}

func canonicalHostname(authority string) string {
	authority = strings.TrimSpace(strings.ToLower(authority))
	if host, _, err := net.SplitHostPort(authority); err == nil {
		authority = host
	}
	return strings.TrimSuffix(authority, ".")
}
