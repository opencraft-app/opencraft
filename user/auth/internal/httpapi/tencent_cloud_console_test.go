package httpapi

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestBuildTencentCloudConsoleLoginURLUsesCancellationPageByDefault(t *testing.T) {
	t.Parallel()

	rawURL, err := buildTencentCloudConsoleLoginURL("bjsbx.auth-code", "")
	if err != nil {
		t.Fatalf("build login URL: %v", err)
	}

	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse login URL: %v", err)
	}
	if got, want := parsed.Scheme, "https"; got != want {
		t.Fatalf("expected scheme %q, got %q", want, got)
	}
	if got, want := parsed.Host, "cloud.tencent.com"; got != want {
		t.Fatalf("expected host %q, got %q", want, got)
	}
	if got, want := parsed.Path, "/login/saas/jumpLoginByCode"; got != want {
		t.Fatalf("expected path %q, got %q", want, got)
	}
	if got, want := parsed.Query().Get("code"), "bjsbx.auth-code"; got != want {
		t.Fatalf("expected code %q, got %q", want, got)
	}
	if got, want := parsed.Query().Get("platform"), "Lightclaw"; got != want {
		t.Fatalf("expected platform %q, got %q", want, got)
	}
	if got, want := parsed.Query().Get("s_url"), "https://console.cloud.tencent.com/developer/security/cancel"; got != want {
		t.Fatalf("expected target URL %q, got %q", want, got)
	}
}

func TestBuildTencentCloudConsoleLoginURLAcceptsConsoleRelativePath(t *testing.T) {
	t.Parallel()

	rawURL, err := buildTencentCloudConsoleLoginURL("shprod.auth-code", "/cvm/instance/index?rid=1")
	if err != nil {
		t.Fatalf("build login URL: %v", err)
	}

	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse login URL: %v", err)
	}
	if got, want := parsed.Query().Get("s_url"), "https://console.cloud.tencent.com/cvm/instance/index?rid=1"; got != want {
		t.Fatalf("expected target URL %q, got %q", want, got)
	}
}

func TestBuildTencentCloudConsoleLoginURLRejectsUnsafeTarget(t *testing.T) {
	t.Parallel()

	for _, target := range []string{
		"https://evil.example/phish",
		"//evil.example/phish",
		"/\\evil.example/phish",
		"developer/security/cancel",
		"/developer/security/cancel#fragment",
	} {
		target := target
		t.Run(target, func(t *testing.T) {
			t.Parallel()
			if _, err := buildTencentCloudConsoleLoginURL("auth-code", target); err == nil {
				t.Fatalf("expected target %q to be rejected", target)
			}
		})
	}
}

func TestCreateTencentCloudRedirectIssuesCodeForCurrentUser(t *testing.T) {
	t.Parallel()

	router, svc, shadowSvc := newShadowBindingHTTPTestRouter()
	sessionCookie, userID := completePhone3FAHTTPFlow(t, router, svc)

	recorder := performJSONRequest(t, router, http.MethodPost, "/auth/tencent-cloud/redirect", nil, sessionCookie)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if got, want := recorder.Header().Get("Cache-Control"), "no-store"; got != want {
		t.Fatalf("expected Cache-Control %q, got %q", want, got)
	}

	var response struct {
		RedirectURL string `json:"redirectUrl"`
		ExpiresAt   string `json:"expiresAt"`
	}
	decodeJSONResponse(t, recorder, &response)
	if response.ExpiresAt == "" {
		t.Fatal("expected auth code expiry")
	}
	parsed, err := url.Parse(response.RedirectURL)
	if err != nil {
		t.Fatalf("parse redirect URL: %v", err)
	}
	code := parsed.Query().Get("code")
	if code == "" {
		t.Fatal("expected redirect URL to contain auth code")
	}
	consumed, err := shadowSvc.ConsumeAuthCode(context.Background(), code)
	if err != nil {
		t.Fatalf("consume issued auth code: %v", err)
	}
	if got, want := consumed.UserID, userID; got != want {
		t.Fatalf("expected auth code for current user %q, got %q", want, got)
	}
	if got, want := parsed.Query().Get("s_url"), "https://console.cloud.tencent.com/developer/security/cancel"; got != want {
		t.Fatalf("expected default target %q, got %q", want, got)
	}
}

func TestCreateTencentCloudRedirectRejectsUnsafeTarget(t *testing.T) {
	t.Parallel()

	router, svc, _ := newShadowBindingHTTPTestRouter()
	sessionCookie, _ := completePhone3FAHTTPFlow(t, router, svc)

	recorder := performJSONRequest(t, router, http.MethodPost, "/auth/tencent-cloud/redirect", map[string]any{
		"targetPath": "https://evil.example/phish",
	}, sessionCookie)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"code":"invalid_tencent_cloud_target_path"`) {
		t.Fatalf("expected stable invalid target error code, got %s", recorder.Body.String())
	}
}
