package runtime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMinisandboxPackageRetainsOldCodeAndStableSiteIdentity(t *testing.T) {
	old := fixture()
	next := old
	next.Code = "export default {fetch(){return Response.json({version:2})}}"
	next.SHA256 = sha256HexForTest(next.Code)
	packageOne, err := buildMinisandboxPackage(map[string]Bundle{"release-old": old})
	if err != nil {
		t.Fatal(err)
	}
	packageTwo, err := buildMinisandboxPackage(map[string]Bundle{"release-old": old, "release-next": next})
	if err != nil {
		t.Fatal(err)
	}
	if packageTwo.Modules["backend-"+old.SHA256+".js"] != old.Code {
		t.Fatal("candidate dropped old backend")
	}
	if packageTwo.Modules["backend-"+next.SHA256+".js"] != next.Code {
		t.Fatal("candidate missing new backend")
	}
	if !strings.Contains(packageOne.Modules["main.js"], old.SHA256) || !strings.Contains(packageTwo.Modules["main.js"], old.SHA256) {
		t.Fatal("missing trusted digest dispatch")
	}
	if packageTwo.DurableObjects["SITE"] != "VelaSite" {
		t.Fatal("not using persistent DO")
	}
	cn, err := minisandboxIdentity("cn-shprod", "ws-owner")
	if err != nil {
		t.Fatal(err)
	}
	intl, _ := minisandboxIdentity("intl-sgprod", "ws-owner")
	foreign, _ := minisandboxIdentity("cn-shprod", "ws-foreign")
	if cn == intl || cn == foreign {
		t.Fatal("site/environment isolation collapsed")
	}
}

func TestMinisandboxPackageRejectsTamperedDigestAndEmptySet(t *testing.T) {
	if _, err := buildMinisandboxPackage(nil); err == nil {
		t.Fatal("empty package accepted")
	}
	b := fixture()
	b.SHA256 = strings.Repeat("0", 64)
	if _, err := buildMinisandboxPackage(map[string]Bundle{"release-one": b}); err == nil {
		t.Fatal("unverified code accepted")
	}
}

func TestMinisandboxDeployUsesRegistryCASAndDoesNotInvokeApp(t *testing.T) {
	calls := []string{}
	packageID := ""
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/versions"):
			var p minisandboxPackage
			if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
				t.Error(err)
			}
			if p.MainModule != "main.js" || p.DurableObjects["SITE"] != "VelaSite" {
				t.Error("invalid module contract")
			}
			expected, _ := buildMinisandboxPackage(map[string]Bundle{"release-one": fixture()})
			packageID = expected.PackageID
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "v_" + strings.Repeat("a", 64)})
		case r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/deployment"):
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "d_" + strings.Repeat("b", 32), "versions": []map[string]any{{"version_id": "v_" + strings.Repeat("e", 64), "percentage": 100}}})
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/deployments"):
			var p map[string]any
			_ = json.NewDecoder(r.Body).Decode(&p)
			if p["expected_deployment_id"] != "d_"+strings.Repeat("b", 32) {
				t.Error("missing deployment CAS")
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "d_" + strings.Repeat("c", 32)})
		case r.Method == "GET" && (strings.HasSuffix(r.URL.Path, "/dispatch") || strings.HasSuffix(r.URL.Path, "/fetch")):
			if r.Header.Get("X-Workers-Original-URL") != "https://website.invalid/__platform_prepare" {
				t.Error("unexpected user fetch")
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"package_id": packageID})
		default:
			t.Errorf("unexpected upstream mutation/invocation: %s", r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	defer upstream.Close()
	client, err := newMinisandboxClient(upstream.URL, "cn-test", upstream.Client())
	if err != nil {
		t.Fatal(err)
	}
	if err := client.prepare(context.Background(), "ws-owner", map[string]Bundle{"release-one": fixture()}); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 5 {
		t.Fatalf("prepare calls: %v", calls)
	}
}

func sha256HexForTest(code string) string { return sha256Hex([]byte(code)) }

func TestMinisandboxInvocationUsesStableDOAndStripsSecrets(t *testing.T) {
	var receipt deploymentReceipt
	var target string
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if target == "" {
			target = r.URL.Path
		}
		if r.Method == "PUT" {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{}`))
			return
		}
		if r.URL.Path != target+"/fetch" {
			t.Errorf("changed identity: %s", r.URL.Path)
		}
		if r.Header.Get("X-Workers-Original-URL") != "https://website.invalid/api/todos" || r.Header.Get("X-Lightvela-Backend-Digest") != fixture().SHA256 || r.Header.Get("X-Lightvela-Storage-Read-Only") != "1" {
			t.Error("missing trusted invocation metadata")
		}
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Fatal("platform credential leak")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Set-Cookie", "secret=1")
		w.Header().Set(minisandboxExecutionPackageHeader, receipt.PackageID)
		w.Header().Set(minisandboxExecutionDigestHeader, fixture().SHA256)
		w.Write([]byte(`{"todos":[]}`))
	}))
	defer server.Close()
	client, _ := newMinisandboxClient(server.URL, "cn-test", server.Client())
	for _, release := range []string{"wr-old", "wr-next"} {
		dir, stored := executionIdentityStore(t, client, "ws-owner", release)
		receipt = stored
		result, err := client.Run(context.Background(), dir, Invocation{SHA256: fixture().SHA256, Method: "GET", Path: "/api/todos", ReadOnly: true})
		if err != nil || result.Status != 200 || len(result.Headers) != 1 {
			t.Fatalf("result=%+v error=%v", result, err)
		}
	}
	if calls != 4 {
		t.Fatalf("calls=%d", calls)
	}
}

func TestMinisandboxReadinessRequiresExactPreparedVersion(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/fetch") || strings.HasSuffix(r.URL.Path, "/dispatch") {
			_ = json.NewEncoder(w).Encode(map[string]string{"package_id": strings.Repeat("f", 64)})
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"d_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","versions":[{"version_id":"v_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","percentage":100}]}`))
	}))
	defer server.Close()
	client, _ := newMinisandboxClient(server.URL, "cn-test", server.Client())
	if client.Verify(context.Background(), "ws-owner", "v_"+strings.Repeat("a", 64), strings.Repeat("f", 64)) != nil {
		t.Fatal("valid receipt rejected")
	}
	if client.Verify(context.Background(), "ws-owner", "v_"+strings.Repeat("c", 64), strings.Repeat("f", 64)) == nil {
		t.Fatal("foreign active version accepted")
	}
}

func TestMinisandboxRejectsRedirectAndOversizeRetainedCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "https://attacker.invalid", 302) }))
	defer server.Close()
	client, _ := newMinisandboxClient(server.URL, "cn-test", server.Client())
	if client.prepare(context.Background(), "ws-owner", map[string]Bundle{"wr-one": fixture()}) == nil {
		t.Fatal("redirect accepted")
	}
	large := Bundle{Code: strings.Repeat("a", MaxCodeBytes), SHA256: sha256HexForTest(strings.Repeat("a", MaxCodeBytes))}
	other := Bundle{Code: strings.Repeat("b", MaxCodeBytes), SHA256: sha256HexForTest(strings.Repeat("b", MaxCodeBytes))}
	if _, err := buildMinisandboxPackage(map[string]Bundle{"wr-one": large, "wr-two": other}); err == nil {
		t.Fatal("aggregate code quota ignored")
	}
}

func TestMinisandboxDeleteUsesTerminalObjectFence(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != "DELETE" || !strings.Contains(r.URL.Path, "/objects/VelaSite/") {
			t.Error("unsafe worker delete")
		}
		w.WriteHeader(204)
	}))
	defer server.Close()
	client, _ := newMinisandboxClient(server.URL, "cn-test", server.Client())
	if err := client.DeleteSite(context.Background(), "ws-owner"); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal("extra destructive cleanup")
	}
}

func TestMinisandboxFailedLinkRestoresPreviousDeploymentWithCAS(t *testing.T) {
	for _, mode := range []string{"invalid-package", "request-cancelled", "rollback-conflict", "stale-durable-object"} {
		t.Run(mode, func(t *testing.T) {
			oldVersion, oldID := "v_"+strings.Repeat("a", 64), "d_"+strings.Repeat("b", 32)
			newVersion, newID := "v_"+strings.Repeat("c", 64), "d_"+strings.Repeat("d", 32)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			posts, restored := 0, false
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch {
				case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/versions"):
					_ = json.NewEncoder(w).Encode(map[string]string{"id": newVersion})
				case r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/deployment"):
					_ = json.NewEncoder(w).Encode(map[string]any{"id": oldID, "versions": []map[string]any{{"version_id": oldVersion, "percentage": 100}}})
				case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/deployments"):
					posts++
					var p struct {
						VersionID string `json:"version_id"`
						Versions  []struct {
							VersionID  string  `json:"version_id"`
							Percentage float64 `json:"percentage"`
						} `json:"versions"`
						ExpectedID string `json:"expected_deployment_id"`
					}
					_ = json.NewDecoder(r.Body).Decode(&p)
					if posts == 1 {
						if p.VersionID != newVersion || p.ExpectedID != oldID {
							t.Errorf("bad candidate CAS: %+v", p)
						}
						w.WriteHeader(http.StatusCreated)
						_ = json.NewEncoder(w).Encode(map[string]string{"id": newID})
					} else {
						if p.ExpectedID != newID || len(p.Versions) != 1 || p.Versions[0].VersionID != oldVersion || p.Versions[0].Percentage != 100 {
							t.Errorf("unsafe compensation CAS: %+v", p)
						}
						if mode == "rollback-conflict" {
							w.WriteHeader(http.StatusConflict)
							return
						}
						restored = true
						_ = json.NewEncoder(w).Encode(map[string]any{"id": "d_" + strings.Repeat("e", 32), "versions": []map[string]any{{"version_id": oldVersion, "percentage": 100}}})
					}
				case r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/dispatch"):
					if mode == "request-cancelled" {
						cancel()
						return
					}
					packageID := "stale-package"
					if mode == "stale-durable-object" {
						p, _ := buildMinisandboxPackage(map[string]Bundle{"wr-one": fixture()})
						packageID = p.PackageID
					}
					_ = json.NewEncoder(w).Encode(map[string]string{"package_id": packageID})
				case r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/fetch"):
					_ = json.NewEncoder(w).Encode(map[string]string{"package_id": "stale-package"})
				default:
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
					w.WriteHeader(500)
				}
			}))
			defer upstream.Close()
			client, _ := newMinisandboxClient(upstream.URL, "cn-test", upstream.Client())
			_, err := client.Prepare(ctx, "ws-owner", map[string]Bundle{"wr-one": fixture()})
			if err == nil {
				t.Fatal("failed package accepted")
			}
			if posts != 2 {
				t.Fatalf("failed preparation left candidate active: %d deployment mutations", posts)
			}
			if mode == "rollback-conflict" {
				if restored || !strings.Contains(err.Error(), "rollback") {
					t.Fatalf("compensation conflict not distinguished: %v", err)
				}
			} else if !restored {
				t.Fatal("previous release was not restored")
			}
		})
	}
}

func TestMinisandboxUsesNativeWorkerLoaderCompatibleModuleNames(t *testing.T) {
	p, err := buildMinisandboxPackage(map[string]Bundle{"wr-one": fixture()})
	if err != nil {
		t.Fatal(err)
	}
	if p.MainModule != "main.js" {
		t.Fatalf("native WorkerLoader string module rejects main name %q", p.MainModule)
	}
	for name := range p.Modules {
		if !strings.HasSuffix(name, ".js") {
			t.Fatalf("native WorkerLoader string module rejects %q", name)
		}
	}
}
