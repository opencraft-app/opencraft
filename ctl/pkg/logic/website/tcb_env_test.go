package website

import "testing"

func TestTCBEnvAllowlistFiltersDiscoveredBuckets(t *testing.T) {
	envs := []TCBEnvConfig{
		{EnvID: "lightvela-prod-a", AppID: "10001"},
		{EnvID: "lightvela-prod-b", AppID: "10002"},
		{EnvID: "unrelated-static-site", AppID: "10003"},
	}

	filtered := filterTCBEnvsByAllowlist(envs, parseTCBEnvAllowlist("lightvela-prod-b, lightvela-prod-a"))
	if len(filtered) != 2 {
		t.Fatalf("filtered env count = %d, want 2", len(filtered))
	}
	if filtered[0].EnvID != "lightvela-prod-a" || filtered[1].EnvID != "lightvela-prod-b" {
		t.Fatalf("filtered envs = %#v, want only explicitly approved environments", filtered)
	}
}

func TestTCBEnvAllowlistFailsClosedWhenUnset(t *testing.T) {
	envs := []TCBEnvConfig{{EnvID: "unrelated-static-site", AppID: "10003"}}
	filtered := filterTCBEnvsByAllowlist(envs, parseTCBEnvAllowlist(""))
	if len(filtered) != 0 {
		t.Fatalf("empty allowlist returned %#v, want no environments", filtered)
	}
}
