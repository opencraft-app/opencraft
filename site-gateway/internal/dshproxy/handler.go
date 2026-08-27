package dshproxy

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"git.woa.com/wisp/mono/site-gateway/internal/tatproxy"
)

const (
	remoteAddress          = "127.0.0.1:3080"
	federationCallbackPath = "/auth/lightvela/callback"
	loginStateCookieName   = "__Host-lightvela_dsh_state"
	delegatedSessionCookie = "__Host-lightvela_dsh_session"
	loginStateTTL          = 5 * time.Minute
)

// FederationClient keeps Auth HMAC and response parsing inside tatproxy while
// allowing the browser-facing login flow to be exercised independently.
type FederationClient interface {
	ClientID() string
	SealLoginState(host, returnTo, state string, ttl time.Duration) (string, error)
	OpenLoginState(raw, expectedHost string) (tatproxy.LoginState, error)
	Exchange(ctx context.Context, ticket, redirectURI string) (tatproxy.DelegatedSession, error)
}

type HandlerOptions struct {
	Dialer                TunnelDialer
	Domains               []string
	MaxTargets            int
	IdleTTL               time.Duration
	ResponseHeaderTimeout time.Duration
	Federation            FederationClient
	AuthorizeURL          string
	Logger                *log.Logger
}

type Handler struct {
	pool         *proxyPool
	routeMatcher routeMatcher
	federation   FederationClient
	authorizeURL *url.URL
	logger       *log.Logger
}

func NewHandler(opts HandlerOptions) (*Handler, error) {
	if opts.Dialer == nil {
		return nil, errors.New("DSH tunnel dialer is required")
	}
	if opts.Federation == nil || strings.TrimSpace(opts.Federation.ClientID()) == "" {
		return nil, errors.New("DSH federation client is required")
	}
	authorizeURL, err := url.Parse(strings.TrimSpace(opts.AuthorizeURL))
	if err != nil || authorizeURL.Scheme != "https" || authorizeURL.Host == "" || authorizeURL.User != nil || authorizeURL.RawQuery != "" || authorizeURL.Fragment != "" {
		return nil, errors.New("DSH federation authorize URL must be an https URL without userinfo, query, or fragment")
	}
	routeMatcher := newRouteMatcher(opts.Domains)
	if len(routeMatcher) == 0 {
		return nil, errors.New("DSH route domains are required")
	}
	if opts.MaxTargets <= 0 || opts.IdleTTL <= 0 {
		return nil, errors.New("DSH proxy limits must be positive")
	}
	if opts.ResponseHeaderTimeout <= 0 {
		opts.ResponseHeaderTimeout = 15 * time.Second
	}
	logger := opts.Logger
	if logger == nil {
		logger = log.Default()
	}
	return &Handler{
		pool:         newProxyPool(opts.Dialer, opts.MaxTargets, opts.IdleTTL, opts.ResponseHeaderTimeout, logger),
		routeMatcher: routeMatcher,
		federation:   opts.Federation,
		authorizeURL: authorizeURL,
		logger:       logger,
	}, nil
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	stripExternalAccessHeaders(r)
	botID, ok := h.routeMatcher.botID(r.Host)
	if !ok {
		writeProxyError(w, http.StatusUnauthorized)
		return
	}
	if r.URL.Path == federationCallbackPath {
		h.handleCallback(w, r)
		return
	}
	delegated, ok := delegatedSessionFromRequest(r)
	if !ok {
		h.startLogin(w, r)
		return
	}
	target := tatproxy.Target{BotID: botID, DelegatedSession: delegated}
	entry, release, err := h.pool.acquire(target)
	if err != nil {
		if errors.Is(err, ErrProxyTargetLimit) || errors.Is(err, tatproxy.ErrTargetLimit) {
			writeProxyError(w, http.StatusServiceUnavailable)
			return
		}
		writeProxyError(w, http.StatusServiceUnavailable)
		return
	}
	defer release()
	entry.proxy.ServeHTTP(w, r)
}

func (h *Handler) startLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeProxyError(w, http.StatusUnauthorized)
		return
	}
	state, err := randomState()
	if err != nil {
		writeProxyError(w, http.StatusServiceUnavailable)
		return
	}
	host := canonicalHostname(r.Host)
	returnTo := safeReturnTo(r.URL.RequestURI())
	sealed, err := h.federation.SealLoginState(host, returnTo, state, loginStateTTL)
	if err != nil {
		writeProxyError(w, http.StatusServiceUnavailable)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: loginStateCookieName, Value: sealed, Path: "/",
		MaxAge: int(loginStateTTL.Seconds()), Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode,
	})
	authorize := *h.authorizeURL
	query := authorize.Query()
	query.Set("client_id", h.federation.ClientID())
	query.Set("redirect_uri", callbackURI(host))
	query.Set("state", state)
	authorize.RawQuery = query.Encode()
	http.Redirect(w, r, authorize.String(), http.StatusFound)
}

func (h *Handler) handleCallback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeProxyError(w, http.StatusUnauthorized)
		return
	}
	stateCookie, ok := singleCookie(r, loginStateCookieName)
	if !ok {
		writeProxyError(w, http.StatusUnauthorized)
		return
	}
	claims, err := h.federation.OpenLoginState(stateCookie.Value, canonicalHostname(r.Host))
	if err != nil || claims.State != r.URL.Query().Get("state") {
		writeProxyError(w, http.StatusUnauthorized)
		return
	}
	ticket := strings.TrimSpace(r.URL.Query().Get("ticket"))
	if ticket == "" {
		writeProxyError(w, http.StatusUnauthorized)
		return
	}
	session, err := h.federation.Exchange(r.Context(), ticket, callbackURI(canonicalHostname(r.Host)))
	if err != nil || session.Value == "" || !session.ExpiresAt.After(time.Now()) {
		writeProxyError(w, http.StatusUnauthorized)
		return
	}
	expiresAt := session.ExpiresAt
	maxAge := int(time.Until(expiresAt).Seconds())
	if maxAge < 1 {
		maxAge = 1
	}
	http.SetCookie(w, &http.Cookie{
		Name: delegatedSessionCookie, Value: session.Value, Path: "/", Expires: expiresAt,
		MaxAge: maxAge, Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode,
	})
	http.SetCookie(w, &http.Cookie{
		Name: loginStateCookieName, Value: "", Path: "/", MaxAge: -1,
		Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, safeReturnTo(claims.ReturnTo), http.StatusFound)
}

func delegatedSessionFromRequest(r *http.Request) (string, bool) {
	cookie, ok := singleCookie(r, delegatedSessionCookie)
	if !ok || cookie.Value == "" || len(cookie.Value) > 16<<10 {
		return "", false
	}
	return cookie.Value, true
}

func singleCookie(r *http.Request, name string) (*http.Cookie, bool) {
	var match *http.Cookie
	for _, cookie := range r.Cookies() {
		if cookie.Name != name {
			continue
		}
		if match != nil {
			return nil, false
		}
		match = cookie
	}
	return match, match != nil
}

func callbackURI(host string) string {
	return "https://" + canonicalHostname(host) + federationCallbackPath
}

func safeReturnTo(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.IsAbs() || parsed.Host != "" || parsed.Opaque != "" || !safeReturnPath(parsed.Path) {
		return "/"
	}
	return parsed.RequestURI()
}

func safeReturnPath(path string) bool {
	for range 4 {
		if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") || strings.ContainsAny(path, "\\\r\n") {
			return false
		}
		decoded, err := url.PathUnescape(path)
		if err != nil {
			return false
		}
		if decoded == path {
			return true
		}
		path = decoded
	}
	return false
}

func clearDelegatedSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: delegatedSessionCookie, Value: "", Path: "/", MaxAge: -1,
		Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode,
	})
}

func randomState() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

func (h *Handler) Close() {
	h.pool.close()
}

func writeProxyError(w http.ResponseWriter, status int) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(http.StatusText(status) + "\n"))
}
