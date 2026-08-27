package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"git.woa.com/wisp/mono/site-gateway/internal/siteauth"
	"git.woa.com/wisp/mono/site-gateway/internal/sitemeta"
)

const (
	fixedAuthStartPath    = "/auth/lightvela/start"
	fixedAuthCallbackPath = "/auth/lightvela/callback"
	siteAuthStartPath     = "/__lightvela/auth/start"
	siteAuthCallbackPath  = "/__lightvela/auth/callback"
	siteSessionCookie     = "lv_site_session"
	siteStateCookie       = "__Host-lv_oidc_state"
	shareSessionCookie    = "__Host-lv_site_share"
)

var (
	errInvalidAuthorizationCode = errors.New("invalid authorization code")
	errUnavailableTokenEndpoint = errors.New("token endpoint unavailable")
)

type AuthOptions struct {
	Required          bool
	EndpointsEnabled  bool
	FixedAuthHost     string
	AuthorizeURL      string
	TokenURL          string
	ClientID          string
	SessionTTL        time.Duration
	TokenCodec        *siteauth.TokenCodec
	IDTokens          *siteauth.IDTokenVerifier
	HTTPClient        *http.Client
	ShareVerifier     ShareCodeVerifier
	TrustProxyHeaders bool
	Clock             func() time.Time
}

func (h *SiteHandler) handleAuthPath(w http.ResponseWriter, r *http.Request) bool {
	if h.auth.EndpointsEnabled {
		if h.isFixedAuthHost(r.Host) {
			switch r.URL.Path {
			case fixedAuthStartPath:
				h.startOIDCAuth(w, r)
				return true
			case fixedAuthCallbackPath:
				h.finishOIDCCallback(w, r)
				return true
			default:
				writeAuthFailure(w, http.StatusNotFound, "site not found")
				return true
			}
		}
	}
	if h.auth.Required && r.URL.Path == siteSharePath {
		h.handleSiteShare(w, r)
		return true
	}
	if h.auth.EndpointsEnabled {
		switch r.URL.Path {
		case siteAuthStartPath:
			h.startSiteAuth(w, r)
			return true
		case siteAuthCallbackPath:
			h.finishSiteAuth(w, r)
			return true
		}
	}
	return false
}

func (h *SiteHandler) startSiteAuth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeAuthFailure(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !h.authReady() {
		writeAuthFailure(w, http.StatusForbidden, "site authentication is unavailable")
		return
	}
	siteID, _, ok := h.resolveSite(w, r)
	if !ok {
		return
	}
	resolved, err := h.resolveSiteHost(r.Context(), r.Host)
	if err != nil || resolved.SiteID != siteID {
		writeAuthFailure(w, http.StatusForbidden, "invalid site authentication launch")
		return
	}
	h.redirectToSiteAuth(w, r, resolved, safeReturnTo(r.URL.Query().Get("return_to")))
}

func (h *SiteHandler) startOIDCAuth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeAuthFailure(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !h.authReady() {
		writeAuthFailure(w, http.StatusForbidden, "site authentication is unavailable")
		return
	}
	launchRaw := strings.TrimSpace(r.URL.Query().Get("launch"))
	launch, err := h.auth.TokenCodec.OpenLaunch(launchRaw)
	if err != nil || launch.CallbackURL != h.fixedAuthCallbackURL() {
		writeAuthFailure(w, http.StatusForbidden, "invalid site authentication launch")
		return
	}
	stateValue, err := randomValue(32)
	if err != nil {
		writeAuthFailure(w, http.StatusInternalServerError, "site authentication is unavailable")
		return
	}
	pkceVerifier, err := randomValue(32)
	if err != nil {
		writeAuthFailure(w, http.StatusInternalServerError, "site authentication is unavailable")
		return
	}
	nonce, err := randomValue(32)
	if err != nil {
		writeAuthFailure(w, http.StatusInternalServerError, "site authentication is unavailable")
		return
	}
	stateToken, err := h.auth.TokenCodec.SealState(siteauth.StateClaims{
		SiteID:       launch.SiteID,
		SiteHost:     launch.SiteHost,
		ReturnTo:     launch.ReturnTo,
		CallbackURL:  launch.CallbackURL,
		State:        stateValue,
		PKCEVerifier: pkceVerifier,
		Nonce:        nonce,
		LaunchDigest: siteauth.DigestToken(launchRaw),
	})
	if err != nil {
		writeAuthFailure(w, http.StatusInternalServerError, "site authentication is unavailable")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     siteStateCookie,
		Value:    stateToken,
		Path:     "/",
		MaxAge:   int((5 * time.Minute).Seconds()),
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	})
	target, err := url.Parse(h.auth.AuthorizeURL)
	if err != nil || target.Scheme == "" || target.Host == "" {
		writeAuthFailure(w, http.StatusForbidden, "site authentication is unavailable")
		return
	}
	query := target.Query()
	query.Set("response_type", "code")
	query.Set("client_id", h.auth.ClientID)
	query.Set("redirect_uri", h.fixedAuthCallbackURL())
	query.Set("scope", "openid")
	query.Set("state", stateValue)
	query.Set("nonce", nonce)
	query.Set("code_challenge", pkceChallenge(pkceVerifier))
	query.Set("code_challenge_method", "S256")
	target.RawQuery = query.Encode()
	writeAuthRedirect(w, r, target.String())
}

func (h *SiteHandler) finishOIDCCallback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeAuthFailure(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !h.authReady() {
		writeAuthFailure(w, http.StatusForbidden, "site authentication is unavailable")
		return
	}
	stateCookie, err := r.Cookie(siteStateCookie)
	if err != nil || strings.TrimSpace(stateCookie.Value) == "" {
		writeAuthFailure(w, http.StatusForbidden, "invalid site authentication state")
		return
	}
	clearStateCookie(w)
	stateClaims, err := h.auth.TokenCodec.OpenState(stateCookie.Value)
	if err != nil {
		writeAuthFailure(w, http.StatusForbidden, "invalid site authentication state")
		return
	}
	if stateClaims.CallbackURL != h.fixedAuthCallbackURL() || strings.TrimSpace(r.URL.Query().Get("state")) == "" || r.URL.Query().Get("state") != stateClaims.State {
		writeAuthFailure(w, http.StatusForbidden, "invalid site authentication state")
		return
	}
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if code == "" {
		writeAuthFailure(w, http.StatusForbidden, "invalid site authentication code")
		return
	}
	idToken, err := h.exchangeAuthorizationCode(r.Context(), code, stateClaims.PKCEVerifier)
	if err != nil {
		switch {
		case errors.Is(err, errInvalidAuthorizationCode):
			writeAuthFailure(w, http.StatusForbidden, "invalid site authentication code")
		default:
			writeAuthFailure(w, http.StatusBadGateway, "site authentication is unavailable")
		}
		return
	}
	identity, err := h.auth.IDTokens.Verify(r.Context(), idToken, stateClaims.Nonce)
	if err != nil {
		switch {
		case errors.Is(err, siteauth.ErrOIDCProviderNotReady):
			writeAuthFailure(w, http.StatusBadGateway, "site authentication is unavailable")
		default:
			writeAuthFailure(w, http.StatusForbidden, "invalid site authentication token")
		}
		return
	}
	if !h.requireSiteOwner(w, r.Context(), stateClaims.SiteID, identity.Subject) {
		return
	}
	handoff, err := h.auth.TokenCodec.SealHandoff(siteauth.HandoffClaims{
		SiteID:   stateClaims.SiteID,
		SiteHost: stateClaims.SiteHost,
		UserID:   identity.Subject,
		Nonce:    stateClaims.Nonce,
		ReturnTo: stateClaims.ReturnTo,
	})
	if err != nil {
		writeAuthFailure(w, http.StatusInternalServerError, "site authentication is unavailable")
		return
	}
	target := "https://" + stateClaims.SiteHost + siteAuthCallbackPath + "?handoff=" + url.QueryEscape(handoff)
	writeAuthRedirect(w, r, target)
}

func (h *SiteHandler) finishSiteAuth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeAuthFailure(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	resolved, err := h.resolveSiteHost(r.Context(), r.Host)
	if errors.Is(err, sitemeta.ErrNotFound) {
		writeAuthFailure(w, http.StatusNotFound, "site not found")
		return
	}
	if err != nil {
		writeAuthFailure(w, http.StatusBadGateway, "site authentication is unavailable")
		return
	}
	handoffRaw := strings.TrimSpace(r.URL.Query().Get("handoff"))
	handoff, err := h.auth.TokenCodec.OpenHandoff(handoffRaw, resolved.Host)
	if err != nil {
		writeAuthFailure(w, http.StatusForbidden, "invalid site authentication handoff")
		return
	}
	if handoff.SiteID != resolved.SiteID {
		writeAuthFailure(w, http.StatusForbidden, "invalid site authentication handoff")
		return
	}
	if !h.requireSiteOwner(w, r.Context(), resolved.SiteID, handoff.UserID) {
		return
	}
	session, err := h.auth.TokenCodec.SealSession(siteauth.SessionClaims{
		SiteID:   resolved.SiteID,
		SiteHost: resolved.Host,
		UserID:   handoff.UserID,
		Nonce:    handoff.Nonce,
	})
	if err != nil {
		writeAuthFailure(w, http.StatusInternalServerError, "site authentication is unavailable")
		return
	}
	ttl := h.auth.SessionTTL
	if ttl <= 0 || ttl > 5*time.Minute {
		ttl = 5 * time.Minute
	}
	http.SetCookie(w, &http.Cookie{
		Name:     siteSessionCookie,
		Value:    session,
		Path:     "/",
		MaxAge:   int(ttl.Seconds()),
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	})
	writeAuthRedirect(w, r, handoff.ReturnTo)
}

func (h *SiteHandler) authorizeSiteRequest(w http.ResponseWriter, r *http.Request) bool {
	siteID, _, ok := h.resolveSite(w, r)
	if !ok {
		return false
	}
	resolved, err := h.resolveSiteHost(r.Context(), r.Host)
	if errors.Is(err, sitemeta.ErrNotFound) {
		writeAuthFailure(w, http.StatusNotFound, "site not found")
		return false
	}
	if err != nil {
		writeAuthFailure(w, http.StatusBadGateway, "site authentication is unavailable")
		return false
	}
	site, err := h.sites.BySiteID(r.Context(), siteID)
	if err != nil || site == nil {
		writeAuthFailure(w, http.StatusBadGateway, "site authentication is unavailable")
		return false
	}
	cookie, err := r.Cookie(siteSessionCookie)
	if err == nil && strings.TrimSpace(cookie.Value) != "" && h.auth.TokenCodec != nil {
		if session, err := h.auth.TokenCodec.OpenSession(cookie.Value, resolved.Host); err == nil {
			if session.SiteID != resolved.SiteID {
				writeAuthFailure(w, http.StatusForbidden, "invalid site authentication session")
				return false
			}
			if !h.requireSiteOwner(w, r.Context(), resolved.SiteID, session.UserID) {
				return false
			}
			return true
		}
	}
	if site.ShareAccessActiveAt(h.authNow()) {
		shareCookie, err := r.Cookie(shareSessionCookie)
		if err == nil && strings.TrimSpace(shareCookie.Value) != "" && h.auth.TokenCodec != nil {
			if session, openErr := h.auth.TokenCodec.OpenShareSession(shareCookie.Value, resolved.Host); openErr == nil &&
				session.SiteID == resolved.SiteID && session.Generation == site.ShareGeneration {
				return true
			}
		}
		h.redirectToSharePage(w, r, safeReturnTo(r.URL.RequestURI()))
		return false
	}
	h.redirectToSiteAuth(w, r, resolved, safeReturnTo(r.URL.RequestURI()))
	return false
}

func (h *SiteHandler) authNow() time.Time {
	if h != nil && h.auth.Clock != nil {
		return h.auth.Clock().UTC()
	}
	return time.Now().UTC()
}

func (h *SiteHandler) redirectToSiteAuth(w http.ResponseWriter, r *http.Request, site resolvedSiteHost, returnTo string) {
	if !h.authReady() {
		writeAuthFailure(w, http.StatusForbidden, "site authentication is unavailable")
		return
	}
	launch, err := h.auth.TokenCodec.SealLaunch(siteauth.LaunchClaims{
		SiteID:      site.SiteID,
		SiteHost:    site.Host,
		ReturnTo:    returnTo,
		CallbackURL: h.fixedAuthCallbackURL(),
	})
	if err != nil {
		writeAuthFailure(w, http.StatusInternalServerError, "site authentication is unavailable")
		return
	}
	target := &url.URL{
		Scheme: "https",
		Host:   h.auth.FixedAuthHost,
		Path:   fixedAuthStartPath,
	}
	target.RawQuery = url.Values{"launch": []string{launch}}.Encode()
	writeAuthRedirect(w, r, target.String())
}

func (h *SiteHandler) authReady() bool {
	return h != nil && h.auth.TokenCodec != nil && h.auth.IDTokens != nil &&
		strings.TrimSpace(h.auth.FixedAuthHost) != "" &&
		strings.TrimSpace(h.auth.AuthorizeURL) != "" &&
		strings.TrimSpace(h.auth.TokenURL) != "" &&
		strings.TrimSpace(h.auth.ClientID) != ""
}

func (h *SiteHandler) fixedAuthCallbackURL() string {
	return "https://" + h.auth.FixedAuthHost + fixedAuthCallbackPath
}

func (h *SiteHandler) isFixedAuthHost(rawHost string) bool {
	return normalizeHost(rawHost) == normalizeHost(h.auth.FixedAuthHost)
}

func (h *SiteHandler) exchangeAuthorizationCode(ctx context.Context, code string, verifier string) (string, error) {
	if strings.TrimSpace(code) == "" || strings.TrimSpace(verifier) == "" {
		return "", errInvalidAuthorizationCode
	}
	form := url.Values{
		"grant_type":    []string{"authorization_code"},
		"code":          []string{code},
		"client_id":     []string{h.auth.ClientID},
		"redirect_uri":  []string{h.fixedAuthCallbackURL()},
		"code_verifier": []string{verifier},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.auth.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", errUnavailableTokenEndpoint
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := h.auth.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", errUnavailableTokenEndpoint
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusOK:
	case resp.StatusCode >= 400 && resp.StatusCode < 500:
		return "", errInvalidAuthorizationCode
	default:
		return "", errUnavailableTokenEndpoint
	}
	var payload struct {
		IDToken string `json:"id_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil || strings.TrimSpace(payload.IDToken) == "" {
		return "", errUnavailableTokenEndpoint
	}
	return payload.IDToken, nil
}

func (h *SiteHandler) requireSiteOwner(w http.ResponseWriter, ctx context.Context, siteID string, expectedUserID string) bool {
	site, err := h.lookupSiteByIDFresh(ctx, siteID)
	if err != nil {
		switch {
		case errors.Is(err, sitemeta.ErrNotFound):
			writeAuthFailure(w, http.StatusForbidden, "invalid site authentication owner")
		default:
			writeAuthFailure(w, http.StatusBadGateway, "site authentication is unavailable")
		}
		return false
	}
	if strings.TrimSpace(site.UserID) == "" || site.UserID != strings.TrimSpace(expectedUserID) {
		writeAuthFailure(w, http.StatusForbidden, "invalid site authentication owner")
		return false
	}
	return true
}

func (h *SiteHandler) lookupSiteByIDFresh(ctx context.Context, siteID string) (*sitemeta.Site, error) {
	if h == nil || h.sites == nil || strings.TrimSpace(siteID) == "" {
		return nil, sitemeta.ErrNotFound
	}
	if fresh, ok := h.sites.(sitemeta.FreshLookup); ok {
		return fresh.BySiteIDFresh(ctx, siteID)
	}
	return h.sites.BySiteID(ctx, siteID)
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

func clearStateCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     siteStateCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	})
}

func randomValue(size int) (string, error) {
	buf := make([]byte, size)
	if _, err := io.ReadFull(rand.Reader, buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func normalizeHost(raw string) string {
	raw = strings.TrimSpace(raw)
	if host, _, err := net.SplitHostPort(raw); err == nil {
		raw = host
	}
	return strings.TrimSuffix(strings.ToLower(raw), ".")
}
