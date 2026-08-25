package dshproxy

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono/site-gateway/internal/tatproxy"
	"github.com/gorilla/websocket"
)

type directDialer struct {
	address string
	onDial  func(tatproxy.Target)
}

type lifecycleDialer struct {
	closed chan tatproxy.Target
}

type fakeFederation struct {
	clientID  string
	states    map[string]tatproxy.LoginState
	session   tatproxy.DelegatedSession
	exchanges []exchangeCall
}

type exchangeCall struct {
	ticket      string
	redirectURI string
}

var testDSHDomains = []string{"dsh.lightvela.site", "dsh.lightvela.tech"}

const testBotHost = "bot-1.dsh.lightvela.site"

func (f *fakeFederation) ClientID() string { return f.clientID }

func (f *fakeFederation) SealLoginState(host, returnTo, state string, ttl time.Duration) (string, error) {
	if ttl != loginStateTTL {
		return "", errors.New("unexpected login TTL")
	}
	raw, _ := json.Marshal(tatproxy.LoginState{Host: host, ReturnTo: returnTo, State: state, ExpiresAt: time.Now().Add(ttl).Unix()})
	sealed := base64.RawURLEncoding.EncodeToString(raw)
	if f.states == nil {
		f.states = make(map[string]tatproxy.LoginState)
	}
	f.states[sealed] = tatproxy.LoginState{Host: host, ReturnTo: returnTo, State: state, ExpiresAt: time.Now().Add(ttl).Unix()}
	return sealed, nil
}

func (f *fakeFederation) OpenLoginState(raw, expectedHost string) (tatproxy.LoginState, error) {
	state, ok := f.states[raw]
	if !ok || state.Host != expectedHost || state.ExpiresAt < time.Now().Unix() {
		return tatproxy.LoginState{}, tatproxy.ErrFederationUnauthorized
	}
	return state, nil
}

func (f *fakeFederation) Exchange(_ context.Context, ticket, redirectURI string) (tatproxy.DelegatedSession, error) {
	f.exchanges = append(f.exchanges, exchangeCall{ticket: ticket, redirectURI: redirectURI})
	if ticket != "ticket-1" {
		return tatproxy.DelegatedSession{}, tatproxy.ErrFederationUnauthorized
	}
	return f.session, nil
}

func (d *lifecycleDialer) DialContext(context.Context, tatproxy.Target) (net.Conn, error) {
	return nil, errors.New("not used")
}

func (d *lifecycleDialer) CloseTarget(target tatproxy.Target) {
	d.closed <- target
}

func (d directDialer) DialContext(ctx context.Context, target tatproxy.Target) (net.Conn, error) {
	if d.onDial != nil {
		d.onDial(target)
	}
	var dialer net.Dialer
	return dialer.DialContext(ctx, "tcp", d.address)
}

func newTestHandler(t *testing.T, dialer TunnelDialer, federation *fakeFederation) *Handler {
	t.Helper()
	handler, err := NewHandler(HandlerOptions{
		Dialer: dialer, Domains: testDSHDomains, MaxTargets: 2, IdleTTL: time.Minute, Federation: federation,
		AuthorizeURL: "https://frontend.example/auth/federation/authorize",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(handler.Close)
	return handler
}

func TestHandlerRedirectsUnauthenticatedBrowserAndIgnoresInjectedHeaders(t *testing.T) {
	dialed := false
	federation := &fakeFederation{clientID: "dsh-site-gateway"}
	handler := newTestHandler(t, directDialer{address: "127.0.0.1:1", onDial: func(tatproxy.Target) { dialed = true }}, federation)
	req := httptest.NewRequest(http.MethodGet, "https://"+testBotHost+"/api/chat?q=1", nil)
	req.Header.Set(HeaderBotID, "bot-1")
	req.Header.Set(HeaderDelegatedSession, "injected-session")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusFound || dialed {
		t.Fatalf("response=%d dialed=%v", rec.Code, dialed)
	}
	if req.Header.Get(HeaderBotID) != "" || req.Header.Get(HeaderDelegatedSession) != "" {
		t.Fatal("browser supplied headers were not stripped")
	}
	location, err := url.Parse(rec.Result().Header.Get("Location"))
	if err != nil || location.Scheme != "https" || location.Host != "frontend.example" || location.Path != "/auth/federation/authorize" {
		t.Fatalf("authorize redirect = %q", rec.Result().Header.Get("Location"))
	}
	if location.Query().Get("client_id") != "dsh-site-gateway" || location.Query().Get("redirect_uri") != "https://"+testBotHost+federationCallbackPath || location.Query().Get("state") == "" {
		t.Fatalf("authorize query = %q", location.RawQuery)
	}
	stateCookie := onlyCookie(t, rec.Result().Cookies(), loginStateCookieName)
	if stateCookie.Domain != "" || stateCookie.Path != "/" || !stateCookie.Secure || !stateCookie.HttpOnly || stateCookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("state cookie = %+v", stateCookie)
	}
}

func TestHandlerCallbackSetsHostOnlyCookieAndProxiesWithCookieTarget(t *testing.T) {
	federation := &fakeFederation{clientID: "dsh-site-gateway", session: tatproxy.DelegatedSession{Value: "delegated-cookie", ExpiresAt: time.Now().Add(time.Hour)}}
	login := newTestHandler(t, directDialer{address: "127.0.0.1:1"}, federation)
	loginReq := httptest.NewRequest(http.MethodGet, "https://"+testBotHost+"/api/chat?q=1", nil)
	loginRec := httptest.NewRecorder()
	login.ServeHTTP(loginRec, loginReq)
	stateCookie := onlyCookie(t, loginRec.Result().Cookies(), loginStateCookieName)
	state := queryValue(t, loginRec.Result().Header.Get("Location"), "state")

	callbackReq := httptest.NewRequest(http.MethodGet, "https://"+testBotHost+federationCallbackPath+"?state="+url.QueryEscape(state)+"&ticket=ticket-1", nil)
	callbackReq.AddCookie(stateCookie)
	callbackRec := httptest.NewRecorder()
	login.ServeHTTP(callbackRec, callbackReq)
	if callbackRec.Code != http.StatusFound || callbackRec.Result().Header.Get("Location") != "/api/chat?q=1" {
		t.Fatalf("callback response=%d location=%q", callbackRec.Code, callbackRec.Result().Header.Get("Location"))
	}
	if len(federation.exchanges) != 1 || federation.exchanges[0] != (exchangeCall{ticket: "ticket-1", redirectURI: "https://" + testBotHost + federationCallbackPath}) {
		t.Fatalf("exchange calls = %+v", federation.exchanges)
	}
	delegated := onlyCookie(t, callbackRec.Result().Cookies(), delegatedSessionCookie)
	if delegated.Domain != "" || delegated.Path != "/" || !delegated.Secure || !delegated.HttpOnly || delegated.SameSite != http.SameSiteLaxMode || delegated.Expires.Before(time.Now().Add(30*time.Minute)) {
		t.Fatalf("delegated cookie = %+v", delegated)
	}

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "application=secret" || r.Header.Get("Authorization") != "Bearer secret" || r.Header.Get("Proxy-Authorization") != "" || r.Header.Get(HeaderBotID) != "" || r.Header.Get(HeaderDelegatedSession) != "" {
			t.Errorf("credentials reached DSH: headers=%v", r.Header)
		}
		if r.Host != remoteAddress || r.Header.Get("Origin") != "http://"+remoteAddress {
			t.Errorf("upstream host/origin=%q/%q", r.Host, r.Header.Get("Origin"))
		}
		_, _ = io.WriteString(w, "proxied")
	}))
	defer upstream.Close()
	var target tatproxy.Target
	proxy := newTestHandler(t, directDialer{address: strings.TrimPrefix(upstream.URL, "http://"), onDial: func(got tatproxy.Target) { target = got }}, federation)
	proxyReq := httptest.NewRequest(http.MethodGet, "https://"+testBotHost+"/api/chat", nil)
	proxyReq.AddCookie(delegated)
	proxyReq.AddCookie(&http.Cookie{Name: "application", Value: "secret"})
	proxyReq.Header.Set("Authorization", "Bearer secret")
	proxyReq.Header.Set("Proxy-Authorization", "Basic secret")
	proxyReq.Header.Set(HeaderBotID, "bot-2")
	proxyReq.Header.Set(HeaderDelegatedSession, "injected-session")
	proxyReq.Header.Set("Origin", "https://"+testBotHost)
	proxyRec := httptest.NewRecorder()
	proxy.ServeHTTP(proxyRec, proxyReq)
	if proxyRec.Code != http.StatusOK || proxyRec.Body.String() != "proxied" || target != (tatproxy.Target{BotID: "bot-1", DelegatedSession: "delegated-cookie"}) {
		t.Fatalf("proxy response=%d body=%q target=%+v", proxyRec.Code, proxyRec.Body.String(), target)
	}
}

func TestHandlerRejectsStateCookieOnDifferentDSHHost(t *testing.T) {
	federation := &fakeFederation{clientID: "dsh-site-gateway", session: tatproxy.DelegatedSession{Value: "delegated-cookie", ExpiresAt: time.Now().Add(time.Hour)}}
	handler := newTestHandler(t, directDialer{address: "127.0.0.1:1"}, federation)
	loginReq := httptest.NewRequest(http.MethodGet, "https://"+testBotHost+"/", nil)
	loginRec := httptest.NewRecorder()
	handler.ServeHTTP(loginRec, loginReq)
	stateCookie := onlyCookie(t, loginRec.Result().Cookies(), loginStateCookieName)
	state := queryValue(t, loginRec.Result().Header.Get("Location"), "state")
	callbackReq := httptest.NewRequest(http.MethodGet, "https://bot-2.dsh.lightvela.site"+federationCallbackPath+"?state="+url.QueryEscape(state)+"&ticket=ticket-1", nil)
	callbackReq.AddCookie(stateCookie)
	callbackRec := httptest.NewRecorder()

	handler.ServeHTTP(callbackRec, callbackReq)

	if callbackRec.Code != http.StatusUnauthorized || len(federation.exchanges) != 0 {
		t.Fatalf("callback response=%d exchanges=%d", callbackRec.Code, len(federation.exchanges))
	}
}

func TestHandlerRejectsNonSafeMethodsWithoutDelegatedCookie(t *testing.T) {
	handler := newTestHandler(t, directDialer{address: "127.0.0.1:1"}, &fakeFederation{clientID: "dsh-site-gateway"})
	req := httptest.NewRequest(http.MethodPost, "https://"+testBotHost+"/api/chat", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("response=%d", rec.Code)
	}
}

func TestHandlerProxiesWebSocketWithDelegatedCookie(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	observed := make(chan http.Header, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		observed <- r.Header.Clone()
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		messageType, data, err := conn.ReadMessage()
		if err == nil {
			_ = conn.WriteMessage(messageType, data)
		}
	}))
	defer upstream.Close()
	federation := &fakeFederation{clientID: "dsh-site-gateway"}
	handler := newTestHandler(t, directDialer{address: strings.TrimPrefix(upstream.URL, "http://")}, federation)
	proxy := httptest.NewServer(handler)
	defer proxy.Close()
	header := http.Header{"Host": []string{testBotHost}, "Origin": []string{"https://" + testBotHost}, "Cookie": []string{delegatedSessionCookie + "=delegated-cookie; application=ws"}}
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(proxy.URL, "http")+"/api/events.mux", header)
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer conn.Close()
	if err := conn.WriteMessage(websocket.TextMessage, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	_, data, err := conn.ReadMessage()
	if err != nil || string(data) != "hello" {
		t.Fatalf("websocket echo=%q err=%v", data, err)
	}
	upstreamHeader := <-observed
	if upstreamHeader.Get("Cookie") != "application=ws" || upstreamHeader.Get(HeaderBotID) != "" || upstreamHeader.Get(HeaderDelegatedSession) != "" || upstreamHeader.Get("Origin") != "http://"+remoteAddress {
		t.Fatalf("upstream context/origin=%q/%q/%q/%q", upstreamHeader.Get("Cookie"), upstreamHeader.Get(HeaderBotID), upstreamHeader.Get(HeaderDelegatedSession), upstreamHeader.Get("Origin"))
	}
}

func TestSafeReturnToRejectsEncodedExternalPaths(t *testing.T) {
	for _, raw := range []string{"//attacker.example", "/%2Fattacker.example", "/%252Fattacker.example", "/\\attacker.example"} {
		if got := safeReturnTo(raw); got != "/" {
			t.Fatalf("safeReturnTo(%q) = %q", raw, got)
		}
	}
	if got := safeReturnTo("/api/chat?q=1"); got != "/api/chat?q=1" {
		t.Fatalf("safe return path = %q", got)
	}
}

func TestProxyPoolEvictionClosesMatchingTunnelTarget(t *testing.T) {
	dialer := &lifecycleDialer{closed: make(chan tatproxy.Target, 1)}
	pool := newProxyPool(dialer, 1, time.Hour, time.Second, nil)
	defer pool.close()
	first := tatproxy.Target{BotID: "bot-1", DelegatedSession: "delegated-1"}
	entry, release, err := pool.acquire(first)
	if err != nil || entry == nil {
		t.Fatalf("acquire first: entry=%v err=%v", entry, err)
	}
	release()
	second := tatproxy.Target{BotID: "bot-2", DelegatedSession: "delegated-2"}
	if _, releaseSecond, err := pool.acquire(second); err != nil {
		t.Fatalf("acquire second: %v", err)
	} else {
		releaseSecond()
	}
	select {
	case got := <-dialer.closed:
		if got != first {
			t.Fatalf("closed target=%+v want=%+v", got, first)
		}
	case <-time.After(time.Second):
		t.Fatal("eviction did not close the matching tunnel target")
	}
}

func onlyCookie(t *testing.T, cookies []*http.Cookie, name string) *http.Cookie {
	t.Helper()
	for _, cookie := range cookies {
		if cookie.Name == name {
			return cookie
		}
	}
	t.Fatalf("cookie %q not found in %v", name, cookies)
	return nil
}

func queryValue(t *testing.T, raw, key string) string {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Query().Get(key) == "" {
		t.Fatalf("query %q missing from %q", key, raw)
	}
	return parsed.Query().Get(key)
}
