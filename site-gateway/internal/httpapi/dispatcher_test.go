package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDispatcherRoutesPrefixedDSHHosts(t *testing.T) {
	site := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("site")) })
	dsh := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("dsh")) })
	handler := NewDispatcher(site, dsh, []string{"dsh.lightvela.site", "dsh.lightvela.tech"})

	for _, tc := range []struct {
		host string
		want string
	}{
		{host: "bot-1-dsh.lightvela.site", want: "dsh"},
		{host: "bot-1-dsh.lightvela.tech:443", want: "dsh"},
		{host: "BOT-1-DSH.LIGHTVELA.SITE.", want: "dsh"},
		{host: "Bot-1-dsh.lightvela.site", want: "dsh"},
		{host: "dsh.lightvela.site", want: "site"},
		{host: "-bot-dsh.lightvela.site", want: "site"},
		{host: "bot_-dsh.lightvela.site", want: "site"},
		{host: "bot--dsh.lightvela.site", want: "site"},
		{host: "nested.bot-1-dsh.lightvela.site", want: "site"},
		{host: "bot-1.dsh.lightvela.site", want: "site"},
		{host: "notdsh.lightvela.site", want: "site"},
		{host: "dsh.lightvela.site.attacker.example", want: "site"},
		{host: "pages.lightvela.site", want: "site"},
	} {
		t.Run(tc.host, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "http://example.test/", nil)
			req.Host = tc.host
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if got := rec.Body.String(); got != tc.want {
				t.Fatalf("body = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestDispatcherEmptyDomainsPreservesSiteHandler(t *testing.T) {
	site := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("site")) })
	dsh := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("dsh")) })
	req := httptest.NewRequest(http.MethodGet, "http://bot.dsh.lightvela.site/", nil)
	rec := httptest.NewRecorder()
	NewDispatcher(site, dsh, nil).ServeHTTP(rec, req)
	if got := rec.Body.String(); got != "site" {
		t.Fatalf("body = %q, want site", got)
	}
}
