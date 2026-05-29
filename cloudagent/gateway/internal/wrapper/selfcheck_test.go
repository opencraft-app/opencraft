package wrapper

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSelfCheckRequiresIdentity(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{})
	resp := request(t, srv, http.MethodGet, "/v1/selfcheck", "", "", nil, "")

	if resp.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	assertErrorCode(t, resp.Body.Bytes(), "identity_missing")
}

func TestReadyzAllowsUnauthenticatedProbe(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{})
	resp := request(t, srv, http.MethodGet, "/readyz", "", "", nil, "")

	if resp.Code != http.StatusOK {
		t.Fatalf("readyz status=%d body=%s", resp.Code, resp.Body.String())
	}
	if got := resp.Body.String(); got != "ok\n" {
		t.Fatalf("readyz body=%q", got)
	}
}

func TestReadyzAgentSidecarRequiresWispConfig(t *testing.T) {
	agsClient := &AGSClient{
		apiKey:         "ags-key",
		apiURL:         "https://api.ap-shanghai.tencentags.com",
		domain:         "ap-shanghai.tencentags.com",
		httpClient:     http.DefaultClient,
		requestTimeout: time.Second,
	}
	worker, err := NewAgentSidecarWorker(AgentSidecarWorkerConfig{
		Client:           agsClient,
		OuterTemplateID:  "outer-template",
		InnerTemplateID:  "inner-template",
		SidecarURL:       "https://example.invalid/sidecar",
		SidecarSHA256:    strings.Repeat("a", 64),
		TokenHubAPIKey:   "tokenhub-key",
		OuterRuntime:     outerRuntimeWisp,
		WispPackageURL:   "https://example.invalid/wisp.tgz",
		WispSMHLibraryID: "smh-library",
	})
	if err != nil {
		t.Fatal(err)
	}
	srv, _ := newTestServer(t, worker)

	resp := request(t, srv, http.MethodGet, "/readyz", "", "", nil, "")

	if resp.Code != http.StatusServiceUnavailable {
		t.Fatalf("readyz status=%d body=%s", resp.Code, resp.Body.String())
	}
	body := resp.Body.String()
	for _, want := range []string{
		"GATEWAY_WISP_SMH_ACCESS_DOMAIN is not configured",
		"GATEWAY_WISP_SMH_LIBRARY_SECRET is not configured",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("readyz body missing %q: %s", want, body)
		}
	}
}

func TestSelfCheckFakeWorkerPasses(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{})
	resp := request(t, srv, http.MethodGet, "/v1/selfcheck", "tenant-a", "project-a", nil, "")

	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var out selfCheckResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !out.OK || out.Object != "cloudagent.selfcheck" || out.Summary.WorkerKind != "fake" {
		t.Fatalf("unexpected selfcheck response=%+v", out)
	}
}

func TestSelfCheckAgentSidecarReportsArtifactReachability(t *testing.T) {
	artifactServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/sidecar":
			w.WriteHeader(http.StatusForbidden)
		case "/sidecar.sig", "/wisp.tgz":
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer artifactServer.Close()
	agsClient := &AGSClient{
		apiKey:         "ags-key",
		apiURL:         "https://api.ap-shanghai.tencentags.com",
		domain:         "ap-shanghai.tencentags.com",
		httpClient:     artifactServer.Client(),
		requestTimeout: time.Second,
	}
	worker, err := NewAgentSidecarWorker(AgentSidecarWorkerConfig{
		Client:               agsClient,
		OuterTemplateID:      "outer-template",
		InnerTemplateID:      "inner-template",
		SidecarURL:           artifactServer.URL + "/sidecar",
		SidecarSHA256:        strings.Repeat("a", 64),
		TokenHubAPIKey:       "tokenhub-key",
		OuterRuntime:         outerRuntimeWisp,
		WispPackageURL:       artifactServer.URL + "/wisp.tgz",
		WispSMHLibraryID:     "smh-library",
		WispSMHAccessDomain:  "https://smh.example.com",
		WispSMHLibrarySecret: "smh-secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	srv, _ := newTestServer(t, worker)

	resp := request(t, srv, http.MethodGet, "/v1/selfcheck", "tenant-a", "project-a", nil, "")
	if resp.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var out selfCheckResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.OK || out.Status != "failed" || out.Summary.OuterRuntime != outerRuntimeWisp {
		t.Fatalf("unexpected selfcheck response=%+v", out)
	}
	assertSelfCheckItem(t, out.Checks, "agent.sidecar_url_reachable", "fail", http.StatusForbidden)
	assertSelfCheckItem(t, out.Checks, "agent.sidecar_sig_url_reachable", "pass", http.StatusOK)
	assertSelfCheckItem(t, out.Checks, "wisp.package_url_reachable", "pass", http.StatusOK)
}

func assertSelfCheckItem(t *testing.T, checks []selfCheckItem, name, status string, httpStatus int) {
	t.Helper()
	for _, check := range checks {
		if check.Name == name {
			if check.Status != status || check.HTTPStatus != httpStatus {
				t.Fatalf("check %s=%+v, want status=%s http=%d", name, check, status, httpStatus)
			}
			return
		}
	}
	t.Fatalf("missing selfcheck item %s in %+v", name, checks)
}
