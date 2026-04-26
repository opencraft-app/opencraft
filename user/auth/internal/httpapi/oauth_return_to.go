package httpapi

import (
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
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
}

func readReturnToFromRequest(request *http.Request) string {
	if request == nil || request.URL == nil {
		return ""
	}
	return strings.TrimSpace(request.URL.Query().Get("return_to"))
}

func setOAuthReturnToCookie(ctx *gin.Context, cookieName string, cookiePath string, rawURL string, cookieSecure bool, ttl time.Duration) {
	if ctx == nil {
		return
	}
	validated := validatedReturnToURL(rawURL)
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

func validatedReturnToURL(rawURL string) string {
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
	if !strings.EqualFold(parsed.Scheme, "https") {
		return ""
	}

	host := strings.ToLower(strings.TrimSpace(parsed.Hostname()))
	if host == "" || !isAllowedReturnToHost(host) {
		return ""
	}

	return parsed.String()
}

func isAllowedReturnToHost(host string) bool {
	normalized := strings.ToLower(strings.TrimSpace(host))
	if normalized == "" {
		return false
	}
	for _, baseDomain := range oauthReturnToAllowedBaseDomains {
		base := strings.ToLower(strings.TrimSpace(baseDomain))
		if normalized == base || strings.HasSuffix(normalized, "."+base) {
			return true
		}
	}
	for _, pattern := range oauthReturnToAllowedHostPatterns {
		prefix := strings.ToLower(strings.TrimSpace(pattern.prefix))
		suffix := strings.ToLower(strings.TrimSpace(pattern.suffix))
		if prefix == "" || suffix == "" {
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
