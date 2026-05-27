package runtime

import "testing"

func TestValidateWispFetchURLRejectsUnsafeTargets(t *testing.T) {
	cases := []string{
		"file:///etc/passwd",
		"http://127.0.0.1/file",
		"http://10.0.0.1/file",
		"http://169.254.169.254/latest/meta-data",
		"http://[::1]/file",
		"https://user:pass@example.com/file",
	}
	for _, raw := range cases {
		t.Run(raw, func(t *testing.T) {
			if err := validateWispFetchURL(raw, false); err == nil {
				t.Fatalf("validateWispFetchURL(%q) succeeded, want error", raw)
			}
		})
	}
}

func TestValidateWispFetchURLAllowsHTTPSHost(t *testing.T) {
	if err := validateWispFetchURL("https://example.com/artifact", false); err != nil {
		t.Fatalf("validateWispFetchURL() error = %v", err)
	}
}

func TestValidateWispFetchIPAllowsPrivateWhenExplicit(t *testing.T) {
	if err := validateWispFetchURL("http://10.0.0.1/artifact", true); err != nil {
		t.Fatalf("validateWispFetchURL() with allowPrivate error = %v", err)
	}
	if err := validateWispFetchURL("http://127.0.0.1/artifact", true); err == nil {
		t.Fatal("validateWispFetchURL() allowed loopback with allowPrivate")
	}
}
