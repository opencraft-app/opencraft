package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

func TestQQOAuthStartRedirectsToAuthorizeAndSetsStateCookie(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithQQ(&stubQQOAuthClient{})

	recorder := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/qq/start", nil)
	if recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from qq oauth start, got %d: %s", recorder.Code, recorder.Body.String())
	}

	location := recorder.Header().Get("Location")
	if !strings.HasPrefix(location, "https://graph.qq.com/oauth2.0/authorize?") {
		t.Fatalf("expected qq authorize redirect, got %q", location)
	}

	parsed, err := url.Parse(location)
	if err != nil {
		t.Fatalf("parse redirect location: %v", err)
	}
	query := parsed.Query()
	if query.Get("client_id") != "1903611152" {
		t.Fatalf("expected qq app id in redirect, got %q", query.Get("client_id"))
	}
	if query.Get("redirect_uri") != "https://lightclaw.tech/auth/oauth/qq/callback" {
		t.Fatalf("expected redirect_uri in redirect, got %q", query.Get("redirect_uri"))
	}
	if query.Get("response_type") != "code" {
		t.Fatalf("expected response_type=code, got %q", query.Get("response_type"))
	}
	if query.Get("scope") != "get_user_info" {
		t.Fatalf("expected scope=get_user_info, got %q", query.Get("scope"))
	}
	if strings.TrimSpace(query.Get("state")) == "" {
		t.Fatal("expected state to be present in authorize redirect")
	}

	stateCookie := cookieFromRecorderByName(t, recorder, "lc_qq_oauth_state")
	if stateCookie.Value == "" {
		t.Fatal("expected oauth state cookie to be set")
	}
	if !stateCookie.HttpOnly {
		t.Fatal("expected oauth state cookie to be httpOnly")
	}
}

func TestWeChatOAuthStartSupportsOfficialAccountMode(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithWeChatApps(&stubWeChatOAuthClient{}, &stubWeChatOAuthClient{})

	recorder := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/wechat/start?mode=official_account", nil)
	if recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from wechat oauth start, got %d: %s", recorder.Code, recorder.Body.String())
	}

	location := recorder.Header().Get("Location")
	if !strings.HasPrefix(location, "https://open.weixin.qq.com/connect/oauth2/authorize?") {
		t.Fatalf("expected official account authorize redirect, got %q", location)
	}

	parsed, err := url.Parse(location)
	if err != nil {
		t.Fatalf("parse redirect location: %v", err)
	}
	query := parsed.Query()
	if query.Get("appid") != "wx-official-account" {
		t.Fatalf("expected official account app id in redirect, got %q", query.Get("appid"))
	}
	if query.Get("scope") != "snsapi_userinfo" {
		t.Fatalf("expected scope=snsapi_userinfo, got %q", query.Get("scope"))
	}
	if query.Get("redirect_uri") != "https://lightclaw.tech/auth/oauth/wechat/callback" {
		t.Fatalf("expected redirect_uri in redirect, got %q", query.Get("redirect_uri"))
	}

	modeCookie := cookieFromRecorderByName(t, recorder, wechatOAuthModeCookieName)
	if got := modeCookie.Value; got != string(wechatOAuthModeOfficialAccount) {
		t.Fatalf("expected official account mode cookie, got %q", got)
	}
}

func TestWeChatOAuthStartSupportsOfficialAccountBaseScope(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithWeChatApps(&stubWeChatOAuthClient{}, &stubWeChatOAuthClient{})

	recorder := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/wechat/start?mode=official_account&scope=base", nil)
	if recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from wechat oauth start, got %d: %s", recorder.Code, recorder.Body.String())
	}

	location := recorder.Header().Get("Location")
	parsed, err := url.Parse(location)
	if err != nil {
		t.Fatalf("parse redirect location: %v", err)
	}
	if got := parsed.Query().Get("scope"); got != "snsapi_base" {
		t.Fatalf("expected scope=snsapi_base, got %q", got)
	}
	scopeCookie := cookieFromRecorderByName(t, recorder, wechatOAuthScopeCookieName)
	if got := scopeCookie.Value; got != "snsapi_base" {
		t.Fatalf("expected base scope cookie, got %q", got)
	}
}

func TestWeChatOAuthStartDefaultsToOfficialAccountInsideWeChat(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithWeChatApps(&stubWeChatOAuthClient{}, &stubWeChatOAuthClient{})

	request := httptest.NewRequest(http.MethodGet, "/auth/oauth/wechat/start", nil)
	request.Header.Set("User-Agent", "Mozilla/5.0 iPhone MicroMessenger/8.0.49")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from wechat oauth start, got %d: %s", recorder.Code, recorder.Body.String())
	}
	location := recorder.Header().Get("Location")
	if !strings.HasPrefix(location, "https://open.weixin.qq.com/connect/oauth2/authorize?") {
		t.Fatalf("expected official account authorize redirect, got %q", location)
	}
}

func TestWeChatOAuthOfficialAccountBaseCallbackReturnsOpenIDToPaymentPage(t *testing.T) {
	t.Parallel()

	websiteClient := &stubWeChatOAuthClient{}
	officialAccountClient := &stubWeChatOAuthClient{}
	router := newAuthTestRouterWithWeChatApps(websiteClient, officialAccountClient)

	returnTo := "https://master.preview.lightclaw.tech/auth/wechat-pay?plan=lite#cashier"
	start := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/wechat/start?mode=official_account&scope=base&return_to="+url.QueryEscape(returnTo),
		nil,
	)
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	stateCookie := cookieFromRecorderByName(t, start, wechatOAuthStateCookieName)
	modeCookie := cookieFromRecorderByName(t, start, wechatOAuthModeCookieName)
	scopeCookie := cookieFromRecorderByName(t, start, wechatOAuthScopeCookieName)
	returnToCookie := cookieFromRecorderByName(t, start, wechatOAuthReturnToCookieName)

	callback := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/wechat/callback?code=pay-code-123&state="+url.QueryEscape(startLocation.Query().Get("state")),
		nil,
		stateCookie,
		modeCookie,
		scopeCookie,
		returnToCookie,
	)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from wechat oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}
	redirected, err := url.Parse(callback.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse callback location: %v", err)
	}
	if got := redirected.Query().Get("openid"); got != "openid-from-pay-code-123" {
		t.Fatalf("expected openid on payment return_to, got %q from %q", got, callback.Header().Get("Location"))
	}
	if got := redirected.Query().Get("plan"); got != "lite" {
		t.Fatalf("expected existing query to be preserved, got %q", got)
	}
	if redirected.Fragment != "cashier" {
		t.Fatalf("expected fragment to be preserved, got %q", redirected.Fragment)
	}
	if strings.Contains(callback.Header().Get("Location"), "session_token=") {
		t.Fatalf("payment OpenID callback must not expose session token: %q", callback.Header().Get("Location"))
	}
	if officialAccountClient.resolveCalls != 0 {
		t.Fatalf("base scope callback must not resolve login identity, got %d calls", officialAccountClient.resolveCalls)
	}
}

func TestWeChatOAuthCallbackUsesModeCookieClient(t *testing.T) {
	t.Parallel()

	websiteClient := &stubWeChatOAuthClient{}
	officialAccountClient := &stubWeChatOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "wechat",
			ProviderSubject: "unionid-official-account",
			Name:            "微信服务号用户",
		},
	}
	router := newAuthTestRouterWithWeChatApps(websiteClient, officialAccountClient)

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/wechat/start?mode=official_account", nil)
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	stateCookie := cookieFromRecorderByName(t, start, wechatOAuthStateCookieName)
	modeCookie := cookieFromRecorderByName(t, start, wechatOAuthModeCookieName)

	callback := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/wechat/callback?code=wechat-code-official&state="+url.QueryEscape(startLocation.Query().Get("state")),
		nil,
		stateCookie,
		modeCookie,
	)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from wechat oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}
	if websiteClient.exchangeCalls != 0 {
		t.Fatalf("expected website client not to exchange, got %d calls", websiteClient.exchangeCalls)
	}
	if officialAccountClient.exchangeCalls != 1 {
		t.Fatalf("expected official account client to exchange once, got %d calls", officialAccountClient.exchangeCalls)
	}
}

func TestWeChatOAuthStartRedirectsToAuthorizeAndSetsStateCookie(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithWeChat(&stubWeChatOAuthClient{})

	recorder := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/wechat/start", nil)
	if recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from wechat oauth start, got %d: %s", recorder.Code, recorder.Body.String())
	}

	location := recorder.Header().Get("Location")
	if !strings.HasPrefix(location, "https://open.weixin.qq.com/connect/qrconnect?") {
		t.Fatalf("expected wechat authorize redirect, got %q", location)
	}

	parsed, err := url.Parse(location)
	if err != nil {
		t.Fatalf("parse redirect location: %v", err)
	}
	query := parsed.Query()
	if query.Get("appid") != "wx622c70c4608a3b23" {
		t.Fatalf("expected wechat app id in redirect, got %q", query.Get("appid"))
	}
	if query.Get("redirect_uri") != "https://lightclaw.tech/auth/oauth/wechat/callback" {
		t.Fatalf("expected redirect_uri in redirect, got %q", query.Get("redirect_uri"))
	}
	if query.Get("response_type") != "code" {
		t.Fatalf("expected response_type=code, got %q", query.Get("response_type"))
	}
	if query.Get("scope") != "snsapi_login" {
		t.Fatalf("expected scope=snsapi_login, got %q", query.Get("scope"))
	}
	if strings.TrimSpace(query.Get("state")) == "" {
		t.Fatal("expected state to be present in authorize redirect")
	}
	if !strings.HasSuffix(location, "#wechat_redirect") {
		t.Fatalf("expected wechat redirect suffix, got %q", location)
	}

	stateCookie := cookieFromRecorderByName(t, recorder, "lc_wechat_oauth_state")
	if stateCookie.Value == "" {
		t.Fatal("expected oauth state cookie to be set")
	}
	if !stateCookie.HttpOnly {
		t.Fatal("expected oauth state cookie to be httpOnly")
	}
	modeCookie := cookieFromRecorderByName(t, recorder, wechatOAuthModeCookieName)
	if got := modeCookie.Value; got != string(wechatOAuthModeWebsite) {
		t.Fatalf("expected website mode cookie, got %q", got)
	}
}

func TestQQOAuthStartUsesSiteRedirectForSiteHost(t *testing.T) {
	t.Parallel()

	client := &stubQQOAuthClient{}
	router := newAuthTestRouterWithQQ(client)

	request := httptest.NewRequest(http.MethodGet, "/auth/oauth/qq/start", nil)
	request.Host = "api.lightclaw.site"
	request.Header.Set("X-Forwarded-Proto", "https")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from qq oauth start, got %d: %s", recorder.Code, recorder.Body.String())
	}

	location := recorder.Header().Get("Location")
	parsed, err := url.Parse(location)
	if err != nil {
		t.Fatalf("parse redirect location: %v", err)
	}
	if got := parsed.Query().Get("redirect_uri"); got != "https://api.lightclaw.site/auth/oauth/qq/callback" {
		t.Fatalf("expected site redirect_uri, got %q", got)
	}
}

func TestWeChatOAuthStartKeepsConfiguredRedirectForSiteHost(t *testing.T) {
	t.Parallel()

	client := &stubWeChatOAuthClient{}
	router := newAuthTestRouterWithWeChat(client)

	request := httptest.NewRequest(http.MethodGet, "/auth/oauth/wechat/start", nil)
	request.Host = "api.lightclaw.site"
	request.Header.Set("X-Forwarded-Proto", "https")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from wechat oauth start, got %d: %s", recorder.Code, recorder.Body.String())
	}

	location := recorder.Header().Get("Location")
	parsed, err := url.Parse(location)
	if err != nil {
		t.Fatalf("parse redirect location: %v", err)
	}
	if got := parsed.Query().Get("redirect_uri"); got != "https://lightclaw.tech/auth/oauth/wechat/callback" {
		t.Fatalf("expected configured redirect_uri, got %q", got)
	}
}

func TestWeChatOAuthStartKeepsConfiguredRedirectForAlternateAPIHost(t *testing.T) {
	t.Parallel()

	client := &stubWeChatOAuthClient{}
	router := newAuthTestRouterWithWeChat(client)

	request := httptest.NewRequest(http.MethodGet, "/auth/oauth/wechat/start", nil)
	request.Host = "api.lightvela.tencent.com"
	request.Header.Set("X-Forwarded-Proto", "https")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from wechat oauth start, got %d: %s", recorder.Code, recorder.Body.String())
	}

	location := recorder.Header().Get("Location")
	parsed, err := url.Parse(location)
	if err != nil {
		t.Fatalf("parse redirect location: %v", err)
	}
	if got := parsed.Query().Get("redirect_uri"); got != "https://lightclaw.tech/auth/oauth/wechat/callback" {
		t.Fatalf("expected configured redirect_uri, got %q", got)
	}
}

func TestQQOAuthStartSetsReturnToCookieWhenAllowed(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithQQ(&stubQQOAuthClient{})

	request := httptest.NewRequest(http.MethodGet, "/auth/oauth/qq/start?return_to="+url.QueryEscape("https://preview.foo.lightclaw.cn/dashboard/settings?tab=bot#wechat"), nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from qq oauth start, got %d: %s", recorder.Code, recorder.Body.String())
	}

	returnToCookie := cookieFromRecorderByName(t, recorder, qqOAuthReturnToCookieName)
	if got := returnToCookie.Value; got != "https://preview.foo.lightclaw.cn/dashboard/settings?tab=bot#wechat" {
		t.Fatalf("expected qq return_to cookie, got %q", got)
	}
}

func TestQQOAuthRelayUsesIssuerCallbackAndCreatesTargetSession(t *testing.T) {
	client := &stubQQOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "qq",
			ProviderSubject: "relay-openid",
			Name:            "QQ Relay User",
		},
	}
	router := newAuthTestRouterWithQQ(client)

	start := performOAuthRequest(
		t,
		router,
		"https://api-sandbox-bj-7.lightclaw.tech/auth/oauth/qq/start?relay_mode=issuer&issuer_redirect_uri="+
			url.QueryEscape("https://lightclaw.tech/auth/oauth/qq/callback")+
			"&return_to="+url.QueryEscape("https://intl-sandbox-bj-7.preview.lightclaw.tech/dashboard/settings"),
	)
	if start.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from qq relay start, got %d: %s", start.Code, start.Body.String())
	}
	authorizeURL, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse authorize url: %v", err)
	}
	if got := authorizeURL.Query().Get("redirect_uri"); got != "https://lightclaw.tech/auth/oauth/qq/callback" {
		t.Fatalf("expected issuer redirect_uri, got %q", got)
	}
	relayState, err := decodeOAuthRelayState(authorizeURL.Query().Get("state"))
	if err != nil {
		t.Fatalf("decode relay state: %v", err)
	}
	if relayState.TargetCallbackURI != "https://api-sandbox-bj-7.lightclaw.tech/auth/oauth/qq/callback" {
		t.Fatalf("unexpected target callback: %q", relayState.TargetCallbackURI)
	}
	stateCookie := cookieFromRecorderByName(t, start, qqOAuthStateCookieName)
	if stateCookie.Value != relayState.Nonce {
		t.Fatalf("expected state cookie nonce %q, got %q", relayState.Nonce, stateCookie.Value)
	}
	returnToCookie := cookieFromRecorderByName(t, start, qqOAuthReturnToCookieName)

	issuerCallback := performOAuthRequest(
		t,
		router,
		"https://lightclaw.tech/auth/oauth/qq/callback?code=qq-code-relay&state="+url.QueryEscape(authorizeURL.Query().Get("state")),
	)
	if issuerCallback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from issuer relay callback, got %d: %s", issuerCallback.Code, issuerCallback.Body.String())
	}
	if client.exchangeCalls != 0 {
		t.Fatalf("issuer relay callback must not exchange code, got %d calls", client.exchangeCalls)
	}
	targetURL, err := url.Parse(issuerCallback.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse relay target url: %v", err)
	}
	if targetURL.Host != "api-sandbox-bj-7.lightclaw.tech" || targetURL.Path != "/auth/oauth/qq/callback" {
		t.Fatalf("unexpected relay target: %q", targetURL.String())
	}
	if targetURL.Query().Get("code") != "qq-code-relay" || targetURL.Query().Get("state") != authorizeURL.Query().Get("state") {
		t.Fatalf("relay target did not preserve callback query: %q", targetURL.RawQuery)
	}

	targetCallback := performOAuthRequest(t, router, targetURL.String(), stateCookie, returnToCookie)
	if targetCallback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from target relay callback, got %d: %s", targetCallback.Code, targetCallback.Body.String())
	}
	if client.exchangeCalls != 1 {
		t.Fatalf("target callback should exchange code once, got %d calls", client.exchangeCalls)
	}
	if client.exchangeRedirectURI != "https://lightclaw.tech/auth/oauth/qq/callback" {
		t.Fatalf("expected target exchange to use issuer redirect uri, got %q", client.exchangeRedirectURI)
	}
	redirected, err := url.Parse(targetCallback.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse final redirect: %v", err)
	}
	if redirected.Scheme != "https" || redirected.Host != "intl-sandbox-bj-7.preview.lightclaw.tech" || redirected.Path != "/dashboard/settings" {
		t.Fatalf("unexpected final redirect: %q", redirected.String())
	}
	if !strings.Contains(redirected.Fragment, "session_token=") {
		t.Fatalf("expected session token fragment in final redirect, got %q", redirected.String())
	}
}

func TestWeChatOAuthRelayTargetExchangesWithIssuerRedirectURI(t *testing.T) {
	client := &stubWeChatOAuthClient{}
	router := newAuthTestRouterWithWeChat(client)
	state, err := encodeOAuthRelayState(oauthRelayState{
		Version:           1,
		Mode:              oauthRelayModeIssuer,
		Provider:          "wechat",
		Nonce:             "wechat-relay-nonce",
		IssuerRedirectURI: "https://lightclaw.tech/auth/oauth/wechat/callback",
		TargetCallbackURI: "https://api-sandbox-bj-7.lightclaw.tech/auth/oauth/wechat/callback",
	})
	if err != nil {
		t.Fatalf("encode relay state: %v", err)
	}
	callback := performOAuthRequest(
		t,
		router,
		"https://api-sandbox-bj-7.lightclaw.tech/auth/oauth/wechat/callback?code=wechat-code-relay&state="+url.QueryEscape(state),
		&http.Cookie{Name: wechatOAuthStateCookieName, Value: "wechat-relay-nonce"},
	)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from wechat relay target callback, got %d: %s", callback.Code, callback.Body.String())
	}
	if client.exchangeRedirectURI != "https://lightclaw.tech/auth/oauth/wechat/callback" {
		t.Fatalf("expected wechat exchange to use issuer redirect uri, got %q", client.exchangeRedirectURI)
	}
}

func TestWeChatOAuthStartSetsReturnToCookieWhenAllowed(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithWeChat(&stubWeChatOAuthClient{})

	request := httptest.NewRequest(http.MethodGet, "/auth/oauth/wechat/start?return_to="+url.QueryEscape("https://staging.lightvela.com/dashboard/settings?scene=wx#panel"), nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from wechat oauth start, got %d: %s", recorder.Code, recorder.Body.String())
	}

	returnToCookie := cookieFromRecorderByName(t, recorder, wechatOAuthReturnToCookieName)
	if got := returnToCookie.Value; got != "https://staging.lightvela.com/dashboard/settings?scene=wx#panel" {
		t.Fatalf("expected wechat return_to cookie, got %q", got)
	}
}

func TestPrepareInviteReturnsNoContentWithoutPersistingInviteCookie(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithQQ(&stubQQOAuthClient{})

	recorder := performJSONRequest(t, router, http.MethodPost, "/auth/invite/prepare", map[string]any{
		"code": "VALID2026",
	})
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("expected 204 from invite prepare, got %d: %s", recorder.Code, recorder.Body.String())
	}

	for _, cookie := range recorder.Result().Cookies() {
		if cookie.Name == "lc_invite_ticket" && cookie.Value != "" {
			t.Fatalf("expected invite prepare to avoid setting invite ticket cookie, got %+v", cookie)
		}
	}
}

func TestQQOAuthCallbackCreatesSessionAndRedirectsToDashboard(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithQQ(&stubQQOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "qq",
			ProviderSubject: "openid-qq-123",
			Name:            "QQ漫游者",
			AvatarURL:       "https://q.qlogo.cn/headimg_dl?dst_uin=10001&spec=640",
		},
	})

	prepare := performJSONRequest(t, router, http.MethodPost, "/auth/invite/prepare", map[string]any{
		"code": "VALID2026",
	})
	if prepare.Code != http.StatusNoContent {
		t.Fatalf("expected 204 from invite prepare, got %d: %s", prepare.Code, prepare.Body.String())
	}
	inviteCookie := cookieFromRecorderByName(t, prepare, "lc_invite_ticket")

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/qq/start", nil)
	if start.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from qq oauth start, got %d: %s", start.Code, start.Body.String())
	}

	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, "lc_qq_oauth_state")

	callback := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/qq/callback?code=qq-code-123&state="+url.QueryEscape(state),
		nil,
		stateCookie,
		inviteCookie,
	)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from qq oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}
	sessionCookie := sessionCookieFromRecorder(t, callback)
	location, err := url.Parse(callback.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse callback redirect location: %v", err)
	}
	if location.Scheme != "https" || location.Host != "lightclaw.pages.dev" || location.Path != "/" {
		t.Fatalf("expected callback redirect to frontend home, got %q", callback.Header().Get("Location"))
	}
	fragment := url.Values{}
	if location.Fragment != "" {
		fragment, err = url.ParseQuery(location.Fragment)
		if err != nil {
			t.Fatalf("parse callback redirect fragment: %v", err)
		}
	}
	if got := fragment.Get("session_token"); got != sessionCookie.Value {
		t.Fatalf("expected callback redirect fragment to include session token %q, got %q", sessionCookie.Value, got)
	}

	current := performJSONRequest(t, router, http.MethodGet, "/auth/session", nil, sessionCookie)
	if current.Code != http.StatusOK {
		t.Fatalf("expected 200 from current session, got %d: %s", current.Code, current.Body.String())
	}

	var response sessionResponseBody
	decodeJSONResponse(t, current, &response)
	if response.Session.User == nil || response.Session.User.Name != "QQ漫游者" {
		t.Fatalf("expected qq callback to create session for provider user, got %+v", response.Session.User)
	}
	if response.Session.PlanSelection != nil {
		t.Fatal("expected qq callback to land on an unconfirmed plan state")
	}
}

func TestQQOAuthCallbackRejectsNewRegistrationWhenDisabled(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithQQOptions(&stubQQOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "qq",
			ProviderSubject: "openid-qq-new-disabled",
			Name:            "QQ New User",
		},
	}, nil, true)

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/qq/start", nil)
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, qqOAuthStateCookieName)

	callback := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/qq/callback?code=qq-code-disabled&state="+url.QueryEscape(state),
		nil,
		stateCookie,
	)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from qq oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}
	if !strings.Contains(callback.Header().Get("Location"), "oauth_error=qq_registration_disabled") {
		t.Fatalf("expected qq_registration_disabled error in redirect, got %q", callback.Header().Get("Location"))
	}
}

func TestWeChatOAuthCallbackCreatesSessionAndRedirectsToDashboard(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithWeChat(&stubWeChatOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "wechat",
			ProviderSubject: "unionid-wechat-123",
			Name:            "微信漫游者",
			AvatarURL:       "https://wx.qlogo.cn/mmopen/g3MonUZtNHkdmzicIlib-avatar/132",
		},
	})

	prepare := performJSONRequest(t, router, http.MethodPost, "/auth/invite/prepare", map[string]any{
		"code": "VALID2026",
	})
	if prepare.Code != http.StatusNoContent {
		t.Fatalf("expected 204 from invite prepare, got %d: %s", prepare.Code, prepare.Body.String())
	}
	inviteCookie := cookieFromRecorderByName(t, prepare, "lc_invite_ticket")

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/wechat/start", nil)
	if start.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from wechat oauth start, got %d: %s", start.Code, start.Body.String())
	}

	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, "lc_wechat_oauth_state")

	callback := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/wechat/callback?code=wechat-code-123&state="+url.QueryEscape(state),
		nil,
		stateCookie,
		inviteCookie,
	)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from wechat oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}
	sessionCookie := sessionCookieFromRecorder(t, callback)
	location, err := url.Parse(callback.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse callback redirect location: %v", err)
	}
	if location.Scheme != "https" || location.Host != "lightclaw.pages.dev" || location.Path != "/" {
		t.Fatalf("expected callback redirect to frontend home, got %q", callback.Header().Get("Location"))
	}
	fragment := url.Values{}
	if location.Fragment != "" {
		fragment, err = url.ParseQuery(location.Fragment)
		if err != nil {
			t.Fatalf("parse callback redirect fragment: %v", err)
		}
	}
	if got := fragment.Get("session_token"); got != sessionCookie.Value {
		t.Fatalf("expected callback redirect fragment to include session token %q, got %q", sessionCookie.Value, got)
	}

	current := performJSONRequest(t, router, http.MethodGet, "/auth/session", nil, sessionCookie)
	if current.Code != http.StatusOK {
		t.Fatalf("expected 200 from current session, got %d: %s", current.Code, current.Body.String())
	}

	var response sessionResponseBody
	decodeJSONResponse(t, current, &response)
	if response.Session.User == nil || response.Session.User.Name != "微信漫游者" {
		t.Fatalf("expected wechat callback to create session for provider user, got %+v", response.Session.User)
	}
	if response.Session.PlanSelection != nil {
		t.Fatal("expected wechat callback to land on an unconfirmed plan state")
	}
}

func TestWeChatOAuthCallbackRejectsMissingUnionID(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithWeChat(&stubWeChatOAuthClient{
		resolveErr: errors.New("wechat unionid missing"),
	})

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/wechat/start", nil)
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, "lc_wechat_oauth_state")

	callback := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/wechat/callback?code=wechat-code-openid&state="+url.QueryEscape(state),
		nil,
		stateCookie,
	)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from wechat oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}

	location, err := url.Parse(callback.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse callback redirect location: %v", err)
	}
	if got := location.Query().Get("oauth_error"); got != "wechat_identity_failed" {
		t.Fatalf("expected wechat_identity_failed, got %q from %q", got, callback.Header().Get("Location"))
	}
}

func TestWeChatOAuthCallbackSignsInUsableUserForFirstTimeSignIn(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithWeChat(&stubWeChatOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "wechat",
			ProviderSubject: "openid-wechat-require-invite",
			Name:            "微信新人",
		},
	})

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/wechat/start", nil)
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, "lc_wechat_oauth_state")

	callback := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/wechat/callback?code=wechat-code-missing-invite&state="+url.QueryEscape(state),
		nil,
		stateCookie,
	)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from wechat oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}
	location := callback.Header().Get("Location")
	parsedLocation, err := url.Parse(location)
	if err != nil {
		t.Fatalf("parse callback redirect location: %v", err)
	}
	if parsedLocation.Scheme != "https" || parsedLocation.Host != "lightclaw.pages.dev" || parsedLocation.Path != "/" {
		t.Fatalf("expected callback redirect to frontend landing page, got %q", location)
	}
	if got := parsedLocation.Query().Get("oauth_error"); got != "" {
		t.Fatalf("expected no oauth_error for first-time wechat sign-in, got %q from %q", got, location)
	}
	if !strings.Contains(parsedLocation.Fragment, "session_token=") {
		t.Fatalf("expected wechat callback to return session token fragment, got %q", location)
	}

	sessionCookie := sessionCookieFromRecorder(t, callback)
	current := performJSONRequest(t, router, http.MethodGet, "/auth/session", nil, sessionCookie)
	if current.Code != http.StatusOK {
		t.Fatalf("expected 200 from current session, got %d: %s", current.Code, current.Body.String())
	}

	var response sessionResponseBody
	decodeJSONResponse(t, current, &response)
	if response.Session.User == nil || response.Session.User.InviteRequired {
		t.Fatalf("expected first-time wechat user to skip invite gating, got %+v", response.Session.User)
	}
}

func TestWeChatOAuthCallbackSyncsAvatarWhenUserHasNoUploadedAvatar(t *testing.T) {
	t.Parallel()

	avatarStore := &stubAvatarStore{
		objectKey: "avatars/usr_wechat/current.jpg",
	}
	router := newAuthTestRouterWithWeChatAndAvatarStore(&stubWeChatOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "wechat",
			ProviderSubject: "unionid-wechat-sync",
			Name:            "微信头像用户",
			AvatarURL:       "https://wx.qlogo.cn/mmopen/g3MonUZtNHkdmzicIlib-avatar-sync/132",
		},
	}, avatarStore)

	prepare := performJSONRequest(t, router, http.MethodPost, "/auth/invite/prepare", map[string]any{
		"code": "VALID2026",
	})
	if prepare.Code != http.StatusNoContent {
		t.Fatalf("expected 204 from invite prepare, got %d: %s", prepare.Code, prepare.Body.String())
	}
	inviteCookie := cookieFromRecorderByName(t, prepare, "lc_invite_ticket")

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/wechat/start", nil)
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, "lc_wechat_oauth_state")

	callback := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/wechat/callback?code=wechat-code-sync&state="+url.QueryEscape(state),
		nil,
		stateCookie,
		inviteCookie,
	)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from wechat oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}
	if avatarStore.lastRemoteUserID == "" {
		t.Fatal("expected wechat oauth callback to sync avatar into local storage")
	}
	if avatarStore.lastRemoteURL == "" {
		t.Fatal("expected wechat oauth callback to pass remote avatar url")
	}
}

func TestQQOAuthCallbackSignsInUsableUserForFirstTimeSignIn(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithQQ(&stubQQOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "qq",
			ProviderSubject: "openid-qq-require-invite",
			Name:            "QQ新人",
		},
	})

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/qq/start", nil)
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, "lc_qq_oauth_state")

	callback := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/qq/callback?code=qq-code-missing-invite&state="+url.QueryEscape(state),
		nil,
		stateCookie,
	)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from qq oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}
	location := callback.Header().Get("Location")
	parsedLocation, err := url.Parse(location)
	if err != nil {
		t.Fatalf("parse callback redirect location: %v", err)
	}
	if parsedLocation.Scheme != "https" || parsedLocation.Host != "lightclaw.pages.dev" || parsedLocation.Path != "/" {
		t.Fatalf("expected callback redirect to frontend landing page, got %q", location)
	}
	if got := parsedLocation.Query().Get("oauth_error"); got != "" {
		t.Fatalf("expected no oauth_error for first-time qq sign-in, got %q from %q", got, location)
	}
	if !strings.Contains(parsedLocation.Fragment, "session_token=") {
		t.Fatalf("expected qq callback to return session token fragment, got %q", location)
	}

	sessionCookie := sessionCookieFromRecorder(t, callback)
	current := performJSONRequest(t, router, http.MethodGet, "/auth/session", nil, sessionCookie)
	if current.Code != http.StatusOK {
		t.Fatalf("expected 200 from current session, got %d: %s", current.Code, current.Body.String())
	}

	var response sessionResponseBody
	decodeJSONResponse(t, current, &response)
	if response.Session.User == nil || response.Session.User.InviteRequired {
		t.Fatalf("expected first-time qq user to skip invite gating, got %+v", response.Session.User)
	}
}

func TestQQOAuthCallbackRedirectsBackToSiteFrontend(t *testing.T) {
	t.Parallel()

	client := &stubQQOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "qq",
			ProviderSubject: "openid-qq-site",
			Name:            "QQ站点用户",
		},
	}
	router := newAuthTestRouterWithQQ(client)

	prepare := performJSONRequest(t, router, http.MethodPost, "/auth/invite/prepare", map[string]any{
		"code": "VALID2026",
	})
	inviteCookie := cookieFromRecorderByName(t, prepare, "lc_invite_ticket")

	startReq := httptest.NewRequest(http.MethodGet, "/auth/oauth/qq/start", nil)
	startReq.Host = "api.lightclaw.site"
	startReq.Header.Set("X-Forwarded-Proto", "https")
	startRecorder := httptest.NewRecorder()
	router.ServeHTTP(startRecorder, startReq)
	if startRecorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from qq oauth start, got %d: %s", startRecorder.Code, startRecorder.Body.String())
	}
	startLocation, err := url.Parse(startRecorder.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, startRecorder, "lc_qq_oauth_state")

	callbackReq := httptest.NewRequest(http.MethodGet, "/auth/oauth/qq/callback?code=qq-code-site&state="+url.QueryEscape(state), nil)
	callbackReq.Host = "api.lightclaw.site"
	callbackReq.Header.Set("X-Forwarded-Proto", "https")
	callbackReq.AddCookie(stateCookie)
	callbackReq.AddCookie(inviteCookie)
	callbackRecorder := httptest.NewRecorder()
	router.ServeHTTP(callbackRecorder, callbackReq)

	if callbackRecorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from qq oauth callback, got %d: %s", callbackRecorder.Code, callbackRecorder.Body.String())
	}

	location, err := url.Parse(callbackRecorder.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse callback redirect location: %v", err)
	}
	if location.Scheme != "https" || location.Host != "lightclaw.site" || location.Path != "/" {
		t.Fatalf("expected callback redirect to site frontend home, got %q", callbackRecorder.Header().Get("Location"))
	}
}

func TestQQOAuthCallbackPrefersReturnToRedirect(t *testing.T) {
	t.Parallel()

	client := &stubQQOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "qq",
			ProviderSubject: "openid-qq-return-to",
			Name:            "QQ回跳用户",
		},
	}
	router := newAuthTestRouterWithQQ(client)

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/qq/start?return_to="+url.QueryEscape("https://preview.foo.lightclaw.cn/dashboard/settings?tab=bot#wechat"), nil)
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, qqOAuthStateCookieName)
	returnToCookie := cookieFromRecorderByName(t, start, qqOAuthReturnToCookieName)

	callback := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/qq/callback?code=qq-code-return&state="+url.QueryEscape(state), nil, stateCookie, returnToCookie)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from qq oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}

	location, err := url.Parse(callback.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse callback redirect location: %v", err)
	}
	if location.Host != "preview.foo.lightclaw.cn" || location.Path != "/dashboard/settings" || location.RawQuery != "tab=bot" {
		t.Fatalf("expected qq callback to use return_to, got %q", callback.Header().Get("Location"))
	}
	fragment, err := url.ParseQuery(location.Fragment)
	if err != nil {
		t.Fatalf("parse callback redirect fragment: %v", err)
	}
	if fragment.Get("session_token") == "" {
		t.Fatal("expected session_token in qq return_to redirect fragment")
	}
}

func TestQQOAuthCallbackPrefersEdgeOneReturnToRedirect(t *testing.T) {
	t.Parallel()

	client := &stubQQOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "qq",
			ProviderSubject: "openid-qq-edgeone-return-to",
			Name:            "QQ EdgeOne回跳用户",
		},
	}
	router := newAuthTestRouterWithQQ(client)

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/qq/start?return_to="+url.QueryEscape("https://lightvela-preview.edgeone.cool/dashboard/settings?tab=bot#wechat"), nil)
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, qqOAuthStateCookieName)
	returnToCookie := cookieFromRecorderByName(t, start, qqOAuthReturnToCookieName)

	callback := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/qq/callback?code=qq-code-edgeone-return&state="+url.QueryEscape(state), nil, stateCookie, returnToCookie)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from qq oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}

	location, err := url.Parse(callback.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse callback redirect location: %v", err)
	}
	if location.Host != "lightvela-preview.edgeone.cool" || location.Path != "/dashboard/settings" || location.RawQuery != "tab=bot" {
		t.Fatalf("expected qq callback to use edgeone return_to, got %q", callback.Header().Get("Location"))
	}
	fragment, err := url.ParseQuery(location.Fragment)
	if err != nil {
		t.Fatalf("parse callback redirect fragment: %v", err)
	}
	if fragment.Get("session_token") == "" {
		t.Fatal("expected session_token in qq edgeone return_to redirect fragment")
	}
}

func TestQQOAuthStartSetsReturnToCookieWhenPagesWildcardConfigured(t *testing.T) {
	t.Parallel()

	client := &stubQQOAuthClient{}
	gin.SetMode(gin.TestMode)
	store := service.NewMemoryStore(service.StoreOptions{
		Now:                fixedHTTPTestNow,
		SeedDefaultInvites: true,
	})
	svc := service.NewWithStore(store, service.Options{
		Now:        fixedHTTPTestNow,
		SessionTTL: 30 * 24 * time.Hour,
	})
	router := NewRouter(svc, ServerConfig{
		CookieSecure:              true,
		CookieSameSite:            http.SameSiteNoneMode,
		SessionTTL:                30 * 24 * time.Hour,
		OAuthReturnToAllowedHosts: []string{"*.pages.dev"},
		QQOAuth: &QQOAuthConfig{
			AppID:           "1903611152",
			AppKey:          "test-app-key",
			RedirectURI:     "https://lightclaw.tech/auth/oauth/qq/callback",
			FrontendBaseURL: "https://lightclaw.pages.dev",
			PublicBaseURL:   "https://lightclaw.tech",
			Client:          client,
			StateTTL:        10 * time.Minute,
		},
	})

	request := httptest.NewRequest(http.MethodGet, "/auth/oauth/qq/start?return_to="+url.QueryEscape("https://preview.foo.pages.dev/dashboard/settings?tab=bot#wechat"), nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from qq oauth start, got %d: %s", recorder.Code, recorder.Body.String())
	}
	returnToCookie := cookieFromRecorderByName(t, recorder, qqOAuthReturnToCookieName)
	if got := returnToCookie.Value; got != "https://preview.foo.pages.dev/dashboard/settings?tab=bot#wechat" {
		t.Fatalf("expected qq return_to cookie for pages.dev wildcard, got %q", got)
	}
}

func TestQQOAuthStartSetsReturnToCookieWhenLocalhostAllowed(t *testing.T) {
	t.Parallel()

	client := &stubQQOAuthClient{}
	gin.SetMode(gin.TestMode)
	store := service.NewMemoryStore(service.StoreOptions{
		Now:                fixedHTTPTestNow,
		SeedDefaultInvites: true,
	})
	svc := service.NewWithStore(store, service.Options{
		Now:        fixedHTTPTestNow,
		SessionTTL: 30 * 24 * time.Hour,
	})
	router := NewRouter(svc, ServerConfig{
		CookieSecure:              true,
		CookieSameSite:            http.SameSiteNoneMode,
		SessionTTL:                30 * 24 * time.Hour,
		OAuthReturnToAllowedHosts: []string{"localhost", "127.0.0.1", "::1"},
		QQOAuth: &QQOAuthConfig{
			AppID:           "1903611152",
			AppKey:          "test-app-key",
			RedirectURI:     "https://lightclaw.tech/auth/oauth/qq/callback",
			FrontendBaseURL: "https://lightclaw.pages.dev",
			PublicBaseURL:   "https://lightclaw.tech",
			Client:          client,
			StateTTL:        10 * time.Minute,
		},
	})

	request := httptest.NewRequest(http.MethodGet, "/auth/oauth/qq/start?return_to="+url.QueryEscape("http://localhost:5173/auth/sign-in"), nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from qq oauth start, got %d: %s", recorder.Code, recorder.Body.String())
	}
	returnToCookie := cookieFromRecorderByName(t, recorder, qqOAuthReturnToCookieName)
	if got := returnToCookie.Value; got != "http://localhost:5173/auth/sign-in" {
		t.Fatalf("expected qq return_to cookie for localhost, got %q", got)
	}
}

func TestWeChatOAuthCallbackRedirectsBackToSiteFrontend(t *testing.T) {
	t.Parallel()

	client := &stubWeChatOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "wechat",
			ProviderSubject: "unionid-wechat-site",
			Name:            "微信站点用户",
		},
	}
	router := newAuthTestRouterWithWeChat(client)

	prepare := performJSONRequest(t, router, http.MethodPost, "/auth/invite/prepare", map[string]any{
		"code": "VALID2026",
	})
	inviteCookie := cookieFromRecorderByName(t, prepare, "lc_invite_ticket")

	startReq := httptest.NewRequest(http.MethodGet, "/auth/oauth/wechat/start", nil)
	startReq.Host = "api.lightclaw.site"
	startReq.Header.Set("X-Forwarded-Proto", "https")
	startRecorder := httptest.NewRecorder()
	router.ServeHTTP(startRecorder, startReq)
	if startRecorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from wechat oauth start, got %d: %s", startRecorder.Code, startRecorder.Body.String())
	}
	startLocation, err := url.Parse(startRecorder.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, startRecorder, "lc_wechat_oauth_state")

	callbackReq := httptest.NewRequest(http.MethodGet, "/auth/oauth/wechat/callback?code=wechat-code-site&state="+url.QueryEscape(state), nil)
	callbackReq.Host = "api.lightclaw.site"
	callbackReq.Header.Set("X-Forwarded-Proto", "https")
	callbackReq.AddCookie(stateCookie)
	callbackReq.AddCookie(inviteCookie)
	callbackRecorder := httptest.NewRecorder()
	router.ServeHTTP(callbackRecorder, callbackReq)

	if callbackRecorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from wechat oauth callback, got %d: %s", callbackRecorder.Code, callbackRecorder.Body.String())
	}

	location, err := url.Parse(callbackRecorder.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse callback redirect location: %v", err)
	}
	if location.Scheme != "https" || location.Host != "lightclaw.site" || location.Path != "/" {
		t.Fatalf("expected callback redirect to site frontend home, got %q", callbackRecorder.Header().Get("Location"))
	}
}

func TestWeChatOAuthCallbackPrefersReturnToRedirect(t *testing.T) {
	t.Parallel()

	client := &stubWeChatOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "wechat",
			ProviderSubject: "unionid-wechat-return-to",
			Name:            "微信回跳用户",
		},
	}
	router := newAuthTestRouterWithWeChat(client)

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/wechat/start?return_to="+url.QueryEscape("https://staging.lightvela.com/dashboard/settings?scene=wx#panel"), nil)
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, wechatOAuthStateCookieName)
	returnToCookie := cookieFromRecorderByName(t, start, wechatOAuthReturnToCookieName)

	callback := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/wechat/callback?code=wechat-code-return&state="+url.QueryEscape(state), nil, stateCookie, returnToCookie)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from wechat oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}

	location, err := url.Parse(callback.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse callback redirect location: %v", err)
	}
	if location.Host != "staging.lightvela.com" || location.Path != "/dashboard/settings" || location.RawQuery != "scene=wx" {
		t.Fatalf("expected wechat callback to use return_to, got %q", callback.Header().Get("Location"))
	}
	fragment, err := url.ParseQuery(location.Fragment)
	if err != nil {
		t.Fatalf("parse callback redirect fragment: %v", err)
	}
	if fragment.Get("session_token") == "" {
		t.Fatal("expected session_token in wechat return_to redirect fragment")
	}
}

func TestQQOAuthCallbackSyncsAvatarWhenUserHasNoUploadedAvatar(t *testing.T) {
	t.Parallel()

	avatarStore := &stubAvatarStore{
		objectKey: "avatars/usr_qq/current.jpg",
	}
	router := newAuthTestRouterWithQQAndAvatarStore(&stubQQOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "qq",
			ProviderSubject: "openid-qq-sync",
			Name:            "QQ头像用户",
			AvatarURL:       "https://q.qlogo.cn/headimg_dl?dst_uin=10001&spec=640",
		},
	}, avatarStore)

	prepare := performJSONRequest(t, router, http.MethodPost, "/auth/invite/prepare", map[string]any{
		"code": "VALID2026",
	})
	if prepare.Code != http.StatusNoContent {
		t.Fatalf("expected 204 from invite prepare, got %d: %s", prepare.Code, prepare.Body.String())
	}
	inviteCookie := cookieFromRecorderByName(t, prepare, "lc_invite_ticket")

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/qq/start", nil)
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, "lc_qq_oauth_state")

	callback := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/qq/callback?code=qq-code-sync&state="+url.QueryEscape(state),
		nil,
		stateCookie,
		inviteCookie,
	)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from qq oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}
	if avatarStore.lastRemoteUserID == "" {
		t.Fatal("expected qq oauth callback to sync avatar into local storage")
	}
	if avatarStore.lastRemoteURL == "" {
		t.Fatal("expected qq oauth callback to pass remote avatar url")
	}
}

func TestQQOAuthCallbackIgnoresExistingSessionAndSignsInReturningQQUser(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithQQ(&stubQQOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "qq",
			ProviderSubject: "openid-qq-returning-user",
			Name:            "已注册QQ用户",
		},
	})

	prepare := performJSONRequest(t, router, http.MethodPost, "/auth/invite/prepare", map[string]any{
		"code": "VALID2026",
	})
	if prepare.Code != http.StatusNoContent {
		t.Fatalf("expected 204 from invite prepare, got %d: %s", prepare.Code, prepare.Body.String())
	}
	inviteCookie := cookieFromRecorderByName(t, prepare, "lc_invite_ticket")

	firstStart := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/qq/start", nil)
	firstStartLocation, err := url.Parse(firstStart.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse first start location: %v", err)
	}
	firstState := firstStartLocation.Query().Get("state")
	firstStateCookie := cookieFromRecorderByName(t, firstStart, "lc_qq_oauth_state")

	firstCallback := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/qq/callback?code=qq-code-first&state="+url.QueryEscape(firstState),
		nil,
		firstStateCookie,
		inviteCookie,
	)
	if firstCallback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from first qq oauth callback, got %d: %s", firstCallback.Code, firstCallback.Body.String())
	}

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/qq/start", nil)
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, "lc_qq_oauth_state")
	staleSessionCookie := &http.Cookie{
		Name:  "lc_session",
		Value: "stale-session-token",
		Path:  "/",
	}

	callback := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/qq/callback?code=qq-code-bind-existing&state="+url.QueryEscape(state),
		nil,
		stateCookie,
		staleSessionCookie,
	)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from qq oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}
	location, err := url.Parse(callback.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse callback redirect location: %v", err)
	}
	if location.Path != "/" {
		t.Fatalf("expected returning qq callback to redirect to home, got %q", callback.Header().Get("Location"))
	}
	if strings.Contains(callback.Header().Get("Location"), "invite_required") {
		t.Fatalf("expected returning qq callback not to require invite, got %q", callback.Header().Get("Location"))
	}
}

type stubQQOAuthClient struct {
	identity            service.OAuthSignInInput
	exchangeRedirectURI string
	exchangeCalls       int
}

func (s *stubQQOAuthClient) ExchangeCode(_ context.Context, code string, redirectURI string) (*QQOAuthToken, error) {
	s.exchangeCalls++
	s.exchangeRedirectURI = strings.TrimSpace(redirectURI)
	return &QQOAuthToken{
		AccessToken: "qq-access-token-" + strings.TrimSpace(code),
		ExpiresIn:   5184000,
	}, nil
}

func (s *stubQQOAuthClient) ResolveIdentity(_ context.Context, accessToken string) (service.OAuthSignInInput, error) {
	identity := s.identity
	if identity.Provider == "" {
		identity.Provider = "qq"
	}
	if identity.ProviderSubject == "" {
		identity.ProviderSubject = "openid-from-" + accessToken
	}
	if identity.Name == "" {
		identity.Name = "QQ用户"
	}
	return identity, nil
}

type stubWeChatOAuthClient struct {
	identity            service.OAuthSignInInput
	resolveErr          error
	exchangeRedirectURI string
	exchangeCalls       int
	resolveCalls        int
}

func (s *stubWeChatOAuthClient) ExchangeCode(_ context.Context, code string, redirectURI string) (*WeChatOAuthToken, error) {
	s.exchangeCalls++
	s.exchangeRedirectURI = strings.TrimSpace(redirectURI)
	return &WeChatOAuthToken{
		AccessToken:  "wechat-access-token-" + strings.TrimSpace(code),
		RefreshToken: "wechat-refresh-token-" + strings.TrimSpace(code),
		ExpiresIn:    7200,
		OpenID:       "openid-from-" + strings.TrimSpace(code),
		Scope:        "snsapi_login",
		UnionID:      "",
	}, nil
}

func (s *stubWeChatOAuthClient) ResolveIdentity(_ context.Context, _ *WeChatOAuthToken) (service.OAuthSignInInput, error) {
	s.resolveCalls++
	if s.resolveErr != nil {
		return service.OAuthSignInInput{}, s.resolveErr
	}
	identity := s.identity
	if identity.Provider == "" {
		identity.Provider = "wechat"
	}
	if identity.ProviderSubject == "" {
		identity.ProviderSubject = "openid-wechat-default"
	}
	if identity.Name == "" {
		identity.Name = "微信用户"
	}
	return identity, nil
}

func newAuthTestRouterWithQQ(client QQOAuthClient) *gin.Engine {
	return newAuthTestRouterWithQQAndAvatarStore(client, nil)
}

func newAuthTestRouterWithQQAndAvatarStore(client QQOAuthClient, avatarStore AvatarStore) *gin.Engine {
	return newAuthTestRouterWithQQOptions(client, avatarStore, false)
}

func newAuthTestRouterWithQQOptions(client QQOAuthClient, avatarStore AvatarStore, registrationDisabled bool) *gin.Engine {
	gin.SetMode(gin.TestMode)
	store := service.NewMemoryStore(service.StoreOptions{
		Now:                fixedHTTPTestNow,
		SeedDefaultInvites: true,
	})
	svc := service.NewWithStore(store, service.Options{
		Now:        fixedHTTPTestNow,
		SessionTTL: 30 * 24 * time.Hour,
	})
	return NewRouter(svc, ServerConfig{
		CookieSecure:   true,
		CookieSameSite: http.SameSiteNoneMode,
		SessionTTL:     30 * 24 * time.Hour,
		AvatarStore:    avatarStore,
		QQOAuth: &QQOAuthConfig{
			AppID:                "1903611152",
			AppKey:               "test-app-key",
			RedirectURI:          "https://lightclaw.tech/auth/oauth/qq/callback",
			FrontendBaseURL:      "https://lightclaw.pages.dev",
			PublicBaseURL:        "https://lightclaw.tech",
			Client:               client,
			StateTTL:             10 * time.Minute,
			RegistrationDisabled: registrationDisabled,
		},
	})
}

func newAuthTestRouterWithWeChat(client WeChatOAuthClient) *gin.Engine {
	return newAuthTestRouterWithWeChatAndAvatarStore(client, nil)
}

func newAuthTestRouterWithWeChatAndAvatarStore(client WeChatOAuthClient, avatarStore AvatarStore) *gin.Engine {
	return newAuthTestRouterWithWeChatAppsAndAvatarStore(client, nil, avatarStore)
}

func newAuthTestRouterWithWeChatApps(websiteClient WeChatOAuthClient, officialAccountClient WeChatOAuthClient) *gin.Engine {
	return newAuthTestRouterWithWeChatAppsAndAvatarStore(websiteClient, officialAccountClient, nil)
}

func newAuthTestRouterWithWeChatAppsAndAvatarStore(websiteClient WeChatOAuthClient, officialAccountClient WeChatOAuthClient, avatarStore AvatarStore) *gin.Engine {
	gin.SetMode(gin.TestMode)
	store := service.NewMemoryStore(service.StoreOptions{
		Now:                fixedHTTPTestNow,
		SeedDefaultInvites: true,
	})
	svc := service.NewWithStore(store, service.Options{
		Now:        fixedHTTPTestNow,
		SessionTTL: 30 * 24 * time.Hour,
	})
	wechatConfig := &WeChatOAuthConfig{
		Website: WeChatOAuthAppConfig{
			AppID:       "wx622c70c4608a3b23",
			AppSecret:   "wechat-app-secret",
			RedirectURI: "https://lightclaw.tech/auth/oauth/wechat/callback",
			Client:      websiteClient,
		},
		FrontendBaseURL: "https://lightclaw.pages.dev",
		PublicBaseURL:   "https://lightclaw.tech",
		StateTTL:        10 * time.Minute,
	}
	if officialAccountClient != nil {
		wechatConfig.OfficialAccount = WeChatOAuthAppConfig{
			AppID:       "wx-official-account",
			AppSecret:   "wechat-official-account-secret",
			RedirectURI: "https://lightclaw.tech/auth/oauth/wechat/callback",
			Client:      officialAccountClient,
		}
	}
	return NewRouter(svc, ServerConfig{
		CookieSecure:   true,
		CookieSameSite: http.SameSiteNoneMode,
		SessionTTL:     30 * 24 * time.Hour,
		AvatarStore:    avatarStore,
		WeChatOAuth:    wechatConfig,
	})
}

func cookieFromRecorderByName(t *testing.T, recorder *httptest.ResponseRecorder, name string) *http.Cookie {
	t.Helper()

	resp := recorder.Result()
	t.Cleanup(func() { _ = resp.Body.Close() })
	for _, cookie := range resp.Cookies() {
		if cookie.Name == name {
			return cookie
		}
	}
	t.Fatalf("cookie %q not found", name)
	return nil
}

func performOAuthRequest(t *testing.T, router http.Handler, rawURL string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, rawURL, nil)
	for _, cookie := range cookies {
		req.AddCookie(cookie)
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)
	return recorder
}
