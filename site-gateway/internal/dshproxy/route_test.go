package dshproxy

import "testing"

func TestBotRouteIDContract(t *testing.T) {
	if got := botRouteID(" bot-1 "); got != "d6c011e86b148bbd" {
		t.Fatalf("route ID = %q", got)
	}
	if got := botRouteID(""); got != "" {
		t.Fatalf("empty route ID = %q", got)
	}
}

func TestRouteMatcherBindsHostToBot(t *testing.T) {
	matcher := newRouteMatcher(testDSHDomains)
	for _, host := range []string{
		testBotHost,
		"D6C011E86B148BBD-DSH.LIGHTVELA.SITE.",
		"d6c011e86b148bbd-dsh.lightvela.tech:443",
	} {
		if !matcher.matches(host, "bot-1") {
			t.Fatalf("expected host %q to match bot", host)
		}
	}
	for _, host := range []string{
		"d6c011e86b148bbd-dsh.lightvela.site.attacker.example",
		"f4600b2ce700c557-dsh.lightvela.site",
		"d6c011e86b148bbd.dsh.lightvela.site",
	} {
		if matcher.matches(host, "bot-1") {
			t.Fatalf("unexpected host %q match", host)
		}
	}
}
