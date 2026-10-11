package httpapi

import (
	"io"
	"net/http"
	"net/url"
	"strings"

	"git.woa.com/wisp/mono/site-gateway/internal/backend"
	"git.woa.com/wisp/mono/site-gateway/internal/sitemeta"
)

// Mutations require a fresh owner session. A qualified persistent runtime may
// accept fresh site-share sessions for GET/HEAD using a read-only SQL capability.
func (h *SiteHandler) tryServeBackend(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path != "/api" && !strings.HasPrefix(r.URL.Path, "/api/") {
		return false
	}
	resolved, err := h.resolveSiteHost(r.Context(), r.Host)
	if err != nil {
		return false
	}
	cached, err := h.sites.BySiteID(r.Context(), resolved.SiteID)
	if err != nil || cached == nil || cached.Kind != "fullstack" {
		return false
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	fresh, ok := h.sites.(sitemeta.FreshLookup)
	if !ok {
		writeAuthFailure(w, 503, "backend authorization unavailable")
		return true
	}
	site, err := fresh.BySiteIDFresh(r.Context(), resolved.SiteID)
	if err != nil || site == nil {
		writeAuthFailure(w, 503, "backend authorization unavailable")
		return true
	}
	if site.Status != sitemeta.StatusActive || site.TrafficExhausted() {
		writeAuthFailure(w, 403, "site backend unavailable")
		return true
	}
	if site.Kind != "fullstack" || site.ReleaseID == "" || site.BackendSHA256 == "" {
		writeAuthFailure(w, 409, "site release changed")
		return true
	}
	if h.backend == nil || h.auth.TokenCodec == nil {
		writeAuthFailure(w, 503, "site backend unavailable")
		return true
	}
	owner := false
	if cookie, cookieErr := r.Cookie(siteSessionCookie); cookieErr == nil {
		session, openErr := h.auth.TokenCodec.OpenSession(cookie.Value, resolved.Host)
		if openErr == nil && session.SiteID == resolved.SiteID && session.UserID == site.UserID {
			owner = true
		}
	}
	readOnly := false
	if !owner && h.auth.BackendSharedRead && (r.Method == http.MethodGet || r.Method == http.MethodHead) && site.ShareAccessActiveAt(h.authNow()) {
		if cookie, cookieErr := r.Cookie(shareSessionCookie); cookieErr == nil {
			session, openErr := h.auth.TokenCodec.OpenShareSession(cookie.Value, resolved.Host)
			readOnly = openErr == nil && session.SiteID == resolved.SiteID && session.Generation == site.ShareGeneration
		}
	}
	if !owner && !readOnly {
		writeAuthFailure(w, 401, "site authentication required")
		return true
	}
	switch r.Method {
	case "GET", "HEAD":
	case "POST", "PUT", "PATCH", "DELETE":
		origin, err := url.Parse(r.Header.Get("Origin"))
		if err != nil || origin.Scheme != "https" || origin.Host != resolved.Host || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" {
			writeAuthFailure(w, 403, "same-origin request required")
			return true
		}
	default:
		w.Header().Set("Allow", "GET, HEAD, POST, PUT, PATCH, DELETE")
		writeAuthFailure(w, 405, "method not allowed")
		return true
	}
	// A page pinned to an older release is rejected rather than silently executing
	// a different backend schema. The client must reload after a version switch.
	if version := r.Header.Get("X-Website-Release"); version != site.ReleaseID {
		writeAuthFailure(w, 409, "site release changed; reload required")
		return true
	}
	r.Body = http.MaxBytesReader(w, r.Body, backend.MaxBodyBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeAuthFailure(w, 413, "request body too large")
		return true
	}
	headers := map[string]string{}
	for _, key := range []string{"Content-Type", "Accept"} {
		if value := r.Header.Get(key); value != "" {
			headers[key] = value
		}
	}
	result, err := h.backend.Invoke(r.Context(), resolved.SiteID, site.ReleaseID, backend.Invocation{SHA256: site.BackendSHA256, ReadOnly: readOnly, Method: r.Method, Path: r.URL.RequestURI(), Headers: headers, Body: body})
	if err != nil {
		writeAuthFailure(w, 502, "site backend request failed")
		return true
	}
	if ct := result.Headers["Content-Type"]; ct != "" && len(ct) < 8192 && !strings.ContainsAny(ct, "\r\n") {
		w.Header().Set("Content-Type", ct)
	}
	if result.Status == 429 {
		w.Header().Set("Retry-After", "1")
	}
	w.WriteHeader(result.Status)
	var written int
	if r.Method != "HEAD" {
		written, _ = w.Write(result.Body)
	}
	h.usage.Record(resolved.SiteID, int64(written))
	return true
}
