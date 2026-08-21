package httpapi

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"git.woa.com/wisp/mono/site-gateway/internal/siteauth"
)

const (
	siteAuthStartPath    = "/__lightvela/auth/start"
	siteAuthCallbackPath = "/__lightvela/auth/callback"
	siteSessionCookie    = "lv_site_session"
	siteStateCookie      = "__Host-lv_site_state"
	siteStateTTL         = 5 * time.Minute
)

type AuthOptions struct {
	Required   bool
	StartURL   string
	SessionTTL time.Duration
	Verifier   *siteauth.Verifier
}

func (h *SiteHandler) handleAuthPath(w http.ResponseWriter, r *http.Request) bool {
	switch r.URL.Path {
	case siteAuthStartPath:
		h.startSiteAuth(w, r)
		return true
	case siteAuthCallbackPath:
		h.finishSiteAuth(w, r)
		return true
	default:
		return false
	}
}

func (h *SiteHandler) startSiteAuth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeAuthFailure(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	host, ok := h.trustedSiteHost(r.Host)
	if !ok {
		writeAuthFailure(w, http.StatusNotFound, "site not found")
		return
	}
	if strings.TrimSpace(h.auth.StartURL) == "" {
		writeAuthFailure(w, http.StatusForbidden, "site authentication is unavailable")
		return
	}
	stateBytes := make([]byte, 32)
	if _, err := rand.Read(stateBytes); err != nil {
		writeAuthFailure(w, http.StatusInternalServerError, "site authentication is unavailable")
		return
	}
	state := base64.RawURLEncoding.EncodeToString(stateBytes)
	http.SetCookie(w, &http.Cookie{
		Name:     siteStateCookie,
		Value:    state,
		Path:     "/",
		MaxAge:   int(siteStateTTL.Seconds()),
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	})

	target, err := url.Parse(h.auth.StartURL)
	if err != nil || target.Scheme == "" || target.Host == "" {
		writeAuthFailure(w, http.StatusForbidden, "site authentication is unavailable")
		return
	}
	query := target.Query()
	query.Set("redirect_uri", siteAuthCallbackURL(host))
	query.Set("state", state)
	query.Set("return_to", safeReturnTo(r.URL.RequestURI()))
	target.RawQuery = query.Encode()
	writeAuthRedirect(w, r, target.String())
}

func (h *SiteHandler) finishSiteAuth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeAuthFailure(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	host, ok := h.trustedSiteHost(r.Host)
	if !ok {
		writeAuthFailure(w, http.StatusNotFound, "site not found")
		return
	}
	stateCookie, err := r.Cookie(siteStateCookie)
	if err != nil || strings.TrimSpace(stateCookie.Value) == "" {
		writeAuthFailure(w, http.StatusForbidden, "invalid site authentication state")
		return
	}
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	ticket := strings.TrimSpace(r.URL.Query().Get("ticket"))
	if state == "" || ticket == "" || stateCookie.Value != state || h.auth.Verifier == nil {
		writeAuthFailure(w, http.StatusForbidden, "invalid site authentication ticket")
		return
	}
	claims, err := h.auth.Verifier.Verify(ticket, host, state)
	if err != nil {
		writeAuthFailure(w, http.StatusForbidden, "invalid site authentication ticket")
		return
	}
	ttl := h.auth.SessionTTL
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}
	remaining := h.auth.Verifier.RemainingLifetime(claims)
	if remaining <= 0 {
		writeAuthFailure(w, http.StatusForbidden, "invalid site authentication ticket")
		return
	}
	if remaining < ttl {
		ttl = remaining
	}
	http.SetCookie(w, &http.Cookie{
		Name:     siteSessionCookie,
		Value:    ticket,
		Path:     "/",
		MaxAge:   int(ttl.Seconds()),
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     siteStateCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	})
	writeAuthRedirect(w, r, safeReturnTo(r.URL.Query().Get("return_to")))
}

func (h *SiteHandler) authorizeSiteRequest(w http.ResponseWriter, r *http.Request) bool {
	host, ok := h.trustedSiteHost(r.Host)
	if !ok {
		writeAuthFailure(w, http.StatusNotFound, "site not found")
		return false
	}
	cookie, err := r.Cookie(siteSessionCookie)
	if err != nil || strings.TrimSpace(cookie.Value) == "" || h.auth.Verifier == nil {
		h.redirectToSiteAuth(w, r)
		return false
	}
	if _, err := h.auth.Verifier.Verify(cookie.Value, host, ""); err != nil {
		h.redirectToSiteAuth(w, r)
		return false
	}
	return true
}

func (h *SiteHandler) redirectToSiteAuth(w http.ResponseWriter, r *http.Request) {
	if strings.TrimSpace(h.auth.StartURL) == "" {
		writeAuthFailure(w, http.StatusForbidden, "site authentication is unavailable")
		return
	}
	// Re-entering the start path creates the state cookie and redirects to the issuer.
	h.startSiteAuth(w, r)
}

func (h *SiteHandler) trustedSiteHost(rawHost string) (string, bool) {
	if h == nil || h.resolver == nil {
		return "", false
	}
	_, host, ok := h.resolver.Resolve(rawHost)
	return host, ok
}

func siteAuthCallbackURL(host string) string {
	return "https://" + host + siteAuthCallbackPath
}

func safeReturnTo(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") || containsUnsafeReturnToChars(raw) {
		return "/"
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.IsAbs() || parsed.Host != "" {
		return "/"
	}
	decoded := parsed.EscapedPath()
	for range 3 {
		decoded, err = url.PathUnescape(decoded)
		if err != nil || containsUnsafeReturnToChars(decoded) {
			return "/"
		}
	}
	return raw
}

func containsUnsafeReturnToChars(value string) bool {
	for _, char := range value {
		if char == '\\' || char < 0x20 || char == 0x7f {
			return true
		}
	}
	return false
}

func writeAuthRedirect(w http.ResponseWriter, r *http.Request, target string) {
	if r.Method == http.MethodHead {
		w.Header().Set("Location", target)
		w.WriteHeader(http.StatusFound)
		return
	}
	http.Redirect(w, r, target, http.StatusFound)
}

func writeAuthFailure(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = fmt.Fprintln(w, message)
}
