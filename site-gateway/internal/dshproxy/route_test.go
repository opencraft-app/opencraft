package dshproxy

import (
	"strings"
	"testing"
)

func TestBotRouteIDContract(t *testing.T) {
	if got := botRouteID(" bot-1 "); got != "bot-1" {
		t.Fatalf("route ID = %q", got)
	}
	for _, botID := range []string{"", "Bot-1", "-bot-1", "bot-1-", "bot_1", strings.Repeat("a", 60)} {
		if got := botRouteID(botID); got != "" {
			t.Fatalf("invalid Bot ID %q produced route ID %q", botID, got)
		}
	}
}

func TestRouteMatcherBindsHostToBot(t *testing.T) {
	matcher := newRouteMatcher(testDSHDomains)
	for _, host := range []string{
		testBotHost,
		"BOT-1-DSH.LIGHTVELA.SITE.",
		"bot-1-dsh.lightvela.tech:443",
	} {
		if !matcher.matches(host, "bot-1") {
			t.Fatalf("expected host %q to match bot", host)
		}
	}
	for _, host := range []string{
		"bot-1-dsh.lightvela.site.attacker.example",
		"bot-2-dsh.lightvela.site",
		"bot-1.dsh.lightvela.site",
	} {
		if matcher.matches(host, "bot-1") {
			t.Fatalf("unexpected host %q match", host)
		}
	}
}

func TestRouteMatcherDerivesBotOnlyFromConfiguredHost(t *testing.T) {
	matcher := newRouteMatcher(testDSHDomains)
	for _, host := range []string{testBotHost, "BOT-1-DSH.LIGHTVELA.SITE.", "bot-1-dsh.lightvela.tech:443"} {
		if got, ok := matcher.botID(host); !ok || got != "bot-1" {
			t.Fatalf("botID(%q) = %q, %v", host, got, ok)
		}
	}
	for _, host := range []string{"dsh.lightvela.site", "bot-1-dsh.lightvela.site.attacker.example", "bot_1-dsh.lightvela.site"} {
		if got, ok := matcher.botID(host); ok || got != "" {
			t.Fatalf("botID(%q) = %q, %v", host, got, ok)
		}
	}
}
