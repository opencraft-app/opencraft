package e2e

import "testing"

func TestTransparentTrafficGoldenCaseManifestCoversCoreProxyBehaviors(t *testing.T) {
	cases := transparentTrafficGoldenCases()
	required := map[string]bool{
		"openai_non_stream_chat": false,
		"openai_stream_chat":     false,
		"upstream_error_shape":   false,
		"large_request_body":     false,
		"byok_first_private_key": false,
		"platform_first_key":     false,
		"split_traffic_process":  false,
	}
	for _, item := range cases {
		if _, ok := required[item.Name]; ok {
			required[item.Name] = true
		}
	}
	for name, seen := range required {
		if !seen {
			t.Fatalf("transparent traffic golden case %q is not declared; cases=%+v", name, cases)
		}
	}
}
