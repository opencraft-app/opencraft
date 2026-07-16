package httpapi

import (
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

var oauthReturnToAllowedBaseDomains = []string{
	"lightclaw.cn",
	"lightclaw.tech",
	"lightclaw.site",
	"tencent.com",
	"lightvela.com",
}

type oauthAllowedHostPattern struct {
	prefix string
	suffix string
}

var oauthReturnToAllowedHostPatterns = []oauthAllowedHostPattern{
	{prefix: "lightvela-", suffix: ".edgeone.cool"},
	{prefix: "lightvela-", suffix: ".edgeone.run"},
}

type oauthReturnToAllowlist struct {
	baseDomains  []string
	hostPatterns []oauthAllowedHostPattern
	origins      []string
}

func defaultOAuthReturnToAllowlist() oauthReturnToAllowlist {
	return oauthReturnToAllowlist{
		baseDomains:  append([]string(nil), oauthReturnToAllowedBaseDomains...),
		hostPatterns: append([]oauthAllowedHostPattern(nil), oauthReturnToAllowedHostPatterns...),
	}
}

func buildOAuthReturnToAllowlist(hosts []string) oauthReturnToAllowlist {
	if len(hosts) == 0 {
		return defaultOAuthReturnToAllowlist()
	}

	allowlist := oauthReturnToAllowlist{
		baseDomains:  make([]string, 0, len(hosts)),
		hostPatterns: make([]oauthAllowedHostPattern, 0, len(hosts)),
		origins:      make([]string, 0, len(hosts)),
	}
	for _, raw := range hosts {
		host := strings.ToLower(strings.TrimSpace(raw))
		if host == "" {
			continue
		}
		if strings.Contains(host, "://") {
			if origin := normalizedReturnToOrigin(host); origin != "" {
				allowlist.origins = append(allowlist.origins, origin)
			}
			continue
		}
		if strings.Count(host, "*") == 0 {
			allowlist.baseDomains = append(allowlist.baseDomains, host)
			continue
		}
		if strings.Count(host, "*") > 1 {
			continue
		}
		prefix, suffix, ok := strings.Cut(host, "*")
		if !ok || suffix == "" {
			continue
		}
		allowlist.hostPatterns = append(allowlist.hostPatterns, oauthAllowedHostPattern{
			prefix: prefix,
			suffix: suffix,
		})
	}
	if len(allowlist.baseDomains) == 0 && len(allowlist.hostPatterns) == 0 && len(allowlist.origins) == 0 {
		return defaultOAuthReturnToAllowlist()
	}
	return allowlist
}

func readReturnToFromRequest(request *http.Request) string {
	if request == nil || request.URL == nil {
		return ""
	}
	return strings.TrimSpace(request.URL.Query().Get("return_to"))
}

func setOAuthReturnToCookie(ctx *gin.Context, cookieName string, cookiePath string, rawURL string, cookieSecure bool, ttl time.Duration, validate func(string) string) {
	if ctx == nil {
		return
	}
	if validate == nil {
		validate = validatedReturnToURL
	}
	validated := validate(rawURL)
	if validated == "" {
		clearOAuthReturnToCookie(ctx, cookieName, cookiePath, cookieSecure)
		return
	}
	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     cookieName,
		Value:    validated,
		Path:     cookiePath,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   cookieSecure,
		MaxAge:   int(ttl / time.Second),
	})
}

func clearOAuthReturnToCookie(ctx *gin.Context, cookieName string, cookiePath string, cookieSecure bool) {
	if ctx == nil {
		return
	}
	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     cookieName,
		Value:    "",
		Path:     cookiePath,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   cookieSecure,
		MaxAge:   -1,
	})
}

func readOAuthReturnToCookie(request *http.Request, cookieName string) string {
	if request == nil {
		return ""
	}
	cookie, err := request.Cookie(cookieName)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(cookie.Value)
}

func (h *Handler) readValidatedOAuthReturnToCookie(request *http.Request, cookieName string) string {
	if h == nil {
		return validatedReturnToURL(readOAuthReturnToCookie(request, cookieName))
	}
	return h.validatedReturnToURL(readOAuthReturnToCookie(request, cookieName))
}

func validatedReturnToURL(rawURL string) string {
	return validatedReturnToURLWithAllowlist(rawURL, defaultOAuthReturnToAllowlist())
}

func validatedReturnToURLWithAllowlist(rawURL string, allowlist oauthReturnToAllowlist) string {
	trimmed := strings.TrimSpace(rawURL)
	if trimmed == "" {
		return ""
	}

	parsed, err := url.Parse(trimmed)
	if err != nil {
		return ""
	}
	if parsed.User != nil || parsed.Opaque != "" {
		return ""
	}
	if isDeviceBindReturnTo(parsed.String()) {
		return parsed.String()
	}
	if isBrowserExtensionOAuthReturnTo(parsed) {
		return parsed.String()
	}
	if !isAllowedReturnToScheme(parsed.Scheme, parsed.Hostname(), parsed, allowlist) {
		return ""
	}

	host := strings.ToLower(strings.TrimSpace(parsed.Hostname()))
	if host == "" || (!isAllowedReturnToHost(host, allowlist) && !isAllowedReturnToOrigin(parsed, allowlist)) {
		return ""
	}

	return parsed.String()
}

func isAllowedReturnToHost(host string, allowlist oauthReturnToAllowlist) bool {
	normalized := strings.ToLower(strings.TrimSpace(host))
	if normalized == "" {
		return false
	}
	for _, baseDomain := range allowlist.baseDomains {
		base := strings.ToLower(strings.TrimSpace(baseDomain))
		if normalized == base || strings.HasSuffix(normalized, "."+base) {
			return true
		}
	}
	for _, pattern := range allowlist.hostPatterns {
		prefix := strings.ToLower(strings.TrimSpace(pattern.prefix))
		suffix := strings.ToLower(strings.TrimSpace(pattern.suffix))
		if suffix == "" {
			continue
		}
		if strings.HasPrefix(normalized, prefix) && strings.HasSuffix(normalized, suffix) {
			middle := strings.TrimSuffix(strings.TrimPrefix(normalized, prefix), suffix)
			if middle != "" {
				return true
			}
		}
	}
	return false
}

func isBrowserExtensionOAuthReturnTo(parsed *url.URL) bool {
	if parsed == nil {
		return false
	}
	if !strings.EqualFold(parsed.Scheme, "https") {
		return false
	}
	if parsed.Path != "/lightvela" {
		return false
	}
	host := strings.ToLower(strings.TrimSpace(parsed.Hostname()))
	if !strings.HasSuffix(host, ".chromiumapp.org") {
		return false
	}
	extensionID := strings.TrimSuffix(host, ".chromiumapp.org")
	if extensionID == "" || strings.Contains(extensionID, ".") {
		return false
	}
	for _, ch := range extensionID {
		if ch < 'a' || ch > 'z' {
			return false
		}
	}
	return true
}

func isAllowedReturnToScheme(scheme string, host string, parsed *url.URL, allowlist oauthReturnToAllowlist) bool {
	normalizedScheme := strings.ToLower(strings.TrimSpace(scheme))
	switch normalizedScheme {
	case "https":
		return true
	case "http":
		return isLoopbackHost(host) || isAllowedReturnToOrigin(parsed, allowlist)
	default:
		return false
	}
}

func isAllowedReturnToOrigin(parsed *url.URL, allowlist oauthReturnToAllowlist) bool {
	origin := normalizedReturnToParsedOrigin(parsed)
	if origin == "" {
		return false
	}
	for _, allowed := range allowlist.origins {
		if origin == allowed {
			return true
		}
	}
	return false
}

func normalizedReturnToOrigin(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	// Exact-origin allowlist entries are intended for sandbox-only HTTP
	// debugging endpoints such as http://<ip>:5173, not path-level redirects.
	if parsed.User != nil || parsed.Opaque != "" || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return ""
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return ""
	}
	return normalizedReturnToParsedOrigin(parsed)
}

func normalizedReturnToParsedOrigin(parsed *url.URL) string {
	if parsed == nil {
		return ""
	}
	scheme := strings.ToLower(strings.TrimSpace(parsed.Scheme))
	host := strings.ToLower(strings.TrimSpace(parsed.Host))
	if scheme == "" || host == "" {
		return ""
	}
	return scheme + "://" + host
}

func isLoopbackHost(host string) bool {
	normalized := strings.ToLower(strings.TrimSpace(host))
	switch normalized {
	case "localhost", "127.0.0.1", "::1":
		return true
	default:
		return false
	}
}

func appendSessionTokenToReturnTo(rawURL string, sessionToken string) string {
	redirectURL := strings.TrimSpace(rawURL)
	if redirectURL == "" || strings.TrimSpace(sessionToken) == "" {
		return redirectURL
	}

	parsed, err := url.Parse(redirectURL)
	if err != nil {
		return redirectURL
	}

	if parsed.Fragment == "" {
		fragment := url.Values{}
		fragment.Set("session_token", strings.TrimSpace(sessionToken))
		parsed.Fragment = fragment.Encode()
		return parsed.String()
	}

	if strings.Contains(parsed.Fragment, "=") || strings.Contains(parsed.Fragment, "&") {
		fragment, fragmentErr := url.ParseQuery(parsed.Fragment)
		if fragmentErr == nil {
			fragment.Set("session_token", strings.TrimSpace(sessionToken))
			parsed.Fragment = fragment.Encode()
			return parsed.String()
		}
	}

	parsed.Fragment = parsed.Fragment + "&session_token=" + url.QueryEscape(strings.TrimSpace(sessionToken))
	return parsed.String()
}

func oauthFrontendURL(baseURL string, path string) string {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if base == "" {
		return path
	}
	if strings.HasPrefix(path, "/") {
		return base + path
	}
	return base + "/" + path
}

func oauthSuccessFrontendURL(baseURL string, path string, sessionToken string) string {
	redirectURL := oauthFrontendURL(baseURL, path)
	if strings.TrimSpace(sessionToken) == "" {
		return redirectURL
	}

	parsed, err := url.Parse(redirectURL)
	if err != nil {
		return ""
	}
	if parsed.Scheme == "" && parsed.Host == "" && strings.HasPrefix(redirectURL, "/") {
		fragment := url.Values{}
		fragment.Set("session_token", strings.TrimSpace(sessionToken))
		parsed.Fragment = fragment.Encode()
		return parsed.String()
	}
	if parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.Opaque != "" {
		return ""
	}

	fragment := url.Values{}
	fragment.Set("session_token", strings.TrimSpace(sessionToken))
	parsed.Fragment = fragment.Encode()
	return parsed.String()
}

func appendQueryParamToReturnTo(rawURL string, name string, value string) string {
	redirectURL := strings.TrimSpace(rawURL)
	paramName := strings.TrimSpace(name)
	paramValue := strings.TrimSpace(value)
	if redirectURL == "" || paramName == "" || paramValue == "" {
		return redirectURL
	}

	parsed, err := url.Parse(redirectURL)
	if err != nil {
		return redirectURL
	}

	query := parsed.Query()
	query.Set(paramName, paramValue)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func (h *Handler) oauthSuccessRedirectURL(ctx *gin.Context, validatedSuccessTarget string, defaultRedirectURL string, session *service.AuthSession) string {
	if validatedSuccessTarget == "" {
		return defaultRedirectURL
	}
	if isDeviceBindReturnTo(validatedSuccessTarget) {
		token, expiresAt, err := h.deviceBindTokens.Issue(session, validatedSuccessTarget)
		if err != nil {
			if ctx != nil {
				requestLogger(ctx, nil).Error("issue device bind token failed", "err", err)
			}
			return appendOAuthErrorToReturnTo(validatedSuccessTarget, "device_bind_token_unavailable")
		}
		return appendDeviceBindTokenToReturnTo(validatedSuccessTarget, token, expiresAt)
	}
	if session == nil {
		return validatedSuccessTarget
	}
	return appendSessionTokenToReturnTo(validatedSuccessTarget, session.Token)
}

func (h *Handler) redirectOAuthSuccess(ctx *gin.Context, validatedSuccessTarget string, defaultRedirectURL string, session *service.AuthSession) {
	ctx.Redirect(http.StatusTemporaryRedirect, h.oauthSuccessRedirectURL(ctx, validatedSuccessTarget, defaultRedirectURL, session))
}

func appendOAuthErrorToReturnTo(rawURL string, code string) string {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return rawURL
	}
	query := parsed.Query()
	query.Set("oauth_error", strings.TrimSpace(code))
	parsed.RawQuery = query.Encode()
	parsed.Fragment = ""
	return parsed.String()
}
