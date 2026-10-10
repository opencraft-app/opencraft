package runtime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// The receipt is control-plane state, not metadata supplied by an invocation.
func executionIdentityStore(t *testing.T, client *minisandboxClient, site, release string) (string, deploymentReceipt) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), site, release)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	bundle := fixture()
	data, err := json.Marshal(bundle)
	if err != nil {
		t.Fatal(err)
	}
	for name, contents := range map[string][]byte{"bundle.json": data, "app.mjs": []byte(bundle.Code)} {
		if err := os.WriteFile(filepath.Join(dir, name), contents, 0600); err != nil {
			t.Fatal(err)
		}
	}
	identity, err := client.DeploymentIdentity(site)
	if err != nil {
		t.Fatal(err)
	}
	compiled, err := buildMinisandboxPackage(map[string]Bundle{release: bundle})
	if err != nil {
		t.Fatal(err)
	}
	receipt := deploymentReceipt{
		minisandboxReceipt: minisandboxReceipt{PackageID: compiled.PackageID, Version: "v_" + strings.Repeat("a", 64), Digests: []string{bundle.SHA256}},
		Schema:             2, Identity: identity, DeploymentID: "d_" + strings.Repeat("b", 32), Ownership: ActivationOwned,
	}
	writeExecutionIdentityReceipt(t, dir, receipt)
	return dir, receipt
}

func writeExecutionIdentityReceipt(t *testing.T, dir string, receipt deploymentReceipt) {
	t.Helper()
	data, err := json.Marshal(receipt)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(dir), ".minisandbox.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestMinisandboxExecutionIdentityRejectsNativeFixtureWithoutReplay(t *testing.T) {
	const packageHeader = "X-Lightvela-Execution-Package-ID"
	const digestHeader = "X-Lightvela-Execution-Backend-SHA256"
	for _, mode := range []string{"correct", "application-error", "wrapper-error", "native-fixture", "wrong-package", "wrong-digest", "missing-package", "missing-digest", "duplicate-package", "duplicate-digest", "native-error"} {
		t.Run(mode, func(t *testing.T) {
			puts, requests, controls := 0, 0, 0
			var receipt deploymentReceipt
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("X-Workers-Original-URL") == "https://website.invalid/__platform_prepare" {
					controls++
					_ = json.NewEncoder(w).Encode(map[string]string{"package_id": receipt.PackageID})
					return
				}
				if r.Method == http.MethodPut && !strings.HasSuffix(r.URL.Path, "/fetch") {
					puts++
					w.Write([]byte(`{}`))
					return
				}
				requests++
				if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/fetch") || r.Header.Get("X-Workers-Original-URL") != "https://website.invalid/api/todos" {
					t.Errorf("unexpected application request: %s %s", r.Method, r.URL.Path)
				}
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set(packageHeader, receipt.PackageID)
				w.Header().Set(digestHeader, fixture().SHA256)
				switch mode {
				case "native-fixture", "native-error":
					w.Header().Del(packageHeader)
					w.Header().Del(digestHeader)
				case "wrong-package":
					w.Header().Set(packageHeader, strings.Repeat("c", 64))
				case "wrong-digest":
					w.Header().Set(digestHeader, strings.Repeat("d", 64))
				case "missing-package":
					w.Header().Del(packageHeader)
				case "missing-digest":
					w.Header().Del(digestHeader)
				case "duplicate-package":
					w.Header().Add(packageHeader, receipt.PackageID)
				case "duplicate-digest":
					w.Header().Add(digestHeader, fixture().SHA256)
				}
				switch mode {
				case "application-error":
					w.WriteHeader(http.StatusBadRequest)
				case "wrapper-error":
					w.WriteHeader(http.StatusInternalServerError)
				case "native-error":
					w.WriteHeader(http.StatusServiceUnavailable)
				}
				if mode == "native-fixture" {
					w.Write([]byte(`{"actorId":"native-fixture","generation":1,"count":0,"bottomlessChunks":0,"bottomlessBytes":0}`))
				} else {
					w.Write([]byte(`{"todos":[]}`))
				}
			}))
			defer server.Close()
			client, err := newMinisandboxClient(server.URL, "cn-test", server.Client())
			if err != nil {
				t.Fatal(err)
			}
			dir, stored := executionIdentityStore(t, client, "ws-owner", "wr-one")
			receipt = stored
			if mode == "native-fixture" {
				// Reproduce the real failure: this same object's private control
				// probe was correct, but its next application response was native.
				object, _ := client.objectPath("ws-owner")
				if err := client.verifyPrivatePackage(context.Background(), object+"/fetch", receipt.PackageID); err != nil {
					t.Fatal(err)
				}
			}
			result, err := client.Run(context.Background(), dir, Invocation{SHA256: fixture().SHA256, Method: "POST", Path: "/api/todos", Body: []byte(`{"title":"once"}`)})
			if mode == "correct" || mode == "application-error" || mode == "wrapper-error" {
				wantStatus := http.StatusOK
				if mode == "application-error" {
					wantStatus = http.StatusBadRequest
				} else if mode == "wrapper-error" {
					wantStatus = http.StatusInternalServerError
				}
				if err != nil || result.Status != wantStatus || string(result.Body) != `{"todos":[]}` || len(result.Headers) != 1 {
					t.Fatalf("valid wrapper response rejected/leaked identity: result=%+v error=%v", result, err)
				}
			} else if err == nil || result.Status != 0 || len(result.Body) != 0 || len(result.Headers) != 0 {
				t.Fatalf("untrusted execution returned an application result: result=%+v error=%v", result, err)
			}
			wantControls := 0
			if mode == "native-fixture" {
				wantControls = 1
			}
			if controls != wantControls {
				t.Fatalf("execution mismatch must not trigger control probes: %d", controls)
			}
			if puts != 1 || requests != 1 {
				t.Fatalf("application must never be replayed: puts=%d requests=%d", puts, requests)
			}
		})
	}
}

func TestMinisandboxExecutionIdentityRequiresLocalSchema2BindingBeforeRequest(t *testing.T) {
	for _, mode := range []string{"missing-receipt", "legacy-receipt", "unknown-schema", "foreign-site", "foreign-endpoint", "unretained-digest", "request-digest", "tampered-code"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.Write([]byte(`{}`))
			}))
			defer server.Close()
			client, _ := newMinisandboxClient(server.URL, "cn-test", server.Client())
			dir, receipt := executionIdentityStore(t, client, "ws-owner", "wr-one")
			in := Invocation{SHA256: fixture().SHA256, Method: "POST", Path: "/api/todos"}
			switch mode {
			case "legacy-receipt":
				receipt.Schema, receipt.Identity, receipt.DeploymentID, receipt.Ownership = 0, "", "", ""
			case "unknown-schema":
				receipt.Schema = 3
			case "foreign-site":
				receipt.Identity, _ = client.DeploymentIdentity("ws-other")
			case "foreign-endpoint":
				foreign, _ := newMinisandboxClient("http://foreign.invalid", "cn-test", server.Client())
				receipt.Identity, _ = foreign.DeploymentIdentity("ws-owner")
			case "unretained-digest":
				receipt.Digests = []string{strings.Repeat("c", 64)}
			case "request-digest":
				in.SHA256 = strings.Repeat("c", 64)
			case "tampered-code":
				if err := os.WriteFile(filepath.Join(dir, "app.mjs"), []byte("changed"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			writeExecutionIdentityReceipt(t, dir, receipt)
			if mode == "missing-receipt" {
				if err := os.Remove(filepath.Join(filepath.Dir(dir), ".minisandbox.json")); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := client.Run(context.Background(), dir, in); err == nil {
				t.Fatal("unbound local execution identity accepted")
			}
			if calls != 0 {
				t.Fatalf("invalid local binding reached native: %d calls", calls)
			}
		})
	}
}

func TestMinisandboxExecutionIdentityNeverReplaysLostApplicationResponse(t *testing.T) {
	for _, method := range []string{"GET", "HEAD", "POST"} {
		t.Run(method, func(t *testing.T) {
			var requests atomic.Int64
			var receipt deploymentReceipt
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPut && !strings.HasSuffix(r.URL.Path, "/fetch") {
					w.WriteHeader(http.StatusNoContent)
					return
				}
				if requests.Add(1) == 1 {
					// SQL may have committed before this reused connection loses
					// its response. Even a GET/HEAD handler must not be replayed.
					conn, _, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					conn.Close()
					return
				}
				w.Header().Set(minisandboxExecutionPackageHeader, receipt.PackageID)
				w.Header().Set(minisandboxExecutionDigestHeader, fixture().SHA256)
				w.Write([]byte(`{"todos":[]}`))
			}))
			defer server.Close()
			client, _ := newMinisandboxClient(server.URL, "cn-test", server.Client())
			dir, stored := executionIdentityStore(t, client, "ws-owner", "wr-one")
			receipt = stored
			result, err := client.Run(context.Background(), dir, Invocation{SHA256: fixture().SHA256, Method: method, Path: "/api/todos"})
			if err == nil || result.Status != 0 || requests.Load() != 1 {
				t.Fatalf("lost application response was replayed/accepted: requests=%d result=%+v error=%v", requests.Load(), result, err)
			}
		})
	}
}
